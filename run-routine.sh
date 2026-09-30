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
# Unattended: every scheduled routine reads third-party text (email, chat,
# transcripts, the web) with full tools and nobody watching. The harness guard
# hook (.claude/hooks/guard-unattended.py) keys on this variable and refuses
# instruction-file writes and persistence shells for the session.
export MIST_UNATTENDED=1
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

# Optional per-routine model. A `model: <id>` line in the SKILL.md frontmatter
# (or ROUTINE_MODEL in the environment) is passed as --model; otherwise the
# CLI's default applies. Added 2026-09-07 so the fantasy-football routines run
# on Fable as Alex asked, without changing what every other routine gets.
MODEL="$(awk 'BEGIN{fm=0} /^---[[:space:]]*$/{fm++; next} fm==1 && /^model:/{sub(/^model:[[:space:]]*/, ""); gsub(/"/, ""); print; exit}' "$SK")"
MODEL="${MODEL:-${ROUTINE_MODEL:-}}"
MODEL_ARGS=()
[ -n "$MODEL" ] && MODEL_ARGS=(--model "$MODEL")

# Fallback model, used only when the chosen model is out of usage credits.
# A `fallback_model: <id>` line in the frontmatter overrides it; so does
# ROUTINE_FALLBACK_MODEL. Set `fallback_model: none` to opt a routine out and
# let it fail instead of running on a different model.
#
# Added 2026-09-08, after fantasy-lineup and fantasy-tuesday both died the same
# evening on "You're out of usage credits" while pointed at Fable. Credit
# exhaustion is per-model, the CLI's own message says "Switch to another
# model", and a routine that does not run at all is strictly worse than one
# that runs on Opus. The retry-with-backoff path could never fix this: waiting
# 30 seconds does not refill a credit balance.
FALLBACK_MODEL="$(awk 'BEGIN{fm=0} /^---[[:space:]]*$/{fm++; next} fm==1 && /^fallback_model:/{sub(/^fallback_model:[[:space:]]*/, ""); gsub(/"/, ""); print; exit}' "$SK")"
FALLBACK_MODEL="${FALLBACK_MODEL:-${ROUTINE_FALLBACK_MODEL:-claude-opus-5-5[1m]}}"
[ "$FALLBACK_MODEL" = "none" ] && FALLBACK_MODEL=""

# Connector preflight, prepended to every routine.
#
# The network gate below runs BEFORE claude launches, so it can't cover DNS
# dying in the seconds between the gate passing and the remote MCP connectors
# attaching. A session that loses that race never retries the attach, runs to
# completion, and exits 0 having silently skipped calendar and email. Nothing
# downstream can tell that apart from a real success.
#
# So let the session check its own tools and say so. The sentinel turns a silent
# degraded run into the transient case, which the retry machinery already knows
# how to re-fire.
PREFLIGHT='PREFLIGHT (do this first, before any other work):

If the routine below needs Google Calendar or Gmail, confirm those tools are
actually attached to THIS session. Search by keyword, not by exact name:
ToolSearch "+calendar" and ToolSearch "+gmail". Keyword search finds them under
whatever prefix they currently carry; an exact-name "select:" miss only proves
the name is stale, not that the connector is down.

If a connector this routine needs is genuinely absent, do NOT continue and do
NOT write a partial briefing, note, or message. Print exactly this token and
nothing else, then stop:

ROUTINE_ABORT_CONNECTORS_MISSING

A run that quietly skips the calendar or the email scan is worse than no run:
it looks finished, so nobody re-runs it. Aborting lets a later fire retry.

--- ROUTINE BEGINS ---

'
PROMPT="${PREFLIGHT}${PROMPT}"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] running routine: $DIR"
cd "$HARNESS"

# Gate on a usable network before launching claude. Eight standalone harness
# scripts already do this; run-routine.sh is the chokepoint EVERY scheduled
# routine passes through, and it was the one path with no gate.
#
# This matters more here than for a plain HTTP script, because of how the
# claude.ai connectors (Google Calendar, Gmail, Drive, MyChart) attach. They are
# remote HTTP MCP servers resolved at session start. If DNS is still dead in the
# seconds after a wake, they fail to attach and the session NEVER retries them
# for its whole life. The routine then runs to completion and exits 0 while
# silently missing calendar and email, so it looks like a success. That is the
# 2026-08-26 failure: both the morning briefing and the evening wind-down ran
# without a verified schedule and without an email scan, on a day when
# `claude mcp list` reported every connector healthy.
#
# So `claude mcp list` is NOT a valid readiness probe: it runs in its own
# process and says "Connected" for connectors the routine's session never got.
# Probe DNS + TCP + TLS to the actual endpoint hosts instead.
for host in api.anthropic.com calendarmcp.googleapis.com; do
	if ! "$HARNESS/scripts/wait-for-network.sh" "$host" 300; then
		echo "[$(date '+%Y-%m-%d %H:%M:%S')] $DIR — $host unreachable after 300s; skipping rather than running a routine with dead connectors."
		# Same contract as a transient API failure: tell the on-time wrapper to
		# leave today's marker unstamped so a later fire in the window retries.
		[ "${ROUTINE_SIGNAL_TRANSIENT:-0}" = "1" ] && exit 75
		exit 0
	fi
done

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
# Credit exhaustion on the selected model. Deliberately NOT in TRANSIENT_RE:
# retrying the same model is pointless, and the fix is a different model.
CREDITS_RE='out of usage credits|usage credits|credit balance is too low|insufficient credits'
FELL_BACK=0
LIMIT_WAITED=0
NOTIFY="$HOME/Documents/Exobrain harness/mist-voice/bin/mist-notify"

# Overall wall-clock budget for the claude runs (default 45 min). There was no
# timeout at all, so a hung session held the routine, and its catch-up marker,
# indefinitely. macOS has no timeout(1): each attempt runs in the background
# under a watchdog that kills it when the budget is spent. A deliberate
# session-limit wait (below) extends the deadline by the time slept.
TIMEOUT_SEC="${ROUTINE_TIMEOUT_SEC:-2700}"
DEADLINE=$(( $(date +%s) + TIMEOUT_SEC ))
TIMED_OUT=0
# Every banner a routine sends lands, when tapped, in a Console chat seeded
# with the notification plus this context (mist-notify reads the two
# variables), so the chat knows which routine spoke and where its full
# transcript is. The session id is chosen here, before the run, for that
# reason: it names the CLI transcript the seeded chat can go and read.
CLI_PROJECT_DIR="$HOME/.claude/projects/$(printf '%s' "$HARNESS" | sed 's#[/ ]#-#g')"
export MIST_NOTIFY_SOURCE="routine $DIR"
SESSION_ID=""
run_claude() {
	local tmp pid wd remaining
	remaining=$(( DEADLINE - $(date +%s) ))
	if [ "$remaining" -le 0 ]; then
		OUT="routine budget of ${TIMEOUT_SEC}s spent before this attempt"; RC=124; TIMED_OUT=1
		return
	fi
	# A fresh id per attempt: the CLI refuses to reuse one that already exists.
	SESSION_ID="$(uuidgen | tr 'A-Z' 'a-z')"
	export MIST_NOTIFY_CONTEXT="Scheduled routine '$DIR' on ${MODEL:-the default model}, started $(date '+%Y-%m-%d %H:%M'), attempt $attempt. Its full transcript is Claude Code session $SESSION_ID (file $CLI_PROJECT_DIR/$SESSION_ID.jsonl); read that for everything the routine did and saw. Routine log: $HOME/Library/Logs/mist-routines.log."
	tmp="$(mktemp -t routine-out)"
	"$CLAUDE" -p --dangerously-skip-permissions --permission-prompts none --session-id "$SESSION_ID" ${MODEL_ARGS[@]+"${MODEL_ARGS[@]}"} "$PROMPT" >"$tmp" 2>&1 &
	pid=$!
	( sleep "$remaining"; kill -TERM "$pid" 2>/dev/null && { sleep 10; kill -KILL "$pid" 2>/dev/null; } ) &
	wd=$!
	wait "$pid"; RC=$?
	pkill -P "$wd" 2>/dev/null; kill "$wd" 2>/dev/null; wait "$wd" 2>/dev/null
	[ "$(date +%s)" -ge "$DEADLINE" ] && [ "$RC" -ne 0 ] && TIMED_OUT=1
	OUT="$(cat "$tmp")"; rm -f "$tmp"
}

# Seconds until the reset time in a session-limit message ("resets 11:40pm
# (America/Chicago)" or "resets 3pm"), plus a minute of slack. Empty when the
# message carries no parseable time.
limit_wait_seconds() {
	local line hh mm ap tz target now
	line="$(printf '%s' "$1" | grep -oiE 'resets [0-9]{1,2}(:[0-9]{2})? ?(am|pm)( \([A-Za-z_/]+\))?' | head -1)"
	[ -n "$line" ] || return 0
	hh="$(printf '%s' "$line" | sed -E 's/^[Rr]esets ([0-9]{1,2}).*/\1/')"
	mm="$(printf '%s' "$line" | grep -oE ':[0-9]{2}' | tr -d ':')"; mm="${mm:-00}"
	ap="$(printf '%s' "$line" | grep -oiE '(am|pm)' | head -1 | tr '[:lower:]' '[:upper:]')"
	tz="$(printf '%s' "$line" | grep -oE '\([A-Za-z_/]+\)' | tr -d '()')"
	# An empty TZ means UTC to date(1), so only override it when the message names a zone.
	[ -n "$tz" ] || tz="${TZ:-$(readlink /etc/localtime | sed 's|.*/zoneinfo/||')}"
	now=$(date +%s)
	target=$(TZ="$tz" date -j -f '%Y-%m-%d %I:%M:%S%p' "$(TZ="$tz" date +%Y-%m-%d) $hh:$mm:00$ap" +%s 2>/dev/null) || return 0
	[ "$target" -le "$now" ] && target=$(( target + 86400 ))
	echo $(( target - now + 60 ))
}

attempt=0
while :; do
	attempt=$((attempt + 1))
	set +e
	run_claude
	set -e
	printf '%s\n' "$OUT"

	if [ "$TIMED_OUT" -eq 1 ]; then
		echo "[$(date '+%Y-%m-%d %H:%M:%S')] $DIR: killed after the ${TIMEOUT_SEC}s routine budget (rc=$RC); flagging."
		[ -x "$NOTIFY" ] && "$NOTIFY" "$DIR hung and was killed after $((TIMEOUT_SEC / 60)) min." \
			"MIST routine timeout" Basso "$HOME/Library/Logs/mist-routines.log" || true
		exit 124
	fi

	# Checked BEFORE the rc=0 path on purpose: a session that lost its connectors
	# still exits 0. Treat it exactly like a transient network failure, because
	# that is what it is -- the run is incomplete and a later fire should retry.
	if printf '%s' "$OUT" | grep -q 'ROUTINE_ABORT_CONNECTORS_MISSING'; then
		if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
			backoff=$((attempt * 30))
			echo "[$(date '+%Y-%m-%d %H:%M:%S')] $DIR — aborted: required connectors missing from the session, attempt $attempt/$MAX_ATTEMPTS; retrying in ${backoff}s."
			sleep "$backoff"
			continue
		fi
		echo "[$(date '+%Y-%m-%d %H:%M:%S')] $DIR — required connectors still missing after $MAX_ATTEMPTS attempts; incomplete rather than failed."
		[ "${ROUTINE_SIGNAL_TRANSIENT:-0}" = "1" ] && exit 75
		exit 0
	fi

	if [ "$RC" -eq 0 ]; then
		exit 0
	fi

	# Genuine config/auth failures — these SHOULD stick as FAIL so they get fixed.
	# Never retry these; retrying a bad credential just wastes minutes.
	if [ "$RC" -eq 78 ] || printf '%s' "$OUT" | grep -qiE 'not logged in|invalid api key|authentication_error|please run .*login'; then
		echo "[$(date '+%Y-%m-%d %H:%M:%S')] $DIR — genuine config/auth failure (rc=$RC); leaving FAIL flag for investigation."
		exit "$RC"
	fi

	# Out of usage credits on the selected model: switch models, don't wait.
	# Checked before the transient block because the two want opposite
	# handling. Applies to routines on the CLI default too: the worst case
	# there is one wasted re-run when the default already is the fallback.
	#
	# Sits below the rc=0 early exit on purpose. The CLI exits 1 on credit
	# exhaustion (verified against claude -p on 2026-09-08), so nothing is
	# missed, and keeping it here means a routine that merely WRITES the
	# phrase in its output can never trigger a duplicate run.
	if printf '%s' "$OUT" | grep -qiE "$CREDITS_RE"; then
		if [ "$FELL_BACK" -eq 0 ] && [ -n "$FALLBACK_MODEL" ] && [ "$MODEL" != "$FALLBACK_MODEL" ]; then
			echo "[$(date '+%Y-%m-%d %H:%M:%S')] $DIR: out of usage credits on ${MODEL:-the default model}; falling back to $FALLBACK_MODEL and re-running."
			MODEL="$FALLBACK_MODEL"
			MODEL_ARGS=(--model "$FALLBACK_MODEL")
			FELL_BACK=1
			# The model switch is not a retry of the same thing, so it does not
			# spend one of the transient attempts.
			attempt=$((attempt - 1))
			continue
		fi
		# Nothing left to fall back to. Credits refill on their own, so this is
		# transient rather than broken, but it kills every routine until it
		# clears, which is worth a banner.
		echo "[$(date '+%Y-%m-%d %H:%M:%S')] $DIR: out of usage credits on $MODEL with no fallback left (rc=$RC); incomplete rather than failed."
		[ -x "$NOTIFY" ] && "$NOTIFY" \
			"$DIR could not run: out of usage credits on $MODEL and on the fallback." \
			"MIST routine blocked" Basso "https://claude.ai/settings/usage" || true
		[ "${ROUTINE_SIGNAL_TRANSIENT:-0}" = "1" ] && exit 75
		exit 0
	fi

	# Session limit: it resets at a stated clock time, often hours away, so the
	# 30/60 s backoff below could never outlast it. Sleep until the reset (cap
	# 3 h), once, then retry; past the cap, give up as transient. Banner once.
	if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -qi 'session limit'; then
		WAIT_S="$(limit_wait_seconds "$OUT")"
		CAP=$(( ${ROUTINE_LIMIT_WAIT_CAP_SEC:-10800} ))
		if [ "$LIMIT_WAITED" -eq 0 ] && [ -n "$WAIT_S" ] && [ "$WAIT_S" -le "$CAP" ]; then
			LIMIT_WAITED=1
			UNTIL="$(date -r $(( $(date +%s) + WAIT_S )) '+%H:%M')"
			echo "[$(date '+%Y-%m-%d %H:%M:%S')] $DIR: session limit hit; sleeping ${WAIT_S}s until $UNTIL, then retrying once."
			[ -x "$NOTIFY" ] && "$NOTIFY" "$DIR hit the session limit; it will retry at $UNTIL." \
				"MIST routine waiting" Purr "https://claude.ai/settings/usage" || true
			sleep "$WAIT_S"
			DEADLINE=$(( DEADLINE + WAIT_S ))
			attempt=$((attempt - 1))
			continue
		fi
		echo "[$(date '+%Y-%m-%d %H:%M:%S')] $DIR: session limit hit (reset ${WAIT_S:-unparsed}s away, cap ${CAP}s, already waited: $LIMIT_WAITED); incomplete rather than failed."
		[ "$LIMIT_WAITED" -eq 0 ] && [ -x "$NOTIFY" ] && "$NOTIFY" "$DIR could not run: session limit, reset too far off to wait for." \
			"MIST routine blocked" Basso "https://claude.ai/settings/usage" || true
		[ "${ROUTINE_SIGNAL_TRANSIENT:-0}" = "1" ] && exit 75
		exit 0
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
