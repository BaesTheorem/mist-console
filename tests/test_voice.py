"""voice.py: the parts that run without a microphone or a model."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import voice  # noqa: E402


def test_clean_transcript_drops_non_speech_markers():
    assert voice.clean_transcript(" [BLANK_AUDIO] ") == ""
    assert voice.clean_transcript("Hello there. (silence)") == "Hello there."
    assert voice.clean_transcript("  two   spaces ") == "two spaces"


def test_multipart_body_carries_file_and_fields():
    body, ct = voice._multipart({"response_format": "json"}, {"file": ("a.wav", b"RIFF\x00", "audio/wav")})
    boundary = ct.split("boundary=")[1]
    assert body.startswith(("--" + boundary).encode())
    assert b'name="file"; filename="a.wav"' in body
    assert b"RIFF\x00" in body
    assert body.rstrip().endswith(("--" + boundary + "--").encode())


def test_status_reports_model_presence(tmp_path, monkeypatch):
    monkeypatch.setattr(voice, "MODEL", str(tmp_path / "none.bin"))
    s = voice.status()
    assert s["model"] is False
    assert set(s) >= {"whisper", "say", "mist_voice", "stt_server"}


def test_transcribe_without_model_explains(tmp_path, monkeypatch):
    monkeypatch.setattr(voice, "MODEL", str(tmp_path / "none.bin"))
    try:
        voice.transcribe(b"RIFF" * 50)
    except RuntimeError as e:
        assert "fetch-whisper-model" in str(e)
    else:
        raise AssertionError("expected RuntimeError")


def test_voice_hint_is_one_bracketed_line():
    assert voice.VOICE_HINT.startswith("[") and voice.VOICE_HINT.endswith("]")
    assert "\n" not in voice.VOICE_HINT
