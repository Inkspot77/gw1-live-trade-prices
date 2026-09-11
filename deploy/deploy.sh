#!/usr/bin/env bash
# One-shot deploy: sync this project to an Ubuntu server, then build and
# start the dashboard with Docker Compose over SSH.
#
# Usage:
#   bash deploy/deploy.sh user@server [--dir /path/on/server] [--backfill] [--lan]
#
# Environment: DEPLOY_HOST / DEPLOY_DIR can replace the positional args.
#
# Prerequisites:
#   - rsync on this machine; Docker + the compose plugin on the server
#     (docker compose version must work — see deploy/DEPLOY.md to install).
#   - The SSH user must be able to write the target directory and run
#     docker (add them to the docker group if needed).
#
# Behaviour:
#   - Excludes .git, .freebuff and the local prices.db* — the server builds
#     its own history in the gw1-data volume (name kept as-is across the
#     EctoWatch rename so existing deployments keep their data; run with
#     --backfill once for a 90-day NPC-trader baseline).
#   - Excludes Caddyfile after the first deploy. It holds the LAN password
#     hash, which is set once on the server (see deploy/DEPLOY.md) — every
#     later deploy must leave it alone, or it would keep getting overwritten
#     by this checkout's own unset placeholder hash.
#   - The compose file binds 127.0.0.1:8787, so reach the dashboard with
#     ssh -N -L 8787:127.0.0.1:8787 user@server, or edit the port mapping
#     after reading the no-authentication note in deploy/DEPLOY.md.
set -euo pipefail

usage() {
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

HOST=""
DIR=""
BACKFILL=0
LAN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)       DIR="$2"; shift 2 ;;
    --backfill)  BACKFILL=1; shift ;;
    --lan)       LAN=1; shift ;;
    -h|--help)   usage ;;
    -*)
      echo "Unknown option: $1" >&2
      usage 1
      ;;
    *)
      [[ -z "$HOST" ]] || { echo "Unexpected argument: $1" >&2; usage 1; }
      HOST="$1"
      shift
      ;;
  esac
done

HOST="${HOST:-${DEPLOY_HOST:-}}"
DIR="${DIR:-${DEPLOY_DIR:-ectowatch}}"

if [[ -z "$HOST" ]]; then
  echo "Missing server. Usage: bash deploy/deploy.sh user@server [--dir /path] [--backfill]" >&2
  exit 1
fi

command -v rsync >/dev/null || { echo "rsync is not installed locally." >&2; exit 1; }

echo "==> Checking ${HOST}"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" true \
  || { echo "Cannot reach ${HOST} (is key-based SSH set up?)." >&2; exit 1; }
ssh "$HOST" "
  command -v docker >/dev/null || { echo 'docker is not installed on the server.' >&2; exit 1; }
  docker compose version >/dev/null || { echo 'the compose plugin is missing (docker compose version fails).' >&2; exit 1; }
"

echo "==> Syncing project to ${HOST}:${DIR}"
CADDYFILE_EXISTS=$(ssh "$HOST" "[ -f '${DIR}/Caddyfile' ] && echo yes || echo no")
rsync -a \
  --exclude .git \
  --exclude .freebuff \
  --exclude 'data/prices.db*' \
  --exclude Caddyfile \
  ./ "${HOST}:${DIR}/"

if [[ "$CADDYFILE_EXISTS" == "no" ]]; then
  echo "==> First deploy: copying the Caddyfile template (still has the placeholder password)"
  rsync -a Caddyfile "${HOST}:${DIR}/Caddyfile"
  if [[ "$LAN" -eq 1 ]]; then
    echo "    Set a real password before it's usable — see deploy/DEPLOY.md's" >&2
    echo "    'change the LAN password' step, then re-run with --lan." >&2
  fi
else
  echo "==> Leaving the server's existing Caddyfile alone (has your real password hash)"
fi

COMPOSE="docker compose up -d --build"
if [[ "$LAN" -eq 1 ]]; then
  COMPOSE="docker compose --profile lan up -d --build"
  echo "==> Building and starting on ${HOST} (lan profile: Caddy HTTPS basic auth on :8787)"
else
  echo "==> Building and starting on ${HOST}"
fi
ssh "$HOST" "cd '${DIR}' && ${COMPOSE}"

# Caddyfile is a bind mount, so compose cannot see content changes and will
# not recreate the proxy on its own — always bounce it so a new Caddyfile
# (password hash, hostnames, TLS) actually takes effect. Force-recreate
# rather than restart: a plain restart trusts the container's existing mount
# to already reflect the current file, which does not always hold — we hit a
# container whose bind mount had gone stale (13 days old, content frozen at
# whatever the file held on creation) and `restart`/`caddy reload` both kept
# reading the stale copy. Recreating the container re-establishes the mount
# from scratch, so this can't happen regardless of the container's history.
if [[ "$LAN" -eq 1 ]]; then
  echo "==> Recreating caddy to pick up Caddyfile changes"
  ssh "$HOST" "cd '${DIR}' && docker compose --profile lan up -d --force-recreate caddy"
fi

if [[ "$BACKFILL" -eq 1 ]]; then
  echo "==> Seeding 90 days of NPC trader history (resumable — Ctrl-C when the summary prints; the container keeps serving afterwards)"
  ssh "$HOST" "cd '${DIR}' && docker compose --profile tools run --rm backfill"
fi

echo
echo "Deployed. Dashboard: ssh -N -L 8788:127.0.0.1:8788 ${HOST}, then http://127.0.0.1:8788"
if [[ "$LAN" -eq 1 ]]; then
  echo "           LAN: https://<hostname>:8787 (HTTPS, basic auth — trust the CA, see deploy/DEPLOY.md)"
fi
