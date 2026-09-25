#!/usr/bin/env bash
# One-time server setup for ThreadVet on an Ubuntu or Debian VPS (for example
# a Spaceship VPS). Installs nginx + Let's Encrypt, creates a key-only
# "deploy" user, and serves the site from /var/www/threadvet/current.
#
# Copy the deploy/ folder to the server, then run as root:
#   DOMAIN=threadvet.com EMAIL=you@example.com bash deploy/setup-vps.sh
#
# The certificate covers DOMAIN and www.DOMAIN (which redirects to DOMAIN), so
# both need DNS records. On a subdomain with no www record, such as
# calc.example.com, add WWW=0.
#
# The deploy user only accepts SSH keys. Put your public key in
# deploy/deploy_key.pub before copying the folder (or pass DEPLOY_PUBKEY)
# and it is installed for you.
#
# Safe to re-run. It never removes other nginx sites. If your server runs a
# control panel (cPanel, CyberPanel, Plesk...) or Apache on ports 80/443,
# don't use this script: upload dist/ to that site's document root instead.
set -euo pipefail

: "${DOMAIN:?Set DOMAIN, e.g. DOMAIN=threadvet.com}"
: "${EMAIL:?Set EMAIL for HTTPS certificate notices}"
# The domain goes into the nginx config, sed and certbot as-is, so accept only
# a plain lowercase hostname (www. is added for you).
if ! [[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])$ ]] || [[ "$DOMAIN" == www.* ]]; then
  echo "DOMAIN must be a bare lowercase domain like threadvet.com (no https://, www. or path)." >&2
  exit 1
fi
WWW="${WWW:-1}"
if [[ "$WWW" != 0 && "$WWW" != 1 ]]; then
  echo "WWW must be 1 (also serve www.$DOMAIN, the default) or 0." >&2
  exit 1
fi
CERT_NAMES=(-d "$DOMAIN")
[[ $WWW == 1 ]] && CERT_NAMES+=(-d "www.$DOMAIN")
DEPLOY_USER="${DEPLOY_USER:-deploy}"
APP_DIR=/var/www/threadvet
HERE="$(cd "$(dirname "$0")" && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root (sudo -i first)." >&2
  exit 1
fi
if ! command -v apt-get >/dev/null; then
  echo "This script supports Ubuntu/Debian (apt). See README for manual steps." >&2
  exit 1
fi
if ss -ltnp 2>/dev/null | grep -E ':(80|443)\s' | grep -qv nginx; then
  echo "Something other than nginx is using port 80/443. Stop it or use its document root instead." >&2
  exit 1
fi

echo "==> Installing nginx, certbot and rsync"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nginx certbot python3-certbot-nginx rsync logrotate

echo "==> Creating deploy user '$DEPLOY_USER' (SSH key login only)"
if ! id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$DEPLOY_USER"
fi
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
KEYS="/home/$DEPLOY_USER/.ssh/authorized_keys"
touch "$KEYS"
chown "$DEPLOY_USER:$DEPLOY_USER" "$KEYS"
chmod 600 "$KEYS"
PUBKEY="${DEPLOY_PUBKEY:-}"
[[ -z "$PUBKEY" && -f "$HERE/deploy_key.pub" ]] && PUBKEY="$(cat "$HERE/deploy_key.pub")"
if [[ -n "$PUBKEY" ]]; then
  if ! [[ "$PUBKEY" =~ ^(ssh-|ecdsa-|sk-) ]]; then
    echo "DEPLOY_PUBKEY / deploy_key.pub doesn't look like an SSH public key (.pub file)." >&2
    exit 1
  fi
  if grep -qxF "$PUBKEY" "$KEYS"; then
    echo "    Deploy key already present."
  else
    echo "$PUBKEY" >> "$KEYS"
    echo "    Deploy key installed."
  fi
fi

echo "==> Preparing $APP_DIR"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR" "$APP_DIR/releases"
# Missing, or a link to a release that no longer exists: serve a placeholder.
if [[ ! -e "$APP_DIR/current" ]]; then
  install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR/releases/placeholder"
  echo "<!doctype html><title>$DOMAIN</title><p>Coming soon.</p>" > "$APP_DIR/releases/placeholder/index.html"
  cp "$APP_DIR/releases/placeholder/index.html" "$APP_DIR/releases/placeholder/404.html"
  chown -R "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR/releases/placeholder"
  ln -sfn "$APP_DIR/releases/placeholder" "$APP_DIR/current"
  chown -h "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR/current"
fi

echo "==> Installing nginx site for $DOMAIN"
SNIPPET=/etc/nginx/snippets/threadvet-security.conf
enable_hsts() { sed -i 's|^# add_header Strict-Transport-Security|add_header Strict-Transport-Security|' "$SNIPPET"; }
# certbot --redirect moves port 80 into server blocks of its own, which would
# log to nginx's default files (kept ~15 days, not the 14 the privacy policy
# promises) and show the nginx version. Give them the site's settings.
own_redirect_blocks() {
  local file=$1
  grep -q '# threadvet: redirect block' "$file" && return 0
  sed -i -E 's|^([[:space:]]*)return 404; # managed by Certbot|\1access_log /var/log/threadvet/access.log; # threadvet: redirect block\n\1error_log /var/log/threadvet/error.log;\n\1server_tokens off;\n&|' "$file"
}
# True when the certificate already on this server covers every requested name.
cert_covers() {
  local pem="/etc/letsencrypt/live/$DOMAIN/cert.pem" sans name
  [[ -f $pem ]] || return 1
  sans="$(openssl x509 -in "$pem" -noout -ext subjectAltName 2>/dev/null)" || return 1
  for name in "$@"; do
    [[ $name == -d ]] && continue
    grep -qE "DNS:${name//./\\.}(,|$)" <<<"$sans" || return 1
  done
}
# certbot writes plain "listen 443 ssl;" lines. HTTP/2 loads the site's many
# small files over one connection: nginx 1.25.1+ takes "http2 on;", older
# versions a flag on the listen line. Safe to re-run.
enable_http2() {
  local file=$1 version
  grep -q 'http2' "$file" && return 0
  version="$(nginx -v 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1)"
  if [[ "$(printf '%s\n' 1.25.1 "$version" | sort -V | head -n1)" == 1.25.1 ]]; then
    sed -i -E 's/^([[:space:]]*)listen 443 ssl;.*$/&\n\1http2 on;/' "$file"
  else
    sed -i -E 's/listen (\[::\]:)?443 ssl( ipv6only=on)?;/listen \1443 ssl http2\2;/' "$file"
  fi
}
HSTS_WAS_ON=0
grep -q '^add_header Strict-Transport-Security' "$SNIPPET" 2>/dev/null && HSTS_WAS_ON=1
install -m 644 "$HERE/nginx/threadvet-security.conf" "$SNIPPET"
# A re-run keeps HSTS on even if certbot fails below.
[[ $HSTS_WAS_ON == 1 ]] && enable_hsts
# Site logs get their own folder and 14-day rotation (see the privacy policy).
# Owned by root, not www-data: nginx's root master process opens these files,
# so a folder the web user could write to would let it plant a symlink and
# get root to write anywhere (CVE-2016-1247).
install -d -m 0755 -o root -g adm /var/log/threadvet
install -m 644 "$HERE/logrotate/threadvet" /etc/logrotate.d/threadvet
SITE=/etc/nginx/sites-available/threadvet
BACKUP=""
HAD_HTTPS=0
if [[ -f "$SITE" ]] && grep -q "ssl_certificate" "$SITE" && [[ "${FORCE_NGINX:-}" != 1 ]]; then
  if ! grep -qE "server_name[[:space:]]+${DOMAIN//./\\.};" "$SITE"; then
    echo "nginx is set up for a different domain. To switch it to $DOMAIN, re-run with FORCE_NGINX=1." >&2
    exit 1
  fi
  echo "    $SITE already has HTTPS (certbot), so it is left as is."
  echo "    To apply changes from deploy/nginx/threadvet.conf, re-run with FORCE_NGINX=1"
  echo "    (certbot re-adds HTTPS; the old file is restored if that fails)."
else
  if [[ -f "$SITE" ]]; then
    BACKUP="$SITE.bak.$(date +%s)"
    cp "$SITE" "$BACKUP"
    grep -q "ssl_certificate" "$BACKUP" && HAD_HTTPS=1
  fi
  sed "s/threadvet\.com/$DOMAIN/g" "$HERE/nginx/threadvet.conf" > "$SITE"
fi
ln -sf "$SITE" /etc/nginx/sites-enabled/threadvet
if ! nginx -t; then
  if [[ -n "$BACKUP" ]]; then
    echo "The new nginx config failed its check: restoring the previous one." >&2
    cp "$BACKUP" "$SITE"
  fi
  exit 1
fi
systemctl enable --now nginx
# When replacing an HTTPS config, keep nginx on the old one until certbot has
# added HTTPS to the new file (certbot reloads nginx itself).
[[ $HAD_HTTPS == 1 ]] || systemctl reload nginx

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  echo "==> Opening HTTP/HTTPS in ufw"
  ufw allow 'Nginx Full'
fi

if [[ $WWW == 1 ]]; then
  echo "==> Requesting HTTPS certificate (DNS for $DOMAIN and www.$DOMAIN must point here; WWW=0 skips www)"
else
  echo "==> Requesting HTTPS certificate (DNS for $DOMAIN must point here)"
fi
# Replacing an HTTPS config whose certificate is already on this server:
# install that certificate into the new file. No new challenge runs, so nginx
# never serves the HTTPS-less file and 443 stays up; renewals carry on as usual.
# (Only when it covers every name: adding www later needs a new certificate,
# which --expand requests without prompting.)
if [[ $HAD_HTTPS == 1 ]] && cert_covers "${CERT_NAMES[@]}"; then
  CERTBOT=(certbot install --nginx --non-interactive --cert-name "$DOMAIN" --redirect)
else
  CERTBOT=(certbot --nginx --non-interactive --agree-tos --keep-until-expiring --expand -m "$EMAIL" --redirect "${CERT_NAMES[@]}")
fi
if ! "${CERTBOT[@]}"; then
  if [[ $HAD_HTTPS == 1 ]]; then
    echo "certbot failed: restoring the previous HTTPS nginx config." >&2
    cp "$BACKUP" "$SITE"
    nginx -t
    systemctl reload nginx
  fi
  exit 1
fi

# deploy.sh checks every build is for the domain nginx now serves.
echo "$DOMAIN" > "$APP_DIR/DOMAIN"

echo "==> Enabling HTTP/2 and HSTS now that HTTPS works"
cp "$SITE" "$SITE.pre-http2"
own_redirect_blocks "$SITE"
enable_http2 "$SITE"
if ! nginx -t 2>/dev/null; then
  echo "    This nginx rejected the final touches (HTTP/2, redirect logging); continuing without them." >&2
  cp "$SITE.pre-http2" "$SITE"
fi
rm -f "$SITE.pre-http2"
enable_hsts
# Separate commands: under set -e a failing `nginx -t` must stop the script.
nginx -t
systemctl reload nginx

if [[ -s "$KEYS" ]]; then
  NEXT="From the repo on your computer:  SSH_KEY=~/.ssh/threadvet_deploy VPS_HOST=<server IP> ./deploy/deploy.sh"
else
  NEXT="No deploy key yet: add your .pub key to $KEYS (or re-run with DEPLOY_PUBKEY), then deploy."
fi
echo
echo "Done. $NEXT"
