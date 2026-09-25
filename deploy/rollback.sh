#!/usr/bin/env bash
# Switch the live site to an earlier release, atomically (no request ever
# sees a missing site). Releases are the ones deploy.sh keeps.
#
#   VPS_HOST=203.0.113.10 ./deploy/rollback.sh            # back to the previous release
#   VPS_HOST=203.0.113.10 ./deploy/rollback.sh --list     # show releases, newest first
#   VPS_HOST=203.0.113.10 ./deploy/rollback.sh <release>  # a specific one from --list
#
# Uses the same VPS_USER, VPS_PORT, APP_DIR, SSH_KEY settings as deploy.sh.
# Values in the remote command are meant to expand locally.
# shellcheck disable=SC2029
set -euo pipefail
# shellcheck source=deploy/ssh-common.sh
source "$(dirname "$0")/ssh-common.sh"

# Releases you roll back from are marked, so a later plain rollback never
# picks a known-bad release again (naming one explicitly still works).
{ cat "$(dirname "$0")/remote-lib.sh"; cat <<'REMOTE'; } | ssh "${SSH_OPTS[@]}" "$TARGET" "bash -s -- $(printf '%q ' "$APP_DIR" "${1:-}")"
set -eu
app=$1 want=$2
live=$(basename "$(readlink -f "$app/current")")
releases=$(release_names "$app")
if [ "$want" = "--list" ]; then
  for r in $releases; do
    note=""
    [ "$r" = "$live" ] && note="  <- live"
    [ -e "$app/releases/$r/.rolled-back" ] && note="$note  (rolled back from)"
    echo "$r$note"
  done
  exit 0
fi
if [ -z "$want" ]; then
  # The newest release older than the live one that was not rolled back from.
  seen=0
  for r in $releases; do
    if [ "$seen" = 1 ] && [ ! -e "$app/releases/$r/.rolled-back" ]; then
      want=$r
      break
    fi
    [ "$r" = "$live" ] && seen=1
  done
  if [ -z "$want" ]; then
    echo "No good release older than $live to roll back to. Run with --list." >&2
    exit 1
  fi
fi
if ! printf '%s\n' $releases | grep -qx -- "$want"; then
  echo "No release named $want. Run with --list to see them." >&2
  exit 1
fi
switch_to "$app" "$want"
[ "$live" = "$want" ] || touch "$app/releases/$live/.rolled-back"
rm -f "$app/releases/$want/.rolled-back"
echo "Live: $want (was $live)"
REMOTE
