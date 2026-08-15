#!/bin/bash
# run-routine.sh <routine-dir-name>
# Runs a Claude Code routine from ~/.claude/scheduled-tasks/<dir>/SKILL.md.
# Invoked by a launchd job that the MIST Console generates when a routine is
# scheduled + enabled. Mirrors how the desktop app runs a routine: feed the
# SKILL.md body to `claude` headless in the harness cwd (so CLAUDE.md + the
# MIST persona auto-load).
set -e
# launchd LaunchAgents set HOME but NOT USER. The macOS login Keychain lookup
# that `claude` uses to read its OAuth credential requires USER to be set, or it
# reports "Not logged in" and exits EX_CONFIG (78). Restore it so headless runs
# under launchd can authenticate. (Regression surfaced after the 2026-06-23 CC
# upgrade; every scheduled routine was silently dying with 78.)
export USER="${USER:-$(id -un)}"
export LOGNAME="${LOGNAME:-$USER}"
DIR="$1"
[ -n "$DIR" ] || { echo "usage: run-routine.sh <routine-dir>"; exit 2; }
SK="$HOME/.claude/scheduled-tasks/$DIR/SKILL.md"
[ -f "$SK" ] || { echo "no SKILL.md for routine '$DIR'"; exit 0; }

HARNESS="/Users/alexhedtke/Documents/Exobrain harness"
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
# Resolve the CLI rather than pinning an install path; it lives in ~/.local/bin
# under the native installer and in the npm prefix under a global npm install.
CLAUDE="$(command -v claude)"
[ -n "$CLAUDE" ] || { echo "claude CLI not found on PATH"; exit 1; }

# Strip the YAML frontmatter (everything up to and including the 2nd '---'),
# pass the remaining body as the prompt.
PROMPT="$(awk 'BEGIN{fm=0} /^---[[:space:]]*$/{fm++; next} fm>=2{print}' "$SK")"
[ -n "$PROMPT" ] || PROMPT="$(cat "$SK")"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] running routine: $DIR"
cd "$HARNESS"

# Don't `exec` claude directly: its exit code becomes the launchd job's sticky
# LAST_EXIT, and the session-start hook flags ANY nonzero as a hard FAIL until
# the next successful fire. A single transient API blip (connection dropped
# mid-response, socket failure, usage cap) then masquerades as a broken routine
# for days — and for weekly jobs (local-events-scan) up to a week. So capture
# the exit, tee the output, and classify: genuine config errors still fail
# loudly (keep the EX_CONFIG 78 / not-logged-in guard meaningful); known
# transient failures don't leave a stale FAIL flag lit.
#
# But "don't flag it" isn't the same as "don't produce the briefing". A dropped
# connection mid-response (the 2026-07-20 morning-briefing incident) left the day
# with NO briefing at all. So first RETRY transient failures in-process a few
# times with backoff — a momentary blip almost always clears within a minute or
# two, which recovers the run on the same morning. Only if every attempt hits a
# transient error do we give up, and then:
#   - default: exit 0 (quiet, no stale FAIL) — preserves behavior for routines
#     that call this script directly (afternoon-email-scan, weekly-review,
#     local-events-scan).
#   - if ROUTINE_SIGNAL_TRANSIENT=1 (set by run-routine-catchup.sh): exit 75
#     (EX_TEMPFAIL) so the catch-up wrapper knows the run is INCOMPLETE and can
#     leave its per-day marker unstamped, letting the next fire re-attempt.
MAX_ATTEMPTS="${ROUTINE_MAX_ATTEMPTS:-3}"
TRANSIENT_RE='connection closed|failedtoopensocket|unable to connect|session limit|rate limit|overloaded|timed out|econnreset|api error'
attempt=0
while :; do
	attempt=$((attempt + 1))
	set +e
	OUT="$("$CLAUDE" -p --dangerously-skip-permissions "$PROMPT" 2>&1)"
	RC=$?
	set -e
	printf '%s\n' "$OUT"

	if [ "$RC" -eq 0 ]; then
		exit 0
	fi

	# Genuine config/auth failures — these SHOULD stick as FAIL so they get fixed.
	# Never retry these; retrying a bad credential just wastes minutes.
	if [ "$RC" -eq 78 ] || printf '%s' "$OUT" | grep -qiE 'not logged in|invalid api key|authentication_error|please run .*login'; then
		echo "[$(date '+%Y-%m-%d %H:%M:%S')] $DIR — genuine config/auth failure (rc=$RC); leaving FAIL flag for investigation."
		exit "$RC"
	fi

	# Known-transient API/network/usage failure — retry before giving up.
	if printf '%s' "$OUT" | grep -qiE "$TRANSIENT_RE"; then
		if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
			backoff=$((attempt * 30))
			echo "[$(date '+%Y-%m-%d %H:%M:%S')] $DIR — transient failure (rc=$RC), attempt $attempt/$MAX_ATTEMPTS; retrying in ${backoff}s."
			sleep "$backoff"
			continue
		fi
		echo "[$(date '+%Y-%m-%d %H:%M:%S')] $DIR — transient failure persisted after $MAX_ATTEMPTS attempts (rc=$RC); not flagging as FAIL."
		if [ "${ROUTINE_SIGNAL_TRANSIENT:-0}" = "1" ]; then
			exit 75   # EX_TEMPFAIL — tell the catch-up wrapper to retry later.
		fi
		exit 0
	fi

	# Unknown nonzero — surface it (better a rare false alarm than a silent break).
	echo "[$(date '+%Y-%m-%d %H:%M:%S')] $DIR — unclassified nonzero exit (rc=$RC); flagging."
	exit "$RC"
done
