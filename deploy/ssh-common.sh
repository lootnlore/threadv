# Shared SSH settings for deploy.sh and rollback.sh (sourced, not run).
#
# Reads: VPS_HOST (required), VPS_USER (deploy), VPS_PORT (22),
# APP_DIR (/var/www/threadvet), SSH_KEY (private key path),
# STRICT_HOST_KEYS=1 (refuse unknown host keys; CI sets this).
# Sets: VPS_USER, VPS_PORT, APP_DIR, SSH_OPTS, TARGET.
# shellcheck shell=bash
# shellcheck disable=SC2034  # the variables are used by the scripts that source this file

: "${VPS_HOST:?Set VPS_HOST to the server IP address or hostname}"
VPS_USER="${VPS_USER:-deploy}"
VPS_PORT="${VPS_PORT:-22}"
APP_DIR="${APP_DIR:-/var/www/threadvet}"

# accept-new trusts a server's host key the first time (like answering "yes")
# but still refuses a key that changes later. CI sets STRICT_HOST_KEYS=1 so it
# only ever talks to the host key pinned in its secrets.
HOST_KEYS=accept-new
[[ "${STRICT_HOST_KEYS:-}" == 1 ]] && HOST_KEYS=yes
SSH_OPTS=(-p "$VPS_PORT" -o BatchMode=yes -o StrictHostKeyChecking="$HOST_KEYS")
[[ -n "${SSH_KEY:-}" ]] && SSH_OPTS+=(-i "$SSH_KEY")
TARGET="$VPS_USER@$VPS_HOST"
