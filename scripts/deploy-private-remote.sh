#!/usr/bin/env bash
set -euo pipefail

revision=${1:?A release commit is required}
archive_name=${2:?An archive name is required}
[[ $revision =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid release commit.' >&2; exit 1; }
[[ $archive_name =~ ^coup-online-[0-9a-f]{40}-[0-9a-f-]+\.tar$ ]] || { echo 'Invalid archive name.' >&2; exit 1; }

root="$HOME/.coup-online"
release="$root/releases/$revision"
archive="$root/uploads/$revision/$archive_name"
[[ -f $archive ]] || { echo 'Release archive is missing.' >&2; exit 1; }
tar -xf "$archive" -C "$release"
rm -f -- "$archive"

if ! command -v docker >/dev/null || ! sudo docker compose version >/dev/null 2>&1; then
  . /etc/os-release
  if [[ $ID != ubuntu || $VERSION_ID != 24.04 ]]; then
    echo 'Automatic Docker installation supports Ubuntu 24.04 only.' >&2
    exit 1
  fi
  sudo apt-get update
  sudo apt-get install -y docker.io docker-compose-v2 curl
  sudo systemctl enable --now docker
fi
if ! command -v curl >/dev/null; then
  sudo apt-get update
  sudo apt-get install -y curl
fi
if ! sudo docker info >/dev/null 2>&1; then
  sudo systemctl start docker
  sudo docker info >/dev/null
fi

cd "$release"
echo "Building $revision before replacing the running app..."
sudo env BUILDKIT_PROGRESS=plain docker compose -p coup-online -f compose.yaml build app
sudo docker compose -p coup-online -f compose.yaml up -d --no-build app

for ((attempt = 1; attempt <= 30; attempt++)); do
  if curl -fsS --max-time 2 http://127.0.0.1:8787/healthz 2>/dev/null | grep -qx ok; then
    printf '%s\n' "$revision" > "$root/current"
    echo "Server health check passed for $revision."
    exit 0
  fi
  sleep 2
done

echo "Health check failed for $revision." >&2
if [[ -f $root/current ]]; then
  echo "Last healthy revision: $(cat "$root/current")" >&2
fi
sudo docker compose -p coup-online -f compose.yaml logs --tail=100 app >&2
# ponytail: Releases remain on disk for manual redeploy; add pruning if disk usage grows.
exit 1
