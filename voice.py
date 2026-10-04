"""voice.py — the server half of conversation mode.

The page captures the microphone and finds the end of each utterance itself
(static/voice.js, Silero VAD in the web view). This module does the two
things a browser cannot do locally:

  transcribe(wav)      speech to text with whisper.cpp. A resident
                       `whisper-server` answers in well under a second; until
                       it is up (or when it is missing) each call runs
                       `whisper-cli`, which pays the model load every time.
  tts(text, which)     text to speech as a WAV file. "live" is the macOS
                       system voice (`say`), used when the web view's own
                       speechSynthesis has no voices. "mist" is MIST's cloned
                       XTTS voice from the harness voice service, slower than
                       real time. "chatterbox" is the same cloned voice from
                       Chatterbox Turbo on MLX, close to real time. Both
                       cloned engines start on request and warm in the
                       background.

INVARIANTS (do not break these in an edit):
  - Nothing here plays sound. Audio goes back to the page as bytes and the
    page plays it, so the "no sound Alex did not ask for" rule stays a
    front-end decision tied to the conversation-mode switch.
  - The whisper model is a local file under models/ (gitignored, 0.5 to
    1.6 GB). A missing model is a status the UI shows with the fetch command,
    never an automatic download inside a request.
  - The vocabulary prompt is a comma-separated list of terms, never a
    sentence. A prompt that reads like the opening of an utterance ("Hi
    MIST.") made whisper skip the real opening as already decoded.
  - Child processes are detached (their own session) so a server restart
    does not take them down and they do not hold the server's pipes.
"""
import json
import logging
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
import uuid

log = logging.getLogger("mist.voice")

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.path.join(HERE, "models")

# Best model present wins. large-v3-turbo (1.6 GB, ~1.8 s per utterance on
# the Air) hears names and short phrases that small.en (0.5 GB, ~0.5 s)
# turns into other words; MIST_WHISPER_MODEL pins one explicitly.
MODEL_PREFERENCE = ("ggml-large-v3-turbo.bin", "ggml-small.en.bin")


def _pick_model():
    pinned = os.environ.get("MIST_WHISPER_MODEL")
    if pinned:
        return pinned
    for name in MODEL_PREFERENCE:
        c = os.path.join(MODELS_DIR, name)
        if os.path.exists(c):
            return c
    return os.path.join(MODELS_DIR, MODEL_PREFERENCE[-1])


MODEL = _pick_model()

# Words whisper has not met: MIST's own name and the systems Alex talks to
# her about. "Hi MIST" came back as "I missed" without this. The private
# half (people's names) lives in models/stt-vocab.txt, one term per line,
# gitignored with the models. Short list on purpose: with 12 terms turbo
# heard "Plaud", with 16 or more it heard "plug" again, so each term past
# the cap weakens every other one and is dropped (first terms win).
DEFAULT_VOCAB = ("MIST", "Plaud Note", "Plaud", "Supernote", "Loki", "Obsidian",
                 "Things 3")
VOCAB_FILE = os.path.join(MODELS_DIR, "stt-vocab.txt")
VOCAB_CAP = 12


def vocab_prompt():
    """The initial prompt for every transcription: a term list, see INVARIANTS."""
    terms = list(DEFAULT_VOCAB)
    try:
        with open(VOCAB_FILE, encoding="utf-8") as f:
            for line in f:
                t = line.strip()
                if t and not t.startswith("#") and t not in terms:
                    terms.append(t)
    except OSError:
        pass
    if len(terms) > VOCAB_CAP:
        log.warning("stt vocabulary has %d terms; only the first %d are used", len(terms), VOCAB_CAP)
    return ", ".join(terms[:VOCAB_CAP]) + "."


def _which(name):
    """PATH first, then the Homebrew and /usr/local bins: the .app is launched
    by launchd with a bare PATH, so shutil.which alone misses brew binaries."""
    p = shutil.which(name)
    if p:
        return p
    for d in ("/opt/homebrew/bin", "/usr/local/bin"):
        c = os.path.join(d, name)
        if os.access(c, os.X_OK):
            return c
    return None


WHISPER_CLI = _which("whisper-cli")
WHISPER_SERVER = _which("whisper-server")
STT_PORT = int(os.environ.get("MIST_STT_PORT", "8089"))
STT_URL = f"http://127.0.0.1:{STT_PORT}/inference"
THREADS = "4"

SAY = "/usr/bin/say"
SAY_VOICE = os.environ.get("MIST_SAY_VOICE", "Samantha")

# MIST's own voice: the harness voice service (mist-voice/scripts/serve.py).
HARNESS = os.environ.get("MIST_HARNESS", "/Users/alexhedtke/Documents/Exobrain harness")
MIST_TTS_URL = os.environ.get("MIST_TTS_URL", "http://127.0.0.1:8087")
MIST_SERVE_PY = os.path.join(HARNESS, "mist-voice", "scripts", "serve.py")
MIST_PY = os.path.join(HARNESS, "mist-voice", ".venv", "bin", "python")
MIST_CHATTERBOX_URL = os.environ.get("MIST_CHATTERBOX_URL", "http://127.0.0.1:8088")

# The cloned engines: name -> (service URL, start command, log file). Each one
# is a resident service with GET /health and POST /say -> WAV.
ENGINES = {
    "mist": (MIST_TTS_URL, [MIST_PY, MIST_SERVE_PY, "--device", "cpu"],
             "mist-console-mist-voice.log"),
    "chatterbox": (MIST_CHATTERBOX_URL,
                   [os.path.join(HARNESS, "mist-voice", ".venv-chatterbox", "bin", "python"),
                    os.path.join(HARNESS, "mist-voice", "scripts", "serve_chatterbox.py")],
                   "mist-console-chatterbox.log"),
}

LOG_DIR = os.path.expanduser("~/Library/Logs/exobrain")

# The hint that rides on every spoken turn. The page shows only what was said;
# the model gets the context it needs to answer for the ear, not the eye.
VOICE_HINT = (
    "[Conversation mode: Alex said this out loud and will hear your reply read "
    "aloud, sentence by sentence, as it streams. Answer the way you would in "
    "speech: short sentences, plain words, no headings, tables, bullet lists or "
    "code unless he asks for them. Keep the opening kaomoji; it is not spoken. "
    "Do not render audio files yourself; the Console speaks the text.]"
)

_lock = threading.Lock()
_stt_proc = None
_stt_started_at = 0.0
_stt_checked = False
_engine_procs = {}       # engine name -> Popen of a start we issued
_engine_started_at = {}  # engine name -> time of that start


def _port_open(port, timeout=0.3):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except OSError:
        return False


def _detach(cmd, logname):
    os.makedirs(LOG_DIR, exist_ok=True)
    out = open(os.path.join(LOG_DIR, logname), "ab")
    return subprocess.Popen(cmd, stdout=out, stderr=subprocess.STDOUT,
                            stdin=subprocess.DEVNULL, start_new_session=True)


# ---------------------------------------------------------------- status ----

def engine_state(name):
    """"up" when the engine's service answers, "warming" while a start we
    issued is still loading, else "down"."""
    url = ENGINES[name][0]
    if _port_open(int(url.rsplit(":", 1)[-1])):
        try:
            with urllib.request.urlopen(url + "/health", timeout=1) as r:
                if json.loads(r.read() or b"{}").get("ok"):
                    return "up"
        except Exception:  # noqa: BLE001 -- any failure reads as not up yet
            pass
    proc = _engine_procs.get(name)
    if proc is not None and proc.poll() is None:
        return "warming"
    return "down"


def engine_available(name):
    return all(os.path.exists(p) for p in ENGINES[name][1][:2])


def status():
    return {
        "model": os.path.exists(MODEL),
        "model_path": MODEL,
        "model_name": os.path.basename(MODEL),
        "vocab_file": os.path.exists(VOCAB_FILE),
        "whisper": bool(WHISPER_CLI or WHISPER_SERVER),
        "stt_server": _port_open(STT_PORT),
        "say": os.path.exists(SAY),
        "say_voice": SAY_VOICE,
        "mist_voice": engine_state("mist"),
        "mist_available": engine_available("mist"),
        "chatterbox_voice": engine_state("chatterbox"),
        "chatterbox_available": engine_available("chatterbox"),
    }


# ------------------------------------------------------------ transcribe ----

def _stop_stale_stt_server():
    """A whisper-server left on the port by an earlier run serves whatever
    model it was started with. When that is not MODEL (a bigger one landed
    in models/, or the env var changed), stop it so the start below picks
    the right one. Checked once per process."""
    global _stt_checked
    if _stt_checked:
        return False
    _stt_checked = True
    try:
        pids = subprocess.run(["lsof", "-ti", f"tcp:{STT_PORT}", "-sTCP:LISTEN"],
                              capture_output=True, text=True, timeout=5, check=False).stdout.split()
        for pid in pids:
            args = subprocess.run(["ps", "-o", "args=", "-p", pid],
                                  capture_output=True, text=True, timeout=5, check=False).stdout
            if "whisper-server" in args and MODEL not in args:
                log.info("whisper-server %s runs another model; stopping it", pid)
                os.kill(int(pid), 15)
                return True
    except (OSError, subprocess.SubprocessError) as e:
        log.warning("stale whisper-server check failed: %s", e)
    return False


def ensure_stt_server():
    """Start the resident whisper-server once; callers fall back to the CLI
    until it answers. Returns True when the server is listening now."""
    global _stt_proc, _stt_started_at
    if _port_open(STT_PORT) and not _stop_stale_stt_server():
        return True
    if not (WHISPER_SERVER and os.path.exists(MODEL)):
        return False
    with _lock:
        alive = _stt_proc is not None and _stt_proc.poll() is None
        if not alive and time.time() - _stt_started_at > 20:
            _stt_started_at = time.time()
            _stt_proc = _detach([WHISPER_SERVER, "-m", MODEL, "--host", "127.0.0.1",
                                 "--port", str(STT_PORT), "-t", THREADS, "-nt", "-l", "en"],
                                "mist-console-stt.log")
            log.info("whisper-server started (pid %s)", _stt_proc.pid)
    return False


def _multipart(fields, files):
    """Build a multipart/form-data body. fields: {name: str}; files:
    {name: (filename, bytes, content_type)}. Returns (body, content_type)."""
    boundary = "----mist" + uuid.uuid4().hex
    parts = []
    for k, v in fields.items():
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode())
    for k, (fn, data, ct) in files.items():
        parts.append((f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"; "
                      f"filename=\"{fn}\"\r\nContent-Type: {ct}\r\n\r\n").encode() + data + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


_NON_SPEECH = ("[BLANK_AUDIO]", "[blank_audio]", "(silence)", "[silence]", "[inaudible]",
               "[ Silence ]", "(blank)", "[Music]", "[music]", "(music)", "[MUSIC]")


def clean_transcript(text):
    """whisper's own markers for non-speech are not words Alex said."""
    t = (text or "").strip()
    for m in _NON_SPEECH:
        t = t.replace(m, " ")
    t = " ".join(t.split())
    return t


def _transcribe_server(wav):
    body, ct = _multipart({"temperature": "0.0", "response_format": "json",
                           "language": "en", "prompt": vocab_prompt()},
                          {"file": ("speech.wav", wav, "audio/wav")})
    req = urllib.request.Request(STT_URL, data=body, method="POST",
                                 headers={"Content-Type": ct})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or b"{}").get("text", "")


def _transcribe_cli(wav):
    cli = WHISPER_CLI or "whisper-cli"
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(wav)
        path = f.name
    try:
        r = subprocess.run([cli, "-m", MODEL, "-f", path, "-nt", "-np", "-t", THREADS,
                            "-l", "en", "--prompt", vocab_prompt()],
                           capture_output=True, text=True, timeout=60)
        return r.stdout
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def transcribe(wav):
    """WAV bytes (16 kHz mono, PCM16 or float32) -> text. Raises RuntimeError
    with a message the UI can show when nothing can transcribe."""
    if not os.path.exists(MODEL):
        raise RuntimeError("whisper model missing: run bin/fetch-whisper-model")
    if ensure_stt_server():
        try:
            return clean_transcript(_transcribe_server(wav))
        except Exception as e:  # noqa: BLE001 -- the CLI below is the fallback
            log.warning("whisper-server failed (%s); using whisper-cli", e)
    if not WHISPER_CLI:
        raise RuntimeError("whisper-cli not installed: brew install whisper-cpp")
    return clean_transcript(_transcribe_cli(wav))


# ------------------------------------------------------------------- tts ----

def tts_live(text):
    """The macOS system voice as 22.05 kHz PCM16 WAV bytes."""
    if not os.path.exists(SAY):
        raise RuntimeError("no system voice (/usr/bin/say missing)")
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        path = f.name
    try:
        subprocess.run([SAY, "-v", SAY_VOICE, "--data-format=LEI16@22050", "-o", path, text],
                       check=True, timeout=60, capture_output=True)
        with open(path, "rb") as f:
            return f.read()
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def engine_start(name):
    """Start a cloned engine's service detached if it is not up. Returns the
    state after the call ("up" / "warming" / "down")."""
    st = engine_state(name)
    if st != "down":
        return st
    if not engine_available(name):
        return "down"
    with _lock:
        if time.time() - _engine_started_at.get(name, 0.0) > 30:
            _engine_started_at[name] = time.time()
            _engine_procs[name] = _detach(ENGINES[name][1], ENGINES[name][2])
            log.info("%s voice service started (pid %s)", name, _engine_procs[name].pid)
    return "warming"


def tts_engine(name, text):
    """A cloned engine's voice as PCM16 WAV bytes. Raises RuntimeError("warming")
    or ("down") when the service cannot answer yet."""
    st = engine_state(name)
    if st != "up":
        raise RuntimeError(st)
    req = urllib.request.Request(ENGINES[name][0] + "/say", method="POST",
                                 data=json.dumps({"text": text}).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return r.read()


def tts(text, which="live"):
    return tts_engine(which, text) if which in ENGINES else tts_live(text)
