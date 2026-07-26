#!/bin/bash
# run-routine-ontime.sh <routine-dir> <window-start HH:MM> <window-end HH:MM>
# run-routine-ontime.sh <routine-dir> <HH:MM> [grace-minutes]        (legacy form)
#
# Wrapper around run-routine.sh for time-sensitive routines, where a stale
# catch-up run is worse than no run at all. launchd fires a missed
# StartCalendarInterval job once the machine wakes from sleep; this wrapper
# decides whether that fire still lands inside the routine's acceptable window.
#
# Window form (preferred): the routine may run ANY time between start and end,
# so the plist can carry several fires inside that band (a primary slot plus
# retry slots). A per-day marker keeps that to exactly ONE completed run per
# day: the first fire that finishes stamps the day, later fires skip.
#
# Legacy grace form: <HH:MM> plus N minutes of tolerance, 5 minutes of negative
# jitter allowed. Kept so older plists keep working.
#
# Transient failures are signalled by run-routine.sh as exit 75 (EX_TEMPFAIL).
# Those leave the marker UNSTAMPED, so the next fire inside the window retries.
# That is the difference between "a network blip at 22:00" and "no wind-down at
# all for the day" (the 2026-07-25 incident: 3 transient failures, gave up at
# 00:13, nothing ever retried).
set -e
DIR="$1"
START="$2"
THIRD="$3"
[ -n "$DIR" ] && [ -n "$START" ] || { echo "usage: run-routine-ontime.sh <dir> <start HH:MM> <end HH:MM|grace-min>"; exit 2; }

today=$(date +%Y-%m-%d)
now_epoch=$(date +%s)

if [[ "$THIRD" =~ ^[0-9]{1,2}:[0-9]{2}$ ]]; then
	# Window form: [START, END] on today's clock.
	WIN_DESC="window $START-$THIRD"
	start_epoch=$(date -j -f "%Y-%m-%d %H:%M" "$today $START" +%s)
	end_epoch=$(date -j -f "%Y-%m-%d %H:%M" "$today $THIRD" +%s)
else
	# Legacy grace form: [SCHED - 5min, SCHED + GRACE].
	GRACE="${THIRD:-15}"
	WIN_DESC="scheduled $START (grace ${GRACE}m)"
	sched_epoch=$(date -j -f "%Y-%m-%d %H:%M" "$today $START" +%s)
	start_epoch=$(( sched_epoch - 300 ))
	end_epoch=$(( sched_epoch + GRACE * 60 ))
fi

marker_dir="$HOME/.mist/routine-markers"
marker="$marker_dir/$DIR.lastrun"
mkdir -p "$marker_dir"

# Already completed today? Later fires in the window are retry slots, not extra
# runs. Nothing to do.
if [ -f "$marker" ] && [ "$(cat "$marker" 2>/dev/null)" = "$today" ]; then
	echo "[$(date '+%Y-%m-%d %H:%M:%S')] SKIP $DIR. Already ran today ($today)."
	exit 0
fi

# Outside the window (a 3am dark-wake, or a wake so late the run would be stale)?
# Skip. No catch-up outside the band.
if [ "$now_epoch" -lt "$start_epoch" ] || [ "$now_epoch" -gt "$end_epoch" ]; then
	echo "[$(date '+%Y-%m-%d %H:%M:%S')] SKIP $DIR. Outside $WIN_DESC. No catch-up run."
	exit 0
fi

# Concurrency guard: atomic mkdir lock held for the whole run, so two fires close
# together (a retry slot landing while the primary is still working) can't both
# run. Locks older than 60 min are stale leftovers from a hard-killed run and get
# reclaimed, so a crash can't block the routine forever.
lock="$marker_dir/$DIR.lock"
if ! mkdir "$lock" 2>/dev/null; then
	lock_age=$(( now_epoch - $(stat -f %m "$lock" 2>/dev/null || echo "$now_epoch") ))
	if [ "$lock_age" -gt 3600 ]; then
		echo "[$(date '+%Y-%m-%d %H:%M:%S')] $DIR. Reclaiming stale lock ($lock, ${lock_age}s old)."
		rmdir "$lock" 2>/dev/null
		mkdir "$lock" 2>/dev/null || { echo "[$(date '+%Y-%m-%d %H:%M:%S')] SKIP $DIR. Lock race after reclaim; backing off."; exit 0; }
	else
		echo "[$(date '+%Y-%m-%d %H:%M:%S')] SKIP $DIR. Another run holds the lock ($lock, ${lock_age}s old); not double-running."
		exit 0
	fi
fi
trap 'rmdir "$lock" 2>/dev/null' EXIT

echo "[$(date '+%Y-%m-%d %H:%M:%S')] RUN $DIR. Inside $WIN_DESC."
set +e
ROUTINE_SIGNAL_TRANSIENT=1 /bin/bash "$HOME/Documents/mist-console/run-routine.sh" "$DIR"
rc=$?
set -e

if [ "$rc" -eq 75 ]; then
	# Transient failure that outlived the in-process retries. Leave the marker
	# unstamped so the next fire inside today's window tries again, and stay quiet
	# (exit 0) so the session-start hook doesn't light a FAIL for a network blip.
	echo "[$(date '+%Y-%m-%d %H:%M:%S')] $DIR transient-incomplete (rc=75); marker left unstamped so a later fire in $WIN_DESC retries."
	exit 0
fi

# Success, or a genuine (config/auth/unknown) failure. Either way stamp the day:
# on success we're done, and on a real failure we don't want to re-run all night.
# The nonzero exit surfaces it as a FAIL to fix.
echo "$today" > "$marker"
exit "$rc"
