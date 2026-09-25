#!/usr/bin/env bash
# Variables in the remote ssh commands are meant to expand locally.
# shellcheck disable=SC2029
# Test, build and publish the site to the VPS with no downtime: each deploy
# uploads to a new release folder, then switches the `current` symlink.
#
#   VPS_HOST=203.0.113.10 ./deploy/deploy.sh
#
# Optional: VPS_USER (default deploy), VPS_PORT (22), APP_DIR (/var/www/threadvet),
# KEEP (5 releases kept for rollback), SSH_KEY (path to a private key),
# SKIP_TESTS=1 (CI sets this because its test job already ran them),
# ALLOW_DOMAIN_MISMATCH=1 (deploy even if the build's domain differs from the server's),
# STRICT_HOST_KEYS=1 (refuse unknown host keys instead of trusting on first use).
# Roll back with ./deploy/rollback.sh.
set -euo pipefail

# shellcheck source=deploy/ssh-common.sh
source "$(dirname "$0")/ssh-common.sh"
KEEP="${KEEP:-5}"
if ! [[ "$KEEP" =~ ^[1-9][0-9]*$ ]]; then
  echo "KEEP must be 1 or more (it includes the live release)." >&2
  exit 1
fi

for tool in node npm ssh rsync; do
  command -v "$tool" >/dev/null || { echo "Missing '$tool'. Install it and try again." >&2; exit 1; }
done

cd "$(dirname "$0")/.."
[[ "${SKIP_TESTS:-}" == 1 ]] || npm test
npm run build
SITE_HOST="$(node -e "import('./site.config.mjs').then((m) => console.log(new URL(m.default.url).host))")"
echo "==> Built for https://$SITE_HOST"

# UTC timestamp first (so names sort by age) plus a random suffix, so two
# deploys in the same second never share a folder.
RELEASE="$(date -u +%Y%m%d%H%M%S)-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"

# Refuse to publish a build whose canonical URLs point at another domain
# (setup-vps.sh records the domain it configured).
SERVER_DOMAIN="$(ssh "${SSH_OPTS[@]}" "$TARGET" "cat '$APP_DIR/DOMAIN' 2>/dev/null || true")"
if [[ -n "$SERVER_DOMAIN" && "$SERVER_DOMAIN" != "$SITE_HOST" && "${ALLOW_DOMAIN_MISMATCH:-}" != 1 ]]; then
  echo "This build is for $SITE_HOST but the server is set up for $SERVER_DOMAIN." >&2
  echo "Set SITE_URL=https://$SERVER_DOMAIN (or edit url in site.config.mjs) and deploy again." >&2
  exit 1
fi

# Upload into a hidden .incoming- folder that only becomes a release once the
# upload has fully succeeded, so a dropped connection never leaves a broken
# folder that pruning or a rollback could pick up.
INCOMING="$APP_DIR/releases/.incoming-$RELEASE"
cleanup() { ssh "${SSH_OPTS[@]}" "$TARGET" "rm -rf '$INCOMING'" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> Uploading release $RELEASE"
ssh "${SSH_OPTS[@]}" "$TARGET" "mkdir '$INCOMING'"
# rsync splits -e itself and honors double quotes (not backslashes), so
# quote each option to survive spaces, e.g. in an SSH_KEY path.
RSYNC_RSH="ssh"
for opt in "${SSH_OPTS[@]}"; do RSYNC_RSH+=" \"$opt\""; done
# --chmod keeps the release readable by nginx whatever the local umask is.
rsync -rlptz --chmod=D755,F644 -e "$RSYNC_RSH" dist/ "$TARGET:$INCOMING/"

echo "==> Switching to release $RELEASE"
# Runs on the server, after the helpers in remote-lib.sh. The quoted heredoc is
# sent as-is (no local expansion); values arrive as arguments.
# 1. Pages already open in a browser still reference older hashed CSS/JS:
#    copy forward the previous build's files (from its manifest) plus any it
#    carried from builds in the last day (back-to-back deploys). cp -p keeps
#    build times, so carried files age out after a day.
# 2. Switch the `current` symlink atomically.
# 3. Prune: release names start with a UTC timestamp, so name order is age
#    order. Keep the newest $KEEP and never touch the one `current` points to.
{ cat "$(dirname "$0")/remote-lib.sh"; cat <<'REMOTE'; } | ssh "${SSH_OPTS[@]}" "$TARGET" "bash -s -- $(printf '%q ' "$APP_DIR" "$RELEASE" "$KEEP")"
set -eu
app=$1 release=$2 keep=$3
new="$app/releases/$release"
mv -T "$app/releases/.incoming-$release" "$new"
# Until the switch below succeeds, a failure removes this never-live release.
switched=0
trap '[ "$switched" = 1 ] || rm -rf "$new"' EXIT
# Leftovers from uploads that died before this script ran.
find "$app/releases" -maxdepth 1 -name '.incoming-*' -mmin +60 -exec rm -rf {} +
prev=$(readlink -f "$app/current" || true)
if [ -d "$prev/assets" ]; then
  {
    grep -oE '[a-z]+\.[0-9a-f]{10}\.(js|css)' "$prev/assets/manifest.json" 2>/dev/null || true
    find "$prev/assets" -maxdepth 1 -type f -newermt '1 day ago' -printf '%f\n'
  } | grep -E '^[a-z]+\.[0-9a-f]{10}\.(js|css)$' | sort -u | while read -r f; do
    [ -e "$new/assets/$f" ] || cp -p "$prev/assets/$f" "$new/assets/$f"
  done
fi
switch_to "$app" "$release"
switched=1
live=$(basename "$(readlink -f "$app/current")")
cd "$app/releases"
release_names "$app" | tail -n +"$((keep + 1))" | grep -vx "$live" | xargs -r rm -rf --
# setup-vps.sh's "Coming soon" page is not a rollback target once a real release is live.
[ "$live" = placeholder ] || rm -rf placeholder
REMOTE

trap - EXIT
echo "==> Live: release $RELEASE"
