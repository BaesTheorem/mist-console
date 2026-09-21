# MIST for iPhone

A native shell (SwiftUI + WKWebView) around the MIST Console web UI served by
the Mac. Nothing runs on the phone: it pairs with the Console once, finds the
Mac (home network, tunnel, or a configured address), logs in, and shows the
same page every chat lives on. All chats are mirrored because they are the
same chats: the phone renders the Mac's `data/`, live, over the same event
stream the desktop window uses. The Mac has to be awake with the Console
running.

## What lives where

- **Server side** is in the repo root: `remote.py` (pairing token, cookie
  auth, LAN/tunnel addresses, discovery publish) and the `/remote/*` routes
  plus the `before_request` guard in `app.py`. The server binds every
  interface; the guard refuses any non-local request unless remote access is
  on and the caller holds the token. See the "iPhone app" section of the main
  README for the security model.
- **Web UI** adapts itself under 760px (`static/style.css`, the "phone"
  blocks) and when the app's user agent (`MISTShell/…`) is present: the chat
  rail becomes a drawer (tap the menu or the chat title, or swipe in from the
  left edge; swipe it or its backdrop leftward to close), the top bar shows
  the active chat's title, the composer clears the home indicator, the return
  key inserts a newline (the send button sends), the attach button opens the
  photo library and the photo rides along as an image attachment, and the
  close-x on chat rows is off (closing deletes the chat; there is no hover to
  reveal it on intent).
- **This directory** is the shell: `MIST/Sources` (Swift), `MIST/Resources`
  (icon, colors), `project.yml` (XcodeGen), `scripts/`.

```
Sources/MISTApp.swift          entry; scene phase -> reconnect; mist:// URLs
Sources/Model/Pairing.swift     mist://pair?d=<base64url json> parser
Sources/Model/ServerStore.swift the paired Mac: urls + name (UserDefaults), token (Keychain)
Sources/Model/Probe.swift       ping / login / config / discovery requests
Sources/Model/ConsoleLink.swift connection state machine (probe -> login -> load)
Sources/Views/ConsoleWebView    the page; logs in with a form POST so the cookie lands in WK's jar
Sources/Views/ConsoleScreen     web view + status overlay (finding / unreachable / not paired)
Sources/Views/PairView          first run: scan the QR, paste the link, or type url + token
Sources/Views/QRScannerView     AVFoundation QR reader
Sources/Views/SettingsView      the shell's own settings: addresses, re-pair, forget
```

## Pairing

On the Mac: MIST settings, **phone**, switch on **remote access**. The section
shows a QR code and the addresses the Mac answers on. In the app: **scan the
pairing code**. The code carries the address list, the pairing token, and the
discovery URL. Rotating the token on the Mac invalidates every phone.

## Finding the Mac

Two rounds, on every launch, every return to the foreground, every network
change the phone sees (`NWPathMonitor`), and whenever the page reports its
event stream down for more than a few seconds:

1. Race every address the phone remembers (`GET /remote/ping`, in parallel)
   and take the first *by list order* that answered. If none did and the
   pairing carried a discovery URL, read that document (the Mac publishes its
   whole current address list there, through the share Worker's KV, whenever
   it changes) and race what it says.
2. Ask that Mac for its current list (`/remote/config`, LAN first) and race
   it again. A better address that answers replaces the first find.

Round two is what makes the **hotspot** case direct. Tethered to the phone,
the Mac takes a fresh `172.20.10.x` address that nothing the phone remembers
would reach; the tunnel (if on) still answers, so round one lands there, then
round two learns the tether address and moves to it. Traffic then stays on
the tether link instead of going out through Cloudflare and back through the
phone's own cellular twice. With the tunnel off, the discovery document
carries the tether address instead (the Mac republishes within ~15 s of
joining a network).

While the Mac is out of reach the app looks again every 15 s.

Away from home there are two lanes, chosen on the Mac:

- **Cloudflare quick tunnel** (`keep a Cloudflare tunnel up`): the Console
  keeps a `cloudflared` quick tunnel running and publishes its
  `*.trycloudflare.com` URL. Free, no account, https. Its origin is a
  loopback-only listener (`ORIGIN_PORT`, the Console's port plus 1000) that
  the guard treats as never local, so the tunnel is untouched by a VPN's LAN
  rules (Mullvad's "local network sharing: block" included) and survives the
  Mac hopping networks with the same URL. The URL only changes when the
  cloudflared process restarts, which is what the discovery lookup is for.
- **Your own address**: a Tailscale MagicDNS name or anything that resolves to
  the Mac. Sturdier, needs Tailscale (or similar) on both devices.

## Build and install

```sh
cd ios
cp Config/Signing.xcconfig.example Config/Signing.xcconfig   # set DEVELOPMENT_TEAM
scripts/build.sh            # unsigned compile check
scripts/build.sh --device   # signed Release build
scripts/install.sh          # build + install + launch on the paired iPhone (Wi-Fi works)
```

Requirements: Xcode with the iOS platform, `brew install xcodegen`, an Apple
developer team (a paid team signs for a year; a free one for seven days).
Install needs the phone paired to this Mac in Xcode once, unlocked, and on
the same network. The app is registered in the harness `ios-sideload`
config, so `ios-sideload/refresh.py` can re-sign it with the others.

## Gotchas

- **Plain http on the LAN** needs `NSAllowsLocalNetworking`; a Tailscale or
  other user-entered http address is not "local" to ATS, so the plist also
  sets `NSAllowsArbitraryLoads`. The only server the app talks to is the one
  it was paired with.
- **The cookie has to be set by a navigation**, not by URLSession: WKWebView
  keeps its own jar. The shell loads a form `POST /remote/login` in the web
  view; the 303 lands on `/` with the cookie set, and the event stream carries
  it from then on. The JSON login the shell does first is only a token check.
- **`.local` resolution and any LAN request** trigger iOS's local-network
  permission prompt on first use; until it is answered the probe fails and
  the next attempt succeeds.
- **The keyboard**: iOS shrinks the visual viewport and leaves the layout
  viewport alone, so the page tracks `visualViewport.height` into `--vvh`
  (app.js) and sizes the body from it. Do not "fix" this in Swift by
  resizing the web view; the page already handles it.
- **Text size is a CSS zoom on the root**, and a px length inside it renders
  zoomed. Anything sized from a measured viewport value (`--vvh`) has to be
  divided by that zoom first, or a 125% Console gets a body 25% taller than
  the screen and the top bar scrolls off. The body is pinned
  (`position: fixed`) on phones so nothing can scroll the document anyway.
- **The web view never scrolls as a document** (`bounces = false`); the
  transcript is its own scroller. If something starts rubber-banding, a
  layout change let the document grow past the viewport.
- **A VPN with LAN blocking on either device** (Mullvad's default on the Mac)
  kills the direct path; the app falls through to the tunnel, which works
  through the VPN. `mullvad lan set allow` on the Mac restores the direct
  path while it is up.
