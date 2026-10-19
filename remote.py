"""remote.py: reaching the Console from off this Mac (the iPhone app in ios/,
or any browser on the LAN).

The server has always bound loopback only, with no auth: a request that reached
it came from this machine, full stop. Remote access keeps that rule and adds one
more identity, "holds the pairing token". Everything is decided per request in
app.py's before_request hook through is_local() and authorized().

INVARIANTS
- A loopback request carrying no proxy headers, and naming a loopback host
  (127.0.0.1, localhost, [::1]) in Host, is trusted exactly as before this
  module existed. The desktop window, mist-progress, notification replies and
  every script inside a chat depend on that, and none of them can send a
  token. Any other Host from loopback is the DNS rebinding shape and is
  refused (foreign_host) unless it is an address this Console is known by.
- A raw TCP forwarder into the main port inherits that trust; forwarders must
  target ORIGIN_PORT (README, "Forwarders must target ORIGIN_PORT").
- Every other request needs remote access switched ON and the pairing token
  (the mist_remote cookie or a Bearer header). Off means every non-local
  request is refused, whatever it carries. Only /remote/ping and /remote/login
  are reachable without the token, and the login is rate-limited per address.
- The Cloudflare tunnel's origin is a second, loopback-only listener on
  ORIGIN_PORT (app.py starts it), and is_local() refuses anything that arrived
  on that port whatever its source address. So a tunneled request can never
  look local, the tunnel is untouched by a VPN's LAN rules (loopback traffic
  stays on the host) and by network hops (the origin address never changes,
  so the public URL survives them). cloudflared's proxy headers are a second
  tell that is_local() also rejects.
- The token never leaves this machine except inside the pairing QR / link and
  the phone's Keychain. The discovery document published to Workers KV holds
  URLs only.

Off-LAN reachability, in order of sturdiness:
1. A URL Alex configures himself (remote_url): a Tailscale MagicDNS name, a
   named tunnel, anything that resolves to this server.
2. A cloudflared "quick tunnel" the Console keeps alive (tunnel=true): a
   random *.trycloudflare.com https URL that changes every time the process
   restarts.

The Mac's whole current address list (LAN, hotspot, tunnel, configured) is
published to the share Worker's KV under the discovery id whenever it changes,
so the phone can look it up when nothing it remembers answers. The hotspot case
is why the LAN addresses are in there: tethered to the phone, the Mac takes a
fresh 172.20.10.x address that nothing else would ever tell the phone about,
and with it the two talk directly over the tether instead of out through
Cloudflare and back.
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
# Loopback-only listener the tunnel points at; requests arriving on it are
# never local (see is_local). app.py binds it.
ORIGIN_PORT = PORT + 1000
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
            _cfg.setdefault("keep_awake", False)
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

# Host names a loopback caller may use and still be trusted. A web page whose
# domain an attacker re-points at 127.0.0.1 (DNS rebinding) reaches this server
# from loopback too, but its browser sends the attacker's name in Host.
_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


def host_of(value):
    """The host part of a Host header, lowercased, port and IPv6 brackets
    removed: '[::1]:5014' -> '::1', 'LocalHost:5014' -> 'localhost'."""
    h = (value or "").strip().lower()
    if h.startswith("["):
        h = h[1:].split("]", 1)[0]
    elif h.count(":") == 1:
        h = h.split(":", 1)[0]
    return h.rstrip(".")


def _from_loopback(req):
    addr = (req.remote_addr or "").split("%")[0]
    try:
        return ipaddress.ip_address(addr).is_loopback
    except ValueError:
        return False


def on_origin_port(req):
    """Arrived on the tunnel's origin listener (cloudflared, or any forwarder
    pointed there as the README says)."""
    return str(req.environ.get("SERVER_PORT") or "") == str(ORIGIN_PORT)


def is_local(req):
    """True for a request from this machine that no proxy forwarded, that did
    not come in on the tunnel's origin port, and that names this machine by a
    loopback name in Host. A request with no Host header at all is not a
    browser (every browser sends one), so it keeps loopback trust."""
    if on_origin_port(req) or not _from_loopback(req):
        return False
    if any(h in req.headers for h in _PROXY_HEADERS):
        return False
    host = req.environ.get("HTTP_HOST")
    return host is None or host_of(host) in _LOOPBACK_HOSTS


def _known_hosts():
    """Every name this Console legitimately answers to besides loopback."""
    known = set(lan_ips())
    h = local_hostname()
    if h:
        known.add(h.lower())
    for u in offlan_urls():
        m = re.match(r"^https?://([^/]+)", u)
        if m:
            known.add(host_of(m.group(1)))
    return known


def foreign_host(req):
    """A loopback request on the main port whose Host is neither a loopback
    name nor an address this Console is known by: the DNS rebinding shape.
    The guard refuses it outright, before the public paths, so a rebound page
    cannot even read /remote/ping. The origin port is exempt (cloudflared sends
    the tunnel's own hostname, and nothing there is trusted anyway)."""
    if on_origin_port(req) or not _from_loopback(req):
        return False
    host = req.environ.get("HTTP_HOST")
    if host is None:
        return False
    name = host_of(host)
    return name not in _LOOPBACK_HOSTS and name not in _known_hosts()


def via_tunnel(req):
    """True when the request came through the Cloudflare tunnel, so the
    address Cloudflare stamps in Cf-Connecting-Ip is the real client. On any
    other port that header is just text a LAN client chose to send."""
    return on_origin_port(req)


def cookie_value(tok=None):
    """What the cookie carries: an HMAC of the token, so the raw token never
    sits in a cookie jar. Rotating the token invalidates every cookie."""
    return hmac.new((tok or token()).encode(), b"mist-console remote cookie",
                    hashlib.sha256).hexdigest()


def _same(a, b):
    # compare_digest on two str raises TypeError when either holds a non-ASCII
    # character, which a client fully controls. Bytes always compare.
    return hmac.compare_digest(str(a).encode(), str(b).encode())


def authorized(req):
    tok = token()
    c = req.cookies.get(COOKIE)
    if c and _same(c, cookie_value(tok)):
        return True
    auth = req.headers.get("Authorization", "")
    if auth.startswith("Bearer ") and _same(auth[7:].strip(), tok):
        return True
    return False


def check_token(candidate):
    return bool(candidate) and _same(candidate, token())


# A 256-bit token cannot be guessed, but a login endpoint on a public tunnel
# should still not answer a flood. Eight misses per address per ten minutes.
# A correct token always gets in (app.py checks it before the limit), so a
# phone that tried a stale token a few times can still re-pair at once.
_fails = {}
FAIL_LIMIT, FAIL_WINDOW = 8, 600


def login_allowed(ip):
    now = time.time()
    with _lock:
        # Prune every address, not only this one, so a flood from many
        # addresses cannot grow the table without bound.
        for key in list(_fails):
            hits = [t for t in _fails[key] if now - t < FAIL_WINDOW]
            if hits:
                _fails[key] = hits
            else:
                del _fails[key]
        return len(_fails.get(ip, ())) < FAIL_LIMIT


def login_failed(ip):
    with _lock:
        _fails.setdefault(ip, []).append(time.time())


def login_ok(ip):
    with _lock:
        _fails.pop(ip, None)


# ---- where this Mac answers ------------------------------------------------

_net_cache = {"at": 0, "ips": [], "host": ""}
_IFCONFIG_IFACE = re.compile(r"^([a-z0-9]+):\s+flags=\d+<([^>]*)>")
_IFCONFIG_INET = re.compile(r"^\s+inet (\d+\.\d+\.\d+\.\d+)")


def _run(cmd, timeout=3):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout.strip()
    except Exception:
        return ""


def _interface_ips():
    """Every IPv4 address on an UP, non-loopback interface, ordered so the
    address the phone is most likely to share comes first: en0 (Wi-Fi, and
    the interface a Wi-Fi hotspot lands on), the other en* (USB tethering
    shows up as a new en*), bridges, then tunnels (a Tailscale utun address
    is useful to a phone on the same tailnet; a VPN's is harmless)."""
    out = _run(["ifconfig"], timeout=5)
    if not out:
        return []
    found = []
    iface, flags = None, ""
    for line in out.splitlines():
        m = _IFCONFIG_IFACE.match(line)
        if m:
            iface, flags = m.group(1), m.group(2)
            continue
        m = _IFCONFIG_INET.match(line)
        if not (m and iface):
            continue
        ip = m.group(1)
        if "UP" not in flags.split(",") or "LOOPBACK" in flags or ip.startswith("169.254."):
            continue
        found.append((iface, ip))

    def rank(item):
        name = item[0]
        if name == "en0":
            return 0
        if name.startswith("en"):
            return 1
        if name.startswith(("bridge", "ap")):
            return 2
        if name.startswith("utun"):
            return 4
        return 3
    seen, ips = set(), []
    for _, ip in sorted(found, key=rank):
        if ip not in seen:
            seen.add(ip)
            ips.append(ip)
    return ips


def _refresh_net():
    if time.time() - _net_cache["at"] < 10:
        return
    ips = _interface_ips()
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
    or None. The origin is the loopback-only ORIGIN_PORT listener on purpose
    (see module docstring).

    A cloudflared that dies soon after it starts (no network, a bad binary, the
    edge refusing it) is not restarted every supervisor tick: each short run
    doubles the wait before the next start, up to BACKOFF_MAX, and a run that
    lasted HEALTHY_RUN seconds resets it."""

    BACKOFF_MIN, BACKOFF_MAX = 10, 600
    HEALTHY_RUN = 30

    def __init__(self):
        self.proc = None
        self.url = None
        self.error = None
        self.origin = None
        self.started_at = None
        self.backoff = self.BACKOFF_MIN
        self.not_before = 0.0       # no start before this time (backoff)
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

    def _defer(self, since):
        """A short run or a failed start: wait longer before the next try."""
        self.backoff = min(self.backoff * 2, self.BACKOFF_MAX)
        self.not_before = since + self.backoff

    def start(self):
        with self._lock:
            if self.running() or time.time() < self.not_before:
                return
            binary = self.binary()
            if not binary:
                self.error = "cloudflared is not installed (brew install cloudflared)"
                self._defer(time.time())
                return
            self.origin = f"http://127.0.0.1:{ORIGIN_PORT}"
            try:
                self.proc = subprocess.Popen(
                    [binary, "tunnel", "--url", self.origin, "--no-autoupdate"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
            except Exception as e:
                self.error = f"couldn't start cloudflared: {e}"
                self.proc = None
                self._defer(time.time())
                return
            self.url = None
            self.error = None
            self.started_at = time.time()
            threading.Thread(target=self._read, args=(self.proc,), daemon=True).start()

    def _read(self, proc):
        try:
            for line in proc.stderr:
                _tunnel_log(line.rstrip())
                m = _TUNNEL_URL.search(line)
                if not m:
                    continue
                with self._lock:
                    # A stopped tunnel's reader can still be draining stderr;
                    # its URL is dead and must not be shown or published.
                    fresh = proc is self.proc and m.group(0) != self.url
                    if fresh:
                        self.url = m.group(0)
                        self.error = None
                if fresh:
                    publish_async()
        except Exception:
            pass
        code = proc.wait()
        with self._lock:
            if proc is not self.proc:
                return       # stopped on purpose; stop() already reset state
            self.url = None
            if code not in (0, -15, -9):
                self.error = f"cloudflared exited with code {code}"
            since = self.started_at or time.time()
            if time.time() - since < self.HEALTHY_RUN:
                self._defer(since)
            else:
                self.backoff = self.BACKOFF_MIN
                self.not_before = 0.0

    def stop(self):
        with self._lock:
            p, self.proc = self.proc, None
            self.url = None
            self.error = None
            # A deliberate stop (switch off, health restart) starts clean.
            self.backoff = self.BACKOFF_MIN
            self.not_before = 0.0
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
                "retry_at": self.not_before or None,
                "last_ok": _health["last_ok"], "restarts": _health["restarts"],
                "installed": bool(self.binary())}


tunnel = _Tunnel()

# cloudflared's stderr, kept so a dead tunnel leaves a trail. It used to go
# nowhere, which is why the 2026-09-27 death has no recorded cause.
TUNNEL_LOG = os.path.expanduser("~/Library/Logs/exobrain/mist-console-tunnel.log")
_TUNNEL_LOG_MAX = 2_000_000


def _tunnel_log(line):
    try:
        if os.path.exists(TUNNEL_LOG) and os.path.getsize(TUNNEL_LOG) > _TUNNEL_LOG_MAX:
            os.replace(TUNNEL_LOG, TUNNEL_LOG + ".1")
        with open(TUNNEL_LOG, "a") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {line}\n")
    except Exception:
        pass


# ---- tunnel health ----------------------------------------------------------
# A live cloudflared process is not a live tunnel. On 2026-09-27 the process
# had been up 2.5 days while its trycloudflare hostname no longer resolved:
# the edge had dropped the quick tunnel and cloudflared never exited, so the
# supervisor (which only checked the pid) kept publishing a dead URL and the
# phone had no off-LAN path. So probe the public URL itself, and restart after
# a few misses, but only when a control request to Cloudflare succeeds (a Mac
# that is offline would fail both, and a restart would not help).
HEALTH_EVERY = 60        # seconds between probes
HEALTH_GRACE = 45        # a fresh URL 530s for a few seconds; leave it alone
HEALTH_MISSES = 3        # consecutive failed probes before a restart
_CONTROL_URL = "https://www.cloudflare.com/cdn-cgi/trace"
_health = {"at": 0, "misses": 0, "last_ok": None, "restarts": 0}


def _probe(url, timeout=10):
    import urllib.request
    from v4first import opener
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "MIST-health/1"})
        with opener.open(req, timeout=timeout) as r:
            return 200 <= r.status < 300
    except Exception:
        return False


def _public_addrs(host):
    """The routable addresses `host` resolves to here, or [] when it does not
    resolve or only resolves to a sinkhole (0.0.0.0, loopback, a private
    range: what DNS filters answer for a blocked name)."""
    try:
        infos = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
    except (OSError, UnicodeError):
        return []
    out = []
    for info in infos:
        try:
            ip = ipaddress.ip_address(str(info[4][0]).split("%")[0])
        except ValueError:
            continue
        if ip.is_global:
            out.append(str(ip))
    return out


def _dns_verdict(url):
    """Why a public URL did not answer, as far as this Mac's DNS can say.
    'filtered': the trycloudflare.com zone itself does not resolve here (a
    DNS filter or a captive resolver), so this Mac cannot judge the tunnel;
    the phone, on another network, may reach it fine. 'gone': the zone
    resolves but this tunnel's hostname does not (the 2026-09-27 shape: the
    edge dropped the quick tunnel). 'resolves': DNS is fine and the URL just
    does not answer."""
    m = re.match(r"^https?://([^/:]+)", url or "")
    host = m.group(1) if m else ""
    if _public_addrs(host):
        return "resolves"
    zone = host.split(".", 1)[1] if "." in host else host
    return "gone" if _public_addrs(zone) else "filtered"


_dns_filtered_logged: dict[str, str | None] = {"url": None}


def _check_tunnel_health():
    url, since = tunnel.url, tunnel.started_at or 0
    now = time.time()
    if not url or now - since < HEALTH_GRACE or now - _health["at"] < HEALTH_EVERY:
        return
    _health["at"] = now
    if _probe(url + "/remote/ping"):
        _health.update(misses=0, last_ok=now)
        return
    if not _probe(_CONTROL_URL):
        return   # we are offline; not the tunnel's fault
    if _dns_verdict(url) == "filtered":
        # Restarting would only mint another name the same filter blocks, and
        # would take a working tunnel away from the phone. Say so once.
        if _dns_filtered_logged["url"] != url:
            _dns_filtered_logged["url"] = url
            _tunnel_log(f"[health] {url}: trycloudflare.com does not resolve on this "
                        "Mac (DNS filter?); cannot check the tunnel, leaving it up")
        _health["misses"] = 0
        return
    _health["misses"] += 1
    _tunnel_log(f"[health] {url} unreachable ({_health['misses']}/{HEALTH_MISSES})")
    if _health["misses"] >= HEALTH_MISSES:
        _health.update(misses=0, restarts=_health["restarts"] + 1)
        _tunnel_log("[health] restarting cloudflared for a fresh URL")
        tunnel.stop()   # the supervisor starts a new one on its next pass


# What the last SUCCESSFUL publish wrote, and when the supervisor last asked
# for one (the rate limit). "urls" is only set after the KV PUT returns.
_published = {"urls": None, "at": 0, "tried": 0}


def _republish_if_moved():
    """The Mac's address list changed (joined the phone's hotspot, DHCP moved
    it, the tunnel came up): publish it so the phone can find the new one.
    Rate-limited; the publish itself is a network call."""
    if not enabled():
        return
    now = urls()
    if now == _published["urls"] or time.time() - _published["tried"] < 15:
        return
    _published["tried"] = time.time()
    publish_async()


def _supervise():
    """Keep the tunnel matching the config: up while wanted, restarted after a
    crash (with backoff), down when not. Also watches the address list and
    republishes it when it moves. The tunnel's origin is loopback, so a
    network hop never restarts it (its public URL survives the hop)."""
    while True:
        try:
            _republish_if_moved()
            cfg = _load()
            _keep_awake(bool(cfg.get("enabled") and cfg.get("keep_awake") and _on_ac_power()))
            want = bool(cfg.get("enabled") and cfg.get("tunnel"))
            if want:
                if not tunnel.running():
                    tunnel.start()    # a no-op until tunnel.not_before (backoff)
                else:
                    _check_tunnel_health()
            elif tunnel.running():
                tunnel.stop()
        except Exception:
            pass
        time.sleep(5)


# ---- optional: no display sleep while remote access is on ----
# Off by default. The 2026-09-22 drop with the display off turned out NOT to
# be the radio (the log shows the association held; the DHCP line was a lease
# renewal), so the display need not stay lit. The switch stays for a network
# that does behave that way. Held only on AC power.
_awake = {"proc": None, "on_ac": None, "checked": 0}


def _on_ac_power():
    if time.time() - _awake["checked"] > 30:
        out = _run(["pmset", "-g", "batt"], timeout=3)
        _awake["on_ac"] = ("AC Power" in out) if out else None
        _awake["checked"] = time.time()
    return _awake["on_ac"]


def _keep_awake(want):
    p = _awake["proc"]
    running = p is not None and p.poll() is None
    if want and not running:
        try:
            _awake["proc"] = subprocess.Popen(
                ["/usr/bin/caffeinate", "-d", "-i"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            _awake["proc"] = None
    elif not want and running and p is not None:
        try:
            p.terminate()
        except Exception:
            pass
        _awake["proc"] = None


def awake_status():
    p = _awake["proc"]
    return {"holding": p is not None and p.poll() is None, "on_ac": _on_ac_power()}


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
        base = (share._load_cloud_config() or {}).get("base_url")  # noqa: SLF001 -- share.py owns the cloud config; no public accessor
    except Exception:
        base = None
    return f"{base}/s/{discovery_key()}" if base else None


# One publish at a time. Two concurrent ones (a URL appearing while the
# supervisor republishes after a hop) raced: each computed urls() at a
# different moment and the slower PUT could land last with a stale list, one
# that had no tunnel URL in it, and nothing would fix KV until the next move.
_publish_serial = threading.Lock()
# publish_async() coalescing: at most one worker thread; a request that comes
# in while it runs makes it go round once more (with fresh urls()).
_pub = {"busy": False, "again": False}
_pub_lock = threading.Lock()


def publish_async():
    """Ask for a discovery publish without blocking the caller."""
    with _pub_lock:
        if _pub["busy"]:
            _pub["again"] = True
            return
        _pub["busy"] = True
    threading.Thread(target=_publish_worker, daemon=True, name="remote-discovery").start()


def _publish_worker():
    while True:
        try:
            publish_discovery()
        except Exception:  # noqa: S110, BLE001 -- publish_discovery records its own failure
            pass
        with _pub_lock:
            if not _pub["again"]:
                _pub["busy"] = False
                return
            _pub["again"] = False


def publish_discovery():
    """Write the current address list to Workers KV under the discovery id.
    URLs only (private addresses and a tunnel hostname are worthless without
    the token); the token is never published. Best effort: no credentials, no
    cloud. An empty list is published when remote access is off. Serialized:
    the list is read inside the lock, so the last PUT always carries the
    newest list, and _published only records a list once KV has it."""
    with _publish_serial:
        try:
            import share
            account, tok = share._creds()  # noqa: SLF001 -- share.py owns the Cloudflare credentials
            if not (account and tok):
                _discovery_state.update(ok=False, why="no Cloudflare credentials in the harness .env", at=time.time())
                return {"ok": False, "why": "no Cloudflare credentials in the harness .env"}
            base_url, kv_id = share._ensure_cloud()  # noqa: SLF001 -- same
            current = urls() if enabled() else []
            doc = json.dumps({"v": 1, "urls": current, "updated": int(time.time())})
            share._req("PUT", f"/accounts/{account}/storage/kv/namespaces/{kv_id}/values/{discovery_key()}",  # noqa: SLF001 -- same
                       tok, doc.encode(), ctype="text/plain", raw=True)
            _published.update(urls=current, at=time.time())
            _discovery_state.update(ok=True, why="", at=time.time())
            return {"ok": True, "url": f"{base_url}/s/{discovery_key()}"}
        except Exception as e:
            _log.warning("discovery publish failed: %s", e)
            _discovery_state.update(ok=False, why=str(e), at=time.time())
            # Forget what we thought was published so the supervisor tries again
            # on its next tick (rate-limited): right after a network hop DNS may
            # not be back yet, and a list that never lands is the one failure the
            # phone cannot recover from on its own.
            _published["urls"] = None
            return {"ok": False, "why": str(e)}


# ---- pairing + status + updates ----------------------------------------------

def pairing():
    """The QR / link payload the phone consumes: mist://pair?d=<base64url json>.
    Kept small so the code stays scannable off a screen: only the addresses a
    phone next to this Mac can use (LAN, plus a configured address). The app
    learns the rest, tunnel and discovery URL included, from /remote/config
    the moment it connects."""
    cfg = _load()
    addrs = lan_urls()
    if cfg.get("remote_url"):
        addrs.append(cfg["remote_url"].rstrip("/"))
    doc = {"v": 1, "name": "MIST Console", "urls": addrs, "token": cfg["token"]}
    raw = json.dumps(doc, separators=(",", ":")).encode()
    return "mist://pair?d=" + base64.urlsafe_b64encode(raw).decode().rstrip("=")


def status():
    cfg = _load()
    return {
        "enabled": bool(cfg.get("enabled")),
        "tunnel": bool(cfg.get("tunnel")),
        "tunnel_state": tunnel.status(),
        "remote_url": cfg.get("remote_url") or "",
        "keep_awake": bool(cfg.get("keep_awake")),
        "awake": awake_status(),
        "lan_urls": lan_urls(),
        "urls": urls(),
        "pairing": pairing() if cfg.get("enabled") else None,
        "discovery": discovery_url(),
        "discovery_state": dict(_discovery_state),
        "token_created": cfg.get("created"),
        "port": PORT,
        "origin_port": ORIGIN_PORT,
    }


def update(enabled_=None, tunnel_=None, remote_url=None, keep_awake=None):
    cfg = _load()
    with _lock:
        if enabled_ is not None:
            cfg["enabled"] = bool(enabled_)
        if tunnel_ is not None:
            cfg["tunnel"] = bool(tunnel_)
        if keep_awake is not None:
            cfg["keep_awake"] = bool(keep_awake)
        if remote_url is not None:
            remote_url = str(remote_url).strip()
            if remote_url and not re.match(r"^https?://[^\s/]+", remote_url):
                remote_url = "https://" + remote_url.lstrip("/")
            cfg["remote_url"] = remote_url.rstrip("/")
    _save()
    if not (cfg["enabled"] and cfg["tunnel"]):
        tunnel.stop()
    publish_async()
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
    publish_async()
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
