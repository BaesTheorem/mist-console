"""Remote access guard: who counts as "this Mac", and the login limiter.

- Loopback trust needs a loopback name in Host (127.0.0.1, localhost, [::1]),
  so a DNS-rebound page (loopback address, attacker's Host) is refused.
- The tunnel's origin port is never local, and is the only place the
  Cf-Connecting-Ip header is believed.
- Token compares never raise on non-ASCII input; a correct token always logs
  in, even from an address over the miss limit.
- The tunnel supervisor backs off a cloudflared that dies at once, a stopped
  tunnel's reader cannot set a URL, and DNS filtering is told apart from a
  dead tunnel.
"""
# ruff: noqa: SLF001  (white-box tests of remote.py internals)
import os
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["MIST_CONSOLE_DATA_DIR"] = tempfile.mkdtemp(prefix="mist-remote-test-")

import pytest  # noqa: E402

import app  # noqa: E402  (needs the env var above first)
import remote  # noqa: E402

client = app.app.test_client()
ORIGIN = {"SERVER_PORT": str(remote.ORIGIN_PORT)}


@pytest.fixture
def remote_on():
    cfg = remote._load()
    cfg["enabled"] = True
    remote._fails.clear()
    yield cfg
    cfg["enabled"] = False
    remote._fails.clear()


def _get(path, host="127.0.0.1:5014", addr="127.0.0.1", extra=None, **kw):
    env = {"REMOTE_ADDR": addr, **(extra or {})}
    return client.get(path, headers={"Host": host, **kw.pop("headers", {})},
                      environ_overrides=env, **kw)


# ---- is_local / DNS rebinding ----------------------------------------------

@pytest.mark.parametrize("host", ["127.0.0.1:5014", "localhost:5014", "LOCALHOST",
                                  "[::1]:5014", "127.0.0.1"])
def test_loopback_names_are_local(host):
    assert _get("/remote", host=host).status_code == 200


def test_rebound_host_is_refused_even_on_public_paths():
    for path in ("/remote", "/remote/ping", "/sessions"):
        r = _get(path, host="attacker.example:5014")
        assert r.status_code == 403, path
        assert r.get_json()["error"] == "unknown Host"


def test_rebound_host_is_never_local(remote_on):
    with app.app.test_request_context("/remote", headers={"Host": "evil.test:5014"},
                                      environ_base={"REMOTE_ADDR": "127.0.0.1"}):
        assert not remote.is_local(app.request)
        assert remote.foreign_host(app.request)


def test_host_of():
    assert remote.host_of("[::1]:5014") == "::1"
    assert remote.host_of("LocalHost:80") == "localhost"
    assert remote.host_of("localhost.") == "localhost"
    assert remote.host_of("::1") == "::1"


def test_origin_port_is_never_local_and_skips_host_check():
    r = _get("/remote", host="abc-def.trycloudflare.com", extra=ORIGIN)
    assert r.status_code == 403
    assert r.get_json()["error"] == "remote access is off on this Console"


def test_lan_request_needs_token(remote_on):
    r = _get("/remote", host="192.168.1.20:5014", addr="192.168.1.50")
    assert r.status_code == 401
    r = _get("/remote", host="192.168.1.20:5014", addr="192.168.1.50",
             headers={"Authorization": "Bearer " + remote.token()})
    assert r.status_code == 200


# ---- ping name ------------------------------------------------------------

def test_ping_hides_hostname_over_tunnel(monkeypatch):
    monkeypatch.setattr(remote, "local_hostname", lambda: "Alexs-Mac.local")
    r = _get("/remote/ping", host="abc.trycloudflare.com", extra=ORIGIN)
    assert r.status_code == 200
    assert r.get_json()["name"] == "MIST"
    assert r.get_json()["app"] == "mist-console"
    assert _get("/remote/ping").get_json()["name"] == "Alexs-Mac"


# ---- token compares + login limiter ---------------------------------------

def test_non_ascii_bearer_is_401_not_500(remote_on):
    r = _get("/remote", host="192.168.1.20:5014", addr="192.168.1.50",
             headers={"Authorization": "Bearer töken"})
    assert r.status_code == 401
    assert remote.check_token("töken") is False


def _login(tok, addr="192.168.1.50", extra=None, headers=None):
    return client.post("/remote/login", json={"token": tok},
                       headers={"Host": "192.168.1.20:5014", **(headers or {})},
                       environ_overrides={"REMOTE_ADDR": addr, **(extra or {})})


def test_non_ascii_login_counts_as_a_miss(remote_on):
    assert _login("ééé").status_code == 403
    assert len(remote._fails.get("192.168.1.50", [])) == 1


def test_correct_token_beats_the_limit(remote_on):
    for _ in range(remote.FAIL_LIMIT):
        assert _login("wrong").status_code == 403
    assert _login("wrong").status_code == 429
    assert _login(remote.token()).status_code == 200
    assert "192.168.1.50" not in remote._fails


def test_cf_header_ignored_on_lan_port(remote_on):
    # Rotating a made-up Cf-Connecting-Ip must not dodge the limit on the LAN.
    for i in range(remote.FAIL_LIMIT):
        _login("wrong", headers={"Cf-Connecting-Ip": f"10.0.0.{i}"})
    assert _login("wrong", headers={"Cf-Connecting-Ip": "10.0.0.99"}).status_code == 429


def test_cf_header_keys_tunnel_logins(remote_on):
    for _ in range(remote.FAIL_LIMIT):
        _login("wrong", addr="127.0.0.1", extra=ORIGIN, headers={"Cf-Connecting-Ip": "203.0.113.5"})
    assert _login("wrong", addr="127.0.0.1", extra=ORIGIN,
                  headers={"Cf-Connecting-Ip": "203.0.113.5"}).status_code == 429
    assert _login("wrong", addr="127.0.0.1", extra=ORIGIN,
                  headers={"Cf-Connecting-Ip": "203.0.113.6"}).status_code == 403


def test_limiter_prunes_every_address():
    remote._fails.clear()
    old = time.time() - remote.FAIL_WINDOW - 5
    for i in range(50):
        remote._fails[f"198.51.100.{i}"] = [old]
    remote.login_allowed("192.0.2.1")
    assert remote._fails == {}


# ---- tunnel supervisor ------------------------------------------------------

def _wait(pred, secs=5.0):
    end = time.time() + secs
    while time.time() < end and not pred():
        time.sleep(0.05)
    return pred()


def test_quick_exit_backs_off(monkeypatch):
    t = remote._Tunnel()
    monkeypatch.setattr(remote._Tunnel, "binary", staticmethod(lambda: "/usr/bin/false"))
    t.start()
    first = t.proc
    assert first is not None
    assert _wait(lambda: t.not_before > 0)
    assert t.backoff == remote._Tunnel.BACKOFF_MIN * 2
    assert t.not_before == pytest.approx(t.started_at + t.backoff)
    t.start()                       # inside the backoff: no new process
    assert t.proc is first
    t.not_before = 0
    t.start()
    second = t.proc
    assert second is not first
    assert _wait(lambda: t.backoff == remote._Tunnel.BACKOFF_MIN * 4)
    t.stop()
    assert t.backoff == remote._Tunnel.BACKOFF_MIN and t.not_before == 0


def test_backoff_caps():
    t = remote._Tunnel()
    for _ in range(20):
        t._defer(0)
    assert t.backoff == remote._Tunnel.BACKOFF_MAX


class _FakeProc:
    def __init__(self, lines):
        self.stderr = iter(lines)

    def wait(self):
        return 0

    def poll(self):
        return 0


def test_stopped_tunnel_reader_cannot_set_url(monkeypatch):
    monkeypatch.setattr(remote, "publish_async", lambda: None)
    t = remote._Tunnel()
    stale = _FakeProc(["INF |  https://old-one.trycloudflare.com  |\n"])
    t.proc = None                   # stop() already ran
    t._read(stale)
    assert t.url is None
    live = _FakeProc(["INF |  https://new-one.trycloudflare.com  |\n"])
    t.proc = live
    t.started_at = time.time() - 100
    published = []
    monkeypatch.setattr(remote, "publish_async", lambda: published.append(1))
    # _read sees the URL, then the process "exits" after a healthy run
    t._read(live)
    assert published == [1]
    assert t.backoff == remote._Tunnel.BACKOFF_MIN


def test_dns_verdict(monkeypatch):
    table = {}
    monkeypatch.setattr(remote, "_public_addrs", lambda h: table.get(h, []))
    url = "https://abc-def.trycloudflare.com"
    assert remote._dns_verdict(url) == "filtered"
    table["trycloudflare.com"] = ["104.16.230.132"]
    assert remote._dns_verdict(url) == "gone"
    table["abc-def.trycloudflare.com"] = ["104.16.231.132"]
    assert remote._dns_verdict(url) == "resolves"


def test_filtered_dns_does_not_restart(monkeypatch):
    t = remote.tunnel
    monkeypatch.setattr(t, "url", "https://abc-def.trycloudflare.com")
    monkeypatch.setattr(t, "started_at", time.time() - 3600)
    monkeypatch.setattr(remote, "_probe", lambda url, timeout=10: url == remote._CONTROL_URL)
    monkeypatch.setattr(remote, "_dns_verdict", lambda url: "filtered")
    monkeypatch.setattr(remote, "_tunnel_log", lambda line: None)
    stops = []
    monkeypatch.setattr(t, "stop", lambda: stops.append(1))
    for _ in range(remote.HEALTH_MISSES + 2):
        remote._health["at"] = 0
        remote._check_tunnel_health()
    assert stops == []
    monkeypatch.setattr(remote, "_dns_verdict", lambda url: "gone")
    for _ in range(remote.HEALTH_MISSES):
        remote._health["at"] = 0
        remote._check_tunnel_health()
    assert stops == [1]


# ---- discovery publish -------------------------------------------------------

def test_publish_records_only_after_success(monkeypatch):
    import share
    order = []
    monkeypatch.setattr(share, "_creds", lambda: ("acct", "tok"))
    monkeypatch.setattr(share, "_ensure_cloud", lambda: ("https://x.example", "kv"))
    monkeypatch.setattr(remote, "urls", lambda: ["http://a", "https://t.trycloudflare.com"])
    monkeypatch.setattr(remote, "enabled", lambda: True)
    remote._published.update(urls=None)

    def boom(*a, **k):
        order.append(("put", remote._published["urls"]))
        raise OSError("dns")
    monkeypatch.setattr(share, "_req", boom)
    assert remote.publish_discovery()["ok"] is False
    assert remote._published["urls"] is None
    monkeypatch.setattr(share, "_req", lambda *a, **k: order.append(("put", remote._published["urls"])))
    assert remote.publish_discovery()["ok"] is True
    assert order[-1] == ("put", None)            # not recorded before the PUT
    assert remote._published["urls"] == ["http://a", "https://t.trycloudflare.com"]


def test_publish_async_coalesces(monkeypatch):
    gate, calls = threading.Event(), []

    def slow():
        calls.append(1)
        gate.wait(2)
    monkeypatch.setattr(remote, "publish_discovery", slow)
    for _ in range(5):
        remote.publish_async()
    gate.set()
    assert _wait(lambda: not remote._pub["busy"])
    assert len(calls) == 2           # the running one, then one more for the rest
