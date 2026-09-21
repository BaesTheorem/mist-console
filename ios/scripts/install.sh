#!/usr/bin/env bash
# Build signed, then install and launch on the paired iPhone.
# Usage: scripts/install.sh [device-udid]
# Works over Wi-Fi once the phone is paired for network connection in Xcode,
# as long as it is unlocked and on the same network.
set -euo pipefail

cd "$(dirname "$0")/.."
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

UDID="${1:-}"
if [ -z "$UDID" ]; then
  # Match the identifier by shape; the name column has spaces in it. `|| true`
  # so a no-match grep does not kill the script silently under pipefail.
  UDID=$(xcrun devicectl list devices 2>/dev/null | grep -iE 'connected|available' \
    | grep -oiE '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}' \
    | head -1 || true)
fi
if [ -z "$UDID" ]; then
  echo "No paired device found. Plug the phone in once, unlock it, and trust this Mac." >&2
  exit 1
fi

scripts/build.sh --device

# devicectl resolves the bundle through a file bookmark, which fails on a
# relative path once the shell's directory has moved; hand it an absolute one.
APP="$(pwd)/build/dd/Build/Products/Release-iphoneos/MIST.app"

# Raise the network tunnel first (the device list reports a cached state), and
# give the transfer a second try: the first sustained transfer after a probe
# has dropped with a tunnel timeout before while the second landed.
xcrun devicectl device info details --device "$UDID" >/dev/null 2>&1 || true
if ! xcrun devicectl device install app --device "$UDID" "$APP"; then
  echo "install dropped; raising the tunnel and retrying once" >&2
  xcrun devicectl device info details --device "$UDID" >/dev/null 2>&1 || true
  sleep 2
  xcrun devicectl device install app --device "$UDID" "$APP"
fi
xcrun devicectl device process launch --device "$UDID" --terminate-existing \
  com.alexhedtke.mistconsole
