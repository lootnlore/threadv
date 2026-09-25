# Server-side helpers for deploy.sh and rollback.sh. Each script sends this
# file ahead of its own remote commands; it is never run on your computer.
# shellcheck shell=sh

# Release folder names, newest first (a UTC timestamp, then a random suffix).
release_names() {
  for dir in "$1"/releases/*/; do
    name=$(basename "$dir")
    printf '%s\n' "$name" | grep -Eq '^[0-9]{14}(-[0-9a-f]+)?$' && printf '%s\n' "$name"
  done | sort -r
}

# Point `current` at a release with no moment where the site is missing.
switch_to() {
  ln -sfn "$1/releases/$2" "$1/current.next"
  mv -Tf "$1/current.next" "$1/current"
}
