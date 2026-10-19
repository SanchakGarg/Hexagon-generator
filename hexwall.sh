#!/usr/bin/env bash
# Hexagon Wall Planner control script: install | start | stop | restart | update | status | logs
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="hexwall:latest"
CONTAINER="hexwall"
PORT="${HEXWALL_PORT:-8080}"

cd "$APP_DIR"

say() { printf '\033[1;33m[hexwall]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[hexwall]\033[0m %s\n' "$*" >&2; exit 1; }

ensure_docker() {
  command -v docker >/dev/null 2>&1 || die "Docker is not installed. Get it from https://docs.docker.com/get-docker/"
  docker info >/dev/null 2>&1 && return
  if [[ "$(uname)" == "Darwin" && -d /Applications/Docker.app ]]; then
    say "Starting Docker Desktop..."
    open -a Docker
    for _ in $(seq 1 60); do
      docker info >/dev/null 2>&1 && return
      sleep 2
    done
  fi
  die "The Docker daemon is not running. Start Docker and try again."
}

container_exists() { docker container inspect "$CONTAINER" >/dev/null 2>&1; }
container_running() { [[ "$(docker container inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" == "true" ]]; }

build() {
  say "Building image $IMAGE..."
  docker build -t "$IMAGE" "$APP_DIR"
}

cmd_install() {
  ensure_docker
  build
  say "Installed. Run ./hexwall.sh start"
}

cmd_start() {
  ensure_docker
  docker image inspect "$IMAGE" >/dev/null 2>&1 || build
  if container_running; then
    say "Already running at http://localhost:$PORT"
    return
  fi
  container_exists && docker rm "$CONTAINER" >/dev/null
  docker run -d --name "$CONTAINER" -p "$PORT:80" --restart unless-stopped "$IMAGE" >/dev/null
  say "Running at http://localhost:$PORT"
}

cmd_stop() {
  ensure_docker
  if container_exists; then
    docker rm -f "$CONTAINER" >/dev/null
    say "Stopped."
  else
    say "Not running."
  fi
}

cmd_update() {
  if git -C "$APP_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if git -C "$APP_DIR" remote | grep -q .; then
      say "Pulling latest changes..."
      git -C "$APP_DIR" pull --ff-only
    else
      say "No git remote configured; skipping git pull."
    fi
  else
    say "Not a git repository; skipping git pull."
  fi
  ensure_docker
  local was_running=false
  container_running && was_running=true
  build
  if $was_running; then
    docker rm -f "$CONTAINER" >/dev/null
    cmd_start
  else
    say "Updated. Run ./hexwall.sh start"
  fi
}

cmd_status() {
  ensure_docker
  if container_running; then
    say "Running at http://localhost:$PORT"
    docker ps --filter "name=^${CONTAINER}$" --format '  {{.Status}}  {{.Ports}}'
  else
    say "Not running."
  fi
}

cmd_logs() {
  ensure_docker
  container_exists || die "No container yet. Run ./hexwall.sh start"
  docker logs -f "$CONTAINER"
}

usage() {
  cat <<EOF
Usage: ./hexwall.sh <command>

  install   build the Docker image
  start     start the site (builds the image first if needed)
  stop      stop and remove the container
  restart   stop, then start
  update    git pull (if a remote exists), rebuild, restart if it was running
  status    show whether the site is running
  logs      follow the server logs

Port: HEXWALL_PORT (default 8080), e.g. HEXWALL_PORT=9000 ./hexwall.sh start
EOF
}

case "${1:-}" in
  install) cmd_install ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_stop; cmd_start ;;
  update) cmd_update ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  ""|help|-h|--help) usage ;;
  *) usage; exit 1 ;;
esac
