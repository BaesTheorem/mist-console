"""remote.py: reaching the Console from off this Mac (the iPhone app in ios/,
or any browser on the LAN).

The server has always bound loopback only, with no auth: a request that reached
it came from this machine, full stop. Remote access keeps that rule and adds one
more identity, "holds the pairing token". Everything is decided per request in
app.py's before_request hook through is_local() and authorized().

INVARIANTS
- A loopback request carrying no proxy headers is trusted exactly as before
  this module existed. The desktop window, mist-progress, notification replies
  and every script inside a chat depend on that, and none of them can send a
  token.
- Every other request needs remote access switched ON and the pairing token
  (the mist_remote cookie or a Bearer header). Off means every non-local
  request is refused, whatever it carries. Only /remote/ping and /remote/login
  are reachable without the token, and the login is rate-limited per address.
- The Cloudflare tunnel's origin is the LAN address, never 127.0.0.1, so a
  request that came in through the tunnel can never look local (and cloudflared
  stamps proxy headers on it besides, which is_local() also rejects).
- The token never leaves this machine except inside the pairing QR / link and
  the phone's Keychain. The discovery document published to Workers KV holds
  URLs only.

Off-LAN reachability, in order of sturdiness:
1. A URL Alex configures himself (remote_url): a Tailscale MagicDNS name, a
   named tunnel, anything that resolves to this server.
2. A cloudflared "quick tunnel" the Console keeps alive (tunnel=true): a
   random *.trycloudflare.com https URL that changes every time the process
   restarts. The current one is published to the share Worker's KV under the
   discovery id, so the phone can look it up when nothing else answers.
"""
import base64
import hashlib
import logging
import hmac
import ipaddress
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import threading
import time

from bridge import DATA_DIR

CONFIG_PATH = os.path.join(DATA_DIR, "remote.json")
# The port this server answers on. A test instance sets MIST_CONSOLE_PORT so
# its tunnel points at itself and not at the live Console.
PORT = int(os.environ.get("MIST_CONSOLE_PORT") or 5014)
COOKIE = "mist_remote"
COOKIE_MAX_AGE = 365 * 86400
# Reachable without the token. Ping says "a MIST Console lives here"; login
# turns the token into the cookie. Nothing else.
PUBLIC_PATHS = {"/remote/ping", "/remote/login"}
# Any of these on a loopback request means a proxy forwarded it: not local.
_PROXY_HEADERS = ("X-Forwarded-For", "Cf-Connecting-Ip", "Cf-Ray", "X-Real-Ip", "Forwarded")
_TUNNEL_URL = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
_log = logging.getLogger("mist.remote")
# Outcome of the last discovery publish, for the settings section.
_discovery_state = {"ok": None, "why": "", "at": None}

_lock = threading.Lock()
_cfg = None


# ---- config --------------------------------------------------------------

def _load():
    global _cfg
    with _lock:
        if _cfg is None:
            try:
                with open(CONFIG_PATH) as f:
                    _cfg = json.load(f) or {}
            except Exception:
                _cfg = {}
            _cfg.setdefault("enabled", False)
            _cfg.setdefault("tunnel", False)
            _cfg.setdefault("remote_url", "")
            dirty = False
            if not _cfg.get("token"):
                _cfg["token"] = secrets.token_urlsafe(32)
                _cfg["created"] = time.time()
                dirty = True
            if not _cfg.get("discovery_id"):
                _cfg["discovery_id"] = secrets.token_urlsafe(16)
                dirty = True
            if dirty:
                _write(_cfg)
        return _cfg


def _write(cfg):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = f"{CONFIG_PATH}.tmp.{os.getpid()}"
    with open(tmp, "w") as f:
        json.dump(cfg, f, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, CONFIG_PATH)


def _save():
    with _lock:
        _write(_cfg)


def enabled():
    return bool(_load().get("enabled"))


def token():
    return _load()["token"]


def discovery_key():
    return "remote-" + _load()["discovery_id"]


# ---- per-request identity ----------------------------------------------------

def is_local(req):
    """True for a request from this machine that no proxy forwarded."""
    addr = (req.remote_addr or "").split("%")[0]
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return False
    if not ip.is_loopback:
        return False
    return not any(h in req.headers for h in _PROXY_HEADERS)


def cookie_value(tok=None):
    """What the cookie carries: an HMAC of the token, so the raw token never
    sits in a cookie jar. Rotating the token invalidates every cookie."""
    return hmac.new((tok or token()).encode(), b"mist-console remote cookie",
                    hashlib.sha256).hexdigest()


def authorized(req):
    tok = token()
    c = req.cookies.get(COOKIE)
    if c and hmac.compare_digest(c, cookie_value(tok)):
        return True
    auth = req.headers.get("Authorization", "")
    if auth.startswith("Bearer ") and hmac.compare_digest(auth[7:].strip(), tok):
        return True
    return False


def check_token(candidate):
    return bool(candidate) and hmac.compare_digest(str(candidate), token())


# A 256-bit token cannot be guessed, but a login endpoint on a public tunnel
# should still not answer a flood. Eight misses per address per ten minutes.
_fails = {}
FAIL_LIMIT, FAIL_WINDOW = 8, 600


def login_allowed(ip):
    now = time.time()
    with _lock:
        hits = [t for t in _fails.get(ip, []) if now - t < FAIL_WINDOW]
        _fails[ip] = hits
        return len(hits) < FAIL_LIMIT


def login_failed(ip):
    with _lock:
        _fails.setdefault(ip, []).append(time.time())


def login_ok(ip):
    with _lock:
        _fails.pop(ip, None)


# ---- where this Mac answers ------------------------------------------------

_net_cache = {"at": 0, "ips": [], "host": ""}


def _run(cmd, timeout=3):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout.strip()
    except Exception:
        return ""


def _refresh_net():
    if time.time() - _net_cache["at"] < 30:
        return
    ips = []
    for iface in ("en0", "en1", "en2"):
        ip = _run(["ipconfig", "getifaddr", iface])
        if ip and ip not in ips:
            ips.append(ip)
    if not ips:
        # Not macOS, or no ipconfig: ask the kernel which source address it
        # would use for an outbound packet. Nothing is sent.
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("10.255.255.255", 1))
            ips.append(s.getsockname()[0])
            s.close()
        except Exception:
            pass
    host = _run(["scutil", "--get", "LocalHostName"]) or socket.gethostname().split(".")[0]
    _net_cache.update(at=time.time(), ips=ips, host=(host + ".local") if host else "")


def lan_ips():
    _refresh_net()
    return list(_net_cache["ips"])


def local_hostname():
    _refresh_net()
    return _net_cache["host"]


def lan_urls():
    out = [f"http://{ip}:{PORT}" for ip in lan_ips()]
    h = local_hostname()
    if h:
        out.append(f"http://{h}:{PORT}")
    return out


def offlan_urls():
    cfg = _load()
    out = []
    if cfg.get("remote_url"):
        out.append(cfg["remote_url"].rstrip("/"))
    if tunnel.url:
        out.append(tunnel.url)
    return out


def urls():
    """Candidate base URLs for a client, LAN first (fastest when it works)."""
    return lan_urls() + offlan_urls()


# ---- cloudflared quick tunnel ------------------------------------------------

class _Tunnel:
    """One cloudflared quick tunnel, supervised. `url` is the live public URL
    or None. The origin is the LAN address on purpose (see module docstring)."""

    def __init__(self):
        self.proc = None
        self.url = None
        self.error = None
        self.origin = None
        self.started_at = None
        self._backoff = 10
        self._lock = threading.Lock()

    @staticmethod
    def binary():
        found = shutil.which("cloudflared")
        if found:
            return found
        for p in ("/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"):
            if os.path.exists(p):
                return p
        return None

    def running(self):
        return self.proc is not None and self.proc.poll() is None

    def start(self):
        with self._lock:
            if self.running():
                return
            binary = self.binary()
            if not binary:
                self.error = "cloudflared is not installed (brew install cloudflared)"
                return
            ips = lan_ips()
            if not ips:
                self.error = "no LAN address to tunnel to (is the Mac online?)"
                return
            self.origin = f"http://{ips[0]}:{PORT}"
            try:
                self.proc = subprocess.Popen(
                    [binary, "tunnel", "--url", self.origin, "--no-autoupdate"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
            except Exception as e:
                self.error = f"couldn't start cloudflared: {e}"
                self.proc = None
                return
            self.url = None
            self.error = None
            self.started_at = time.time()
            threading.Thread(target=self._read, args=(self.proc,), daemon=True).start()

    def _read(self, proc):
        try:
            for line in proc.stderr:
                m = _TUNNEL_URL.search(line)
                if m and m.group(0) != self.url:
                    self.url = m.group(0)
                    self.error = None
                    self._backoff = 10
                    threading.Thread(target=publish_discovery, daemon=True).start()
        except Exception:
            pass
        code = proc.wait()
        if proc is self.proc:
            self.url = None
            if code not in (0, -15, -9):
                self.error = f"cloudflared exited with code {code}"

    def stop(self):
        with self._lock:
            p, self.proc = self.proc, None
            self.url = None
            self.error = None
        if p and p.poll() is None:
            try:
                p.terminate()
                p.wait(timeout=5)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass

    def status(self):
        return {"running": self.running(), "url": self.url, "error": self.error,
                "origin": self.origin, "since": self.started_at,
                "installed": bool(self.binary())}


tunnel = _Tunnel()


def _supervise():
    """Keep the tunnel matching the config: up while wanted, restarted after a
    crash (with backoff), re-pointed if the LAN address moved, down when not."""
    while True:
        try:
            cfg = _load()
            want = bool(cfg.get("enabled") and cfg.get("tunnel"))
            if want:
                ips = lan_ips()
                origin = f"http://{ips[0]}:{PORT}" if ips else None
                if tunnel.running() and origin and tunnel.origin != origin:
                    tunnel.stop()
                if not tunnel.running():
                    tunnel.start()
                    if not tunnel.running():
                        tunnel._backoff = min(tunnel._backoff * 2, 120)
                        time.sleep(tunnel._backoff)
                        continue
            elif tunnel.running():
                tunnel.stop()
        except Exception:
            pass
        time.sleep(5)


_supervisor_started = False


def init():
    global _supervisor_started
    if _supervisor_started:
        return
    _supervisor_started = True
    threading.Thread(target=_supervise, daemon=True, name="remote-tunnel").start()


# ---- discovery (off-LAN URL lookup through the share Worker) -----------------

def discovery_url():
    """Where the phone reads the current off-LAN URLs when nothing answers:
    the share Worker serving KV, same GET-only surface the share links use."""
    try:
        import share
        base = (share._load_cloud_config() or {}).get("base_url")
    except Exception:
        base = None
    return f"{base}/s/{discovery_key()}" if base else None


def publish_discovery():
    """Write the off-LAN URLs to Workers KV under the discovery id. URLs only;
    the token is never published. Best effort: no credentials, no cloud."""
    try:
        import share
        account, tok = share._creds()
        if not (account and tok):
            _discovery_state.update(ok=False, why="no Cloudflare credentials in the harness .env", at=time.time())
            return {"ok": False, "why": "no Cloudflare credentials in the harness .env"}
        base_url, kv_id = share._ensure_cloud()
        doc = json.dumps({"v": 1, "urls": offlan_urls() if enabled() else [],
                          "updated": int(time.time())})
        share._req("PUT", f"/accounts/{account}/storage/kv/namespaces/{kv_id}/values/{discovery_key()}",
                   tok, doc.encode(), ctype="text/plain", raw=True)
        _discovery_state.update(ok=True, why="", at=time.time())
        return {"ok": True, "url": f"{base_url}/s/{discovery_key()}"}
    except Exception as e:
        _log.warning("discovery publish failed: %s", e)
        _discovery_state.update(ok=False, why=str(e), at=time.time())
        return {"ok": False, "why": str(e)}


# ---- pairing + status + updates ----------------------------------------------

def pairing():
    """The QR / link payload the phone consumes: mist://pair?d=<base64url json>."""
    cfg = _load()
    doc = {"v": 1, "name": "MIST Console", "urls": urls(), "token": cfg["token"],
           "discovery": discovery_url()}
    raw = json.dumps(doc, separators=(",", ":")).encode()
    return "mist://pair?d=" + base64.urlsafe_b64encode(raw).decode().rstrip("=")


def status():
    cfg = _load()
    return {
        "enabled": bool(cfg.get("enabled")),
        "tunnel": bool(cfg.get("tunnel")),
        "tunnel_state": tunnel.status(),
        "remote_url": cfg.get("remote_url") or "",
        "lan_urls": lan_urls(),
        "urls": urls(),
        "pairing": pairing() if cfg.get("enabled") else None,
        "discovery": discovery_url(),
        "discovery_state": dict(_discovery_state),
        "token_created": cfg.get("created"),
        "port": PORT,
    }


def update(enabled_=None, tunnel_=None, remote_url=None):
    cfg = _load()
    with _lock:
        if enabled_ is not None:
            cfg["enabled"] = bool(enabled_)
        if tunnel_ is not None:
            cfg["tunnel"] = bool(tunnel_)
        if remote_url is not None:
            remote_url = str(remote_url).strip()
            if remote_url and not re.match(r"^https?://[^\s/]+", remote_url):
                remote_url = "https://" + remote_url.lstrip("/")
            cfg["remote_url"] = remote_url.rstrip("/")
    _save()
    if not (cfg["enabled"] and cfg["tunnel"]):
        tunnel.stop()
    threading.Thread(target=publish_discovery, daemon=True).start()
    return status()


def rotate():
    """New token, new discovery id: every paired phone and every cookie is out."""
    cfg = _load()
    with _lock:
        cfg["token"] = secrets.token_urlsafe(32)
        cfg["created"] = time.time()
        cfg["discovery_id"] = secrets.token_urlsafe(16)
        _fails.clear()
    _save()
    threading.Thread(target=publish_discovery, daemon=True).start()
    return status()


# The page a LAN browser gets at / without the cookie. Same flat/sharp look as
# the Console, no assets (the static files sit behind the guard too).
LOGIN_HTML = """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>MIST Console</title>
<style>
html,body{margin:0;height:100%;background:#091420;color:#d9e3f4;font:15px/1.5 ui-monospace,Menlo,monospace}
main{max-width:360px;margin:18vh auto 0;padding:0 20px}
h1{font-size:14px;letter-spacing:3px;color:#38dbdb;font-weight:700;margin:0 0 14px}
p{margin:0 0 14px;color:#8fa1b8;font-size:13px}
p.err{color:#ffb4ab}
input{width:100%;box-sizing:border-box;background:#050b12;color:#d9e3f4;border:1px solid #3b4a5c;padding:11px 12px;font:inherit;font-size:16px;outline:none}
input:focus{border-color:#38dbdb}
button{margin-top:10px;width:100%;background:#38dbdb;color:#091420;border:1px solid #38dbdb;padding:11px;font:inherit;font-weight:700;cursor:pointer}
</style></head><body><main>
<h1>M I S T</h1>
<p>This Console is paired by token. Paste it from the phone section of MIST's settings on the Mac.</p>
<!--msg-->
<form method="post" action="/remote/login">
<input type="password" name="token" placeholder="pairing token" autocomplete="current-password" autofocus>
<input type="hidden" name="next" value="/">
<button type="submit">open the Console</button>
</form>
</main></body></html>
"""
