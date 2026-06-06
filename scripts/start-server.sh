#!/usr/bin/env bash
# pi-memory-server start/stop/restart script
# Usage: ./scripts/start.sh [start|stop|restart|status]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$PROJECT_DIR/logs"
PID_FILE="$LOG_DIR/pi-memory-server.pid"

# Build log filename with date
LOG_FILE="$LOG_DIR/pi-memory-server_$(date '+%Y%m%d').log"

# Load nvm for non-interactive shell
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Ensure log directory exists
mkdir -p "$LOG_DIR"

cd $PROJECT_DIR

start() {
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo "[pi-memory-server] Already running (PID: $(cat "$PID_FILE"))"
        return 0
    fi

    echo "[pi-memory-server] Starting..."
    nohup node --import jiti/register "$SCRIPT_DIR/pi-memory-server.ts" \
        >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    sleep 1

    if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo "[pi-memory-server] Started (PID: $(cat "$PID_FILE"))"
        echo "[pi-memory-server] Log: $LOG_FILE"
    else
        echo "[pi-memory-server] Failed to start. Check log: $LOG_FILE"
        return 1
    fi
}

stop() {
    if [ ! -f "$PID_FILE" ]; then
        echo "[pi-memory-server] Not running (no PID file)"
        return 0
    fi

    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        echo "[pi-memory-server] Stopping (PID: $PID)..."
        kill "$PID"
        # Wait up to 10 seconds for graceful shutdown
        for i in $(seq 1 10); do
            kill -0 "$PID" 2>/dev/null || break
            sleep 1
        done
        # Force kill if still running
        kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null
        rm -f "$PID_FILE"
        echo "[pi-memory-server] Stopped"
    else
        echo "[pi-memory-server] Process $PID not found, cleaning up"
        rm -f "$PID_FILE"
    fi
}

status() {
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo "[pi-memory-server] Running (PID: $(cat "$PID_FILE"))"
    else
        echo "[pi-memory-server] Not running"
    fi
}

case "${1:-start}" in
    start)  start ;;
    stop)   stop ;;
    restart) stop && sleep 1 && start ;;
    status) status ;;
    *)
        echo "Usage: $0 {start|stop|restart|status}"
        exit 1
        ;;
esac
