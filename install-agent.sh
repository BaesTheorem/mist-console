#!/bin/zsh
# Install + load the always-on MIST hotkey agent as a LaunchAgent (runs at login,
# kept alive). The plist is a real file (not a symlink) so TCC loads it cleanly.
set -e

PROJ="/Users/alexhedtke/Documents/mist-console"
UV="/Users/alexhedtke/.local/bin/uv"
[ -x "$HOME/.local/bin/mist-launch" ] || { echo "install mist-launch first (harness maintenance/mist-launch/install.sh)" >&2; exit 1; }
AGENT="$PROJ/mist-hotkey-agent.py"
LABEL="com.exobrain.mist-hotkey-agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$HOME/Library/LaunchAgents"
launchctl unload "$PLIST" 2>/dev/null || true

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$HOME/.local/bin/mist-launch</string>
    <string>$UV</string><string>run</string><string>--script</string><string>$AGENT</string>
  </array>
  <!-- Login Items shows the job under MIST Console (the launcher is signed by the
       same team); see the harness's maintenance/mist-launch. -->
  <key>AssociatedBundleIdentifiers</key>
  <array><string>com.exobrain.mist-console</string></array>
  <key>WorkingDirectory</key><string>$PROJ</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/Users/alexhedtke/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$PROJ/agent.log</string>
  <key>StandardErrorPath</key><string>$PROJ/agent.log</string>
</dict>
</plist>
EOF

launchctl load "$PLIST"
echo "loaded $LABEL"
echo "agent log: $PROJ/agent.log"
