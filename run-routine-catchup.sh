#!/bin/bash
# run-routine-catchup.sh <routine-dir> <HH:MM> [cutoff-HH:MM]
# Wrapper around run-routine.sh for routines that SHOULD catch up on wake if the
# machine was asleep at their scheduled time (e.g. the morning briefing: a late
# briefing beats no briefing). Runs at most once per calendar day, and only the
# latest slot, so a multi-day sleep produces exactly ONE run, not a backlog.
#
# launchd fires a missed StartCalendarInterval job once when the machine wakes
# (and RunAtLoad fires it on login/boot). This wrapper decides whether that fire
# should actually run:
#   - skip if it already ran today (per-day marker)      -> no double runs
#   - skip if we are before today's scheduled time       -> no overnight/dark-wake runs
#   - skip if we are past the optional cutoff time        -> too stale to bother
#   - otherwise run, and stamp the marker with today
set -e
DIR="$1"
SCHED="$2"                 # e.g. "08:00"
CUTOFF="$3"                # optional latest run time, e.g. "18:00"; empty = no ceiling
[ -n "$DIR" ] && [ -n "$SCHED" ] || { echo "usage: run-routine-catchup.sh <dir> <HH:MM> [cutoff-HH:MM]"; exit 2; }

today=$(date +%Y-%m-%d)
now_epoch=$(date +%s)
sched_epoch=$(date -j -f "%Y-%m-%d %H:%M" "$today $SCHED" +%s)

marker_dir="$HOME/.mist/routine-markers"
marker="$marker_dir/$DIR.lastrun"
mkdir -p "$marker_dir"

# Already ran today? Don't run again — "only the latest one".
if [ -f "$marker" ] && [ "$(cat "$marker" 2>/dev/null)" = "$today" ]; then
	echo "[$(date '+%Y-%m-%d %H:%M:%S')] SKIP $DIR — already ran today ($today)."
	exit 0
fi

# Before today's scheduled time (e.g. a 3am dark-wake fire)? Wait for the real slot.
if [ "$now_epoch" -lt "$sched_epoch" ]; then
	echo "[$(date '+%Y-%m-%d %H:%M:%S')] SKIP $DIR — before scheduled $SCHED today; not an on-wake catch-up."
	exit 0
fi

# Past the cutoff? A morning briefing at dinnertime is too stale to be useful.
if [ -n "$CUTOFF" ]; then
	cutoff_epoch=$(date -j -f "%Y-%m-%d %H:%M" "$today $CUTOFF" +%s)
	if [ "$now_epoch" -gt "$cutoff_epoch" ]; then
		echo "[$(date '+%Y-%m-%d %H:%M:%S')] SKIP $DIR — past cutoff $CUTOFF; too stale for a catch-up run."
		exit 0
	fi
fi

# Concurrency guard: an atomic mkdir lock, so two near-simultaneous fires (the
# 08:00 StartCalendarInterval tick + a RunAtLoad on login at 08:00:xx) can't both
# run. Held for the whole run, released on any exit. This replaces the old
# "stamp the day-marker BEFORE exec" trick — which prevented double-runs but also
# burned the day on a transient failure (marker said "ran today", so no fire ever
# retried, and a dropped connection meant NO briefing at all: the 2026-07-20
# incident). Now the marker is stamped only AFTER a genuinely complete run.
lock="$marker_dir/$DIR.lock"
if ! mkdir "$lock" 2>/dev/null; then
	# Lock held. Distinguish a live run from a stale lock left by a hard-killed
	# run (crash/reboot) so we don't block the briefing forever: if the lock dir
	# is older than 60 min (well beyond any real run), reclaim it and proceed.
	lock_age=$(( now_epoch - $(stat -f %m "$lock" 2>/dev/null || echo "$now_epoch") ))
	if [ "$lock_age" -gt 3600 ]; then
		echo "[$(date '+%Y-%m-%d %H:%M:%S')] $DIR — reclaiming stale lock ($lock, ${lock_age}s old)."
		rmdir "$lock" 2>/dev/null
		mkdir "$lock" 2>/dev/null || { echo "[$(date '+%Y-%m-%d %H:%M:%S')] SKIP $DIR — lock race after reclaim; backing off."; exit 0; }
	else
		echo "[$(date '+%Y-%m-%d %H:%M:%S')] SKIP $DIR — another run holds the lock ($lock, ${lock_age}s old); not double-running."
		exit 0
	fi
fi
trap 'rmdir "$lock" 2>/dev/null' EXIT

# Run (possibly a late catch-up). Signal transient-incomplete via exit 75 so we
# can tell "finished" from "gave up after a network blip".
diff_min=$(( (now_epoch - sched_epoch) / 60 ))
echo "[$(date '+%Y-%m-%d %H:%M:%S')] RUN $DIR — scheduled $SCHED, Δ ${diff_min}m (catch-up ok)."
set +e
ROUTINE_SIGNAL_TRANSIENT=1 /bin/bash "$HOME/Documents/mist-console/run-routine.sh" "$DIR"
rc=$?
set -e

if [ "$rc" -eq 75 ]; then
	# Transient failure that outlived the in-process retries. Leave the marker
	# UNSTAMPED so the next launchd fire (a later wake, or tomorrow's 08:00) tries
	# again — as long as we're still inside today's [SCHED, CUTOFF] window. Stay
	# quiet (exit 0) so the session-start hook doesn't light a stale FAIL for a
	# blip that isn't a broken routine.
	echo "[$(date '+%Y-%m-%d %H:%M:%S')] $DIR — transient-incomplete (rc=75); marker left unstamped so a later fire retries."
	exit 0
fi

# Reaching here means either success or a genuine failure. Either way, stamp the
# day-marker: on success we're done; on a genuine (config/auth/unknown) failure
# we don't want to re-run all day — the nonzero exit surfaces it as a FAIL to fix.
echo "$today" > "$marker"
exit "$rc"
