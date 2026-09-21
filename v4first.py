"""v4first.py: an HTTPS opener that connects over IPv4 before IPv6.

This Mac's IPv6 dead-ends on some networks (curl -6 to api.cloudflare.com
times out; measured 2026-09-21), and urllib has no happy eyeballs: it walks
every AAAA record with the full request timeout before it reaches an A record,
so a 0.1s call to Cloudflare took 130s and every usage poll to
api.anthropic.com (one AAAA record) paid a 15s stall. Connecting to the A
records first, then the AAAA ones, each with a short connect timeout, keeps a
dual-stack API fast here and still works on an IPv6-only network.

Use `opener.open(req, timeout=...)` wherever urllib.request.urlopen was.
"""
import http.client
import socket
import urllib.request

CONNECT_TIMEOUT = 5


def create_connection(address, timeout=socket._GLOBAL_DEFAULT_TIMEOUT, source_address=None):
    host, port = address
    infos = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)
    infos.sort(key=lambda i: 0 if i[0] == socket.AF_INET else 1)
    err = None
    for family, kind, proto, _, sockaddr in infos:
        sock = socket.socket(family, kind, proto)
        try:
            per_try = CONNECT_TIMEOUT
            if timeout is not socket._GLOBAL_DEFAULT_TIMEOUT and timeout is not None:
                per_try = min(per_try, timeout)
            sock.settimeout(per_try)
            if source_address:
                sock.bind(source_address)
            sock.connect(sockaddr)
            if timeout is not socket._GLOBAL_DEFAULT_TIMEOUT:
                sock.settimeout(timeout)
            return sock
        except OSError as e:
            err = e
            sock.close()
    raise err or OSError(f"no address for {host}")


class _Handler(urllib.request.HTTPSHandler):
    def https_open(self, req):
        def factory(host, **kw):
            conn = http.client.HTTPSConnection(host, **kw)
            conn._create_connection = create_connection
            return conn
        return self.do_open(factory, req)


opener = urllib.request.build_opener(_Handler())
