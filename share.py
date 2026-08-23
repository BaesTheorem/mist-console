"""share.py — public share links for conversations (claude.ai-style).

A share is a self-contained HTML snapshot of one chat, captured client-side
(app.js buildShareSnapshot: transcript DOM + inlined CSS + inlined images,
interactive chrome stripped) and POSTed to the server. The canonical copy
lives at data/shares/<token>.html and is served locally at /share/<token>;
when Cloudflare credentials allow, the same bytes are published to Workers KV,
where a tiny read-only Worker serves them publicly at
https://mist-share.<account-subdomain>.workers.dev/s/<token> — an unguessable,
unlisted, revocable URL, the same model as claude.ai's "share chat".

The Worker never accepts writes: publish and revoke go straight from this
module to the KV REST API, so the public surface is GET-only. Deploying the
Worker (first share, or when WORKER_JS changes) happens lazily inside
publish(); it needs a Cloudflare API token with **Workers Scripts:Edit** and
**Workers KV Storage:Edit** on the account. The mist-image token is Workers
AI-only, so a second token (CF_SHARE_API_TOKEN in the harness .env) is the
expected setup; CF_API_TOKEN is tried as a fallback in case it ever grows the
scopes.

INVARIANTS:
- A conversation's token is minted once and survives re-shares: updating a
  share must never change its URL.
- Revoking deletes both the KV copy and the local snapshot; a revoked token
  404s everywhere.
- No credentials are ever embedded in a snapshot or in WORKER_JS.
- Local sharing must keep working with zero Cloudflare credentials.
"""

import hashlib
import json
import os
import re
import secrets
import threading
import urllib.error
import urllib.request

from bridge import DATA_DIR, HARNESS

SHARES_DIR = os.path.join(DATA_DIR, "shares")
SHARES_META = os.path.join(SHARES_DIR, "shares.json")     # sid -> share record
CLOUD_CONFIG = os.path.join(SHARES_DIR, "config.json")    # deployed-worker state
WORKER_NAME = "mist-share"
KV_TITLE = "mist-share-html"
MAX_SNAPSHOT_BYTES = 24 * 1024 * 1024   # KV values cap at 25 MiB; leave headroom
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")

_lock = threading.Lock()


class ShareCloudError(Exception):
    """Cloud publish impossible right now; .why is a short machine-ish reason
    and str() is the human sentence the UI shows."""

    def __init__(self, why, msg):
        super().__init__(msg)
        self.why = why


# The public face of a share: a module Worker that only ever GETs from KV.
# Bumping this string redeploys on the next publish (hash-tracked in config).
WORKER_JS = """\
export default {
  async fetch(req, env) {
    const m = new URL(req.url).pathname.match(/^\\/s\\/([A-Za-z0-9_-]{8,64})\\/?$/);
    if (req.method !== "GET" || !m)
      return new Response("not found", { status: 404 });
    const html = await env.SHARES.get(m[1]);
    if (html === null)
      return new Response("This shared chat has been unshared or never existed.",
                          { status: 404 });
    return new Response(html, { headers: {
      "content-type": "text/html; charset=utf-8",
      "x-robots-tag": "noindex, nofollow",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy":
        "default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; " +
        "media-src data:; base-uri 'none'; form-action 'none'",
    }});
  },
};
"""


# ---- harness .env ------------------------------------------------------------

def _harness_env():
    """KEY=VALUE pairs from the harness .env (process env wins). The Console
    server doesn't source .env itself, so read it directly."""
    vals = {}
    try:
        with open(os.path.join(HARNESS, ".env")) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                vals[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    vals.update({k: v for k, v in os.environ.items() if k.startswith("CF_")})
    return vals


def _creds():
    env = _harness_env()
    account = env.get("CF_ACCOUNT_ID")
    token = env.get("CF_SHARE_API_TOKEN") or env.get("CF_API_TOKEN")
    return account, token


# ---- Cloudflare API ----------------------------------------------------------

_API = "https://api.cloudflare.com/client/v4"


def _req(method, path, token, body=None, ctype="application/json", raw=False):
    """One Cloudflare API call. Returns the parsed 'result' (or raw bytes).
    Raises ShareCloudError on auth/permission failures so callers surface a
    human-readable fix instead of a stack trace."""
    if isinstance(body, (dict, list)):
        body = json.dumps(body).encode()
    req = urllib.request.Request(
        _API + path, data=body, method=method,
        headers={"Authorization": "Bearer " + token,
                 **({"Content-Type": ctype} if body is not None else {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read()
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            errs = json.loads(e.read()).get("errors") or []
            detail = "; ".join(str(x.get("message", "")) for x in errs)
        except Exception:
            pass
        if e.code in (401, 403) or "Authentication error" in detail:
            raise ShareCloudError(
                "token-scope",
                "The Cloudflare token can't manage Workers/KV. Mint a token with "
                "'Workers Scripts:Edit' + 'Workers KV Storage:Edit' on the account "
                "and save it as CF_SHARE_API_TOKEN in the harness .env.") from e
        raise ShareCloudError("api-error", f"Cloudflare API {e.code} on {path}: {detail or e.reason}") from e
    except urllib.error.URLError as e:
        raise ShareCloudError("offline", f"Couldn't reach Cloudflare: {e.reason}") from e
    if raw:
        return data
    parsed = json.loads(data or b"{}")
    if parsed.get("success") is False:
        raise ShareCloudError("api-error", f"Cloudflare API error on {path}: {parsed.get('errors')}")
    return parsed.get("result")


def _load_cloud_config():
    try:
        with open(CLOUD_CONFIG) as f:
            return json.load(f)
    except Exception:
        return {}


def _save_cloud_config(cfg):
    os.makedirs(SHARES_DIR, exist_ok=True)
    tmp = f"{CLOUD_CONFIG}.tmp.{os.getpid()}"
    with open(tmp, "w") as f:
        json.dump(cfg, f, indent=2)
    os.replace(tmp, CLOUD_CONFIG)


def _worker_hash():
    return hashlib.sha256(WORKER_JS.encode()).hexdigest()[:16]


def _ensure_cloud():
    """Deploy (or refresh) the Worker + KV namespace. Returns (base_url, kv_id).
    Idempotent; cheap after the first run (config short-circuits)."""
    account, token = _creds()
    if not account or not token:
        raise ShareCloudError(
            "no-credentials",
            "No Cloudflare credentials found (CF_ACCOUNT_ID + CF_SHARE_API_TOKEN "
            "in the harness .env).")
    cfg = _load_cloud_config()
    if cfg.get("base_url") and cfg.get("kv_id") and cfg.get("worker_hash") == _worker_hash():
        return cfg["base_url"], cfg["kv_id"]

    # 1. KV namespace (find-or-create by title).
    kv_id = cfg.get("kv_id")
    if not kv_id:
        for ns in (_req("GET", f"/accounts/{account}/storage/kv/namespaces?per_page=100", token) or []):
            if ns.get("title") == KV_TITLE:
                kv_id = ns["id"]
                break
    if not kv_id:
        kv_id = _req("POST", f"/accounts/{account}/storage/kv/namespaces", token,
                     {"title": KV_TITLE})["id"]

    # 2. Upload the module Worker with the KV binding (multipart per the API).
    boundary = "----mistshare" + secrets.token_hex(8)
    metadata = json.dumps({
        "main_module": "worker.js",
        "compatibility_date": "2025-01-01",
        "bindings": [{"type": "kv_namespace", "name": "SHARES", "namespace_id": kv_id}],
    })
    parts = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="metadata"\r\n'
        "Content-Type: application/json\r\n\r\n"
        f"{metadata}\r\n"
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="worker.js"; filename="worker.js"\r\n'
        "Content-Type: application/javascript+module\r\n\r\n"
        f"{WORKER_JS}\r\n"
        f"--{boundary}--\r\n"
    ).encode()
    _req("PUT", f"/accounts/{account}/workers/scripts/{WORKER_NAME}", token,
         parts, ctype=f"multipart/form-data; boundary={boundary}")

    # 3. Serve it on workers.dev.
    _req("POST", f"/accounts/{account}/workers/scripts/{WORKER_NAME}/subdomain", token,
         {"enabled": True, "previews_enabled": False})
    sub = (_req("GET", f"/accounts/{account}/workers/subdomain", token) or {}).get("subdomain")
    if not sub:
        raise ShareCloudError(
            "no-subdomain",
            "The Cloudflare account has no workers.dev subdomain yet. Set one once "
            "in the dashboard (Workers & Pages → your subdomain), then share again.")

    base_url = f"https://{WORKER_NAME}.{sub}.workers.dev"
    _save_cloud_config({"base_url": base_url, "kv_id": kv_id,
                        "worker_hash": _worker_hash(), "account": account})
    return base_url, kv_id


def cloud_status():
    """Cheap, no-network status for the UI. 'deployed' means a past publish
    succeeded; 'has_creds' means a publish attempt is worth making."""
    account, token = _creds()
    cfg = _load_cloud_config()
    return {"has_creds": bool(account and token),
            "deployed": bool(cfg.get("base_url")),
            "base_url": cfg.get("base_url")}


def _kv_publish(token_id, html):
    account, token = _creds()
    base_url, kv_id = _ensure_cloud()
    _req("PUT", f"/accounts/{account}/storage/kv/namespaces/{kv_id}/values/{token_id}",
         token, html.encode(), ctype="text/html", raw=True)
    return f"{base_url}/s/{token_id}"


def _kv_revoke(token_id):
    account, token = _creds()
    cfg = _load_cloud_config()
    if not (account and token and cfg.get("kv_id")):
        return
    _req("DELETE", f"/accounts/{account}/storage/kv/namespaces/{cfg['kv_id']}/values/{token_id}",
         token, raw=True)


# ---- local store -------------------------------------------------------------

def _load_meta():
    try:
        with open(SHARES_META) as f:
            return json.load(f)
    except Exception:
        return {}


def _save_meta(meta):
    os.makedirs(SHARES_DIR, exist_ok=True)
    tmp = f"{SHARES_META}.tmp.{os.getpid()}"
    with open(tmp, "w") as f:
        json.dump(meta, f, indent=2)
    os.replace(tmp, SHARES_META)


def _snapshot_path(token_id):
    if not _TOKEN_RE.match(token_id or ""):
        return None
    return os.path.join(SHARES_DIR, f"{token_id}.html")


def status(sid):
    rec = _load_meta().get(sid)
    out = {"shared": bool(rec), "cloud": cloud_status()}
    if rec:
        out.update({k: rec.get(k) for k in
                    ("token", "url", "published", "created", "updated", "title",
                     "bytes", "reason")})
        out["local_url"] = f"/share/{rec['token']}"
    return out


def create_or_update(sid, title, html):
    """Store the snapshot and try to publish it. Returns the share record;
    'published' False + 'reason' when only the local copy exists."""
    if len(html.encode()) > MAX_SNAPSHOT_BYTES:
        raise ValueError("snapshot too large to share (over 24 MB)")
    os.makedirs(SHARES_DIR, exist_ok=True)
    with _lock:
        meta = _load_meta()
        rec = meta.get(sid) or {"token": secrets.token_urlsafe(18),
                                "created": _now(), "published": False}
        path = _snapshot_path(rec["token"])
        assert path is not None   # token minted by us; always matches _TOKEN_RE
        with open(path, "w") as f:
            f.write(html)
        rec.update({"title": title or "", "updated": _now(),
                    "bytes": os.path.getsize(path)})
        meta[sid] = rec
        _save_meta(meta)
    try:
        url = _kv_publish(rec["token"], html)
        rec.update({"url": url, "published": True})
        rec.pop("reason", None)
    except ShareCloudError as e:
        rec["published"] = False
        rec["reason"] = {"why": e.why, "message": str(e)}
    with _lock:
        meta = _load_meta()
        meta[sid] = rec
        _save_meta(meta)
    out = dict(rec)
    out["local_url"] = f"/share/{rec['token']}"
    return out


def revoke(sid):
    """Delete the public copy and the local snapshot. KV delete happens first:
    if it fails the share record survives, so revoke can be retried rather than
    orphaning a live public copy."""
    with _lock:
        rec = _load_meta().get(sid)
    if not rec:
        return {"shared": False}
    _kv_revoke(rec["token"])   # raises ShareCloudError -> surfaced by the route
    with _lock:
        meta = _load_meta()
        meta.pop(sid, None)
        _save_meta(meta)
    path = _snapshot_path(rec["token"])
    if path and os.path.exists(path):
        os.remove(path)
    return {"shared": False}


def read_snapshot(token_id):
    """The stored HTML for /share/<token>, or None."""
    path = _snapshot_path(token_id)
    if not path or not os.path.exists(path):
        return None
    with open(path) as f:
        return f.read()


def _now():
    import time
    return int(time.time())
