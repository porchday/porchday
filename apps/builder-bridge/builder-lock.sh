#!/bin/bash
# Shared builder lock between builder chat turns and the request-file loop.
# Same file format as src/lock.ts: owner=, pid= and started= lines, created
# exclusively. Shell holders record pid=0 and become stale after
# PORCHDAY_LOCK_STALE_SECONDS (default 3600).
#
#   builder-lock.sh acquire [--wait] [owner]   exit 0 when held, 1 when busy
#   builder-lock.sh release [owner]            removes the lock if this owner holds it
#   builder-lock.sh status
set -u
lock=${PORCHDAY_BUILDER_LOCK:-$HOME/.porchday-builder.lock}
stale=${PORCHDAY_LOCK_STALE_SECONDS:-3600}
field() { sed -n "s/^$1=//p" "$lock" 2>/dev/null | head -n 1; }
is_stale() {
  local pid started now
  pid=$(field pid); started=$(field started); now=$(date +%s)
  [ -z "$started" ] && started=$(stat -f %m "$lock" 2>/dev/null || stat -c %Y "$lock" 2>/dev/null || echo "$now")
  if [ "${pid:-0}" -gt 0 ] 2>/dev/null; then ! ps -p "$pid" >/dev/null 2>&1
  else [ $((now - started)) -gt "$stale" ]; fi
}
try_acquire() {
  if (set -C; printf 'owner=%s\npid=0\nstarted=%s\n' "$1" "$(date +%s)" > "$lock") 2>/dev/null; then return 0; fi
  if is_stale; then rm -f "$lock"; (set -C; printf 'owner=%s\npid=0\nstarted=%s\n' "$1" "$(date +%s)" > "$lock") 2>/dev/null && return 0; fi
  return 1
}
case "${1:-}" in
  acquire)
    shift; wait=0
    if [ "${1:-}" = "--wait" ]; then wait=1; shift; fi
    owner=${1:-request-file}
    until try_acquire "$owner"; do
      [ "$wait" = 1 ] || { echo "busy: held by $(field owner)"; exit 1; }
      sleep 5
    done
    echo "acquired $lock as $owner" ;;
  release)
    owner=${2:-request-file}
    if [ "$(field owner)" = "$owner" ] && [ "$(field pid)" = "0" ]; then rm -f "$lock"; echo "released"; else echo "not held by $owner"; fi ;;
  status)
    if [ -e "$lock" ]; then echo "held by $(field owner) (pid $(field pid)) since $(field started)"; else echo "free"; fi ;;
  *) echo "Usage: $0 acquire [--wait] [owner] | release [owner] | status" >&2; exit 2 ;;
esac
