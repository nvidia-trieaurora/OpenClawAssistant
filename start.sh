#!/usr/bin/env bash
# NemoClaw Local Startup — one command to start everything
#
# Usage:
#   ./start.sh              # start all services
#   ./start.sh --status     # check status
#   ./start.sh --stop       # stop all services
#   ./start.sh --services   # start only bridges (no sandbox)
#   ./start.sh --onboard    # re-run onboard wizard

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
DIM='\033[2m'
NC='\033[0m'

info()  { echo -e "${GREEN}[nemoclaw]${NC} $1"; }
warn()  { echo -e "${YELLOW}[nemoclaw]${NC} $1"; }
fail()  { echo -e "${RED}[nemoclaw]${NC} $1"; exit 1; }

# ── Load .env ────────────────────────────────────────────────────
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi

ACTION="${1:-start}"

# ── Status ───────────────────────────────────────────────────────
if [ "$ACTION" = "--status" ]; then
  echo ""
  echo -e "  ${CYAN}NemoClaw Status${NC}"
  echo -e "  ${DIM}──────────────────────────────────────${NC}"

  # OpenShell gateway
  if openshell status 2>&1 | grep -q "Connected"; then
    echo -e "  ${GREEN}●${NC} Gateway      connected"
  else
    echo -e "  ${RED}●${NC} Gateway      disconnected"
  fi

  # Sandbox
  if openshell sandbox list 2>&1 | grep -q "Ready"; then
    echo -e "  ${GREEN}●${NC} Sandbox      ready"
  else
    echo -e "  ${RED}●${NC} Sandbox      not running"
  fi

  # Services
  for svc in dashboard mcp-bridge cursor-agent-bridge telegram-bridge; do
    pidfile="/tmp/nemoclaw-services-${SANDBOX_NAME:-my-assistant}/$svc.pid"
    if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
      echo -e "  ${GREEN}●${NC} $svc"
    else
      echo -e "  ${RED}●${NC} $svc"
    fi
  done

  # MCP Bridge servers
  if curl -s http://127.0.0.1:${MCP_BRIDGE_PORT:-18790}/ 2>/dev/null | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  n=len(d.get('servers',[]))
  print(f'  \033[0;32m●\033[0m MCP Servers   {n} connected')
except:
  print('  \033[0;31m●\033[0m MCP Servers   unavailable')
" 2>/dev/null; then
    true
  else
    echo -e "  ${RED}●${NC} MCP Servers   unavailable"
  fi

  echo -e "  ${DIM}──────────────────────────────────────${NC}"
  echo -e "  Dashboard:  http://localhost:${DASHBOARD_PORT:-3333}"
  echo -e "  Chat UI:    http://localhost:18789"
  echo ""
  exit 0
fi

# ── Stop ─────────────────────────────────────────────────────────
if [ "$ACTION" = "--stop" ]; then
  info "Stopping services..."
  bash "$SCRIPT_DIR/scripts/start-services.sh" --stop 2>/dev/null || true

  if openshell sandbox list 2>&1 | grep -q "Ready"; then
    info "Sandbox still running (use 'nemoclaw my-assistant stop' to stop sandbox)"
  fi
  info "Done."
  exit 0
fi

# ── Onboard ──────────────────────────────────────────────────────
if [ "$ACTION" = "--onboard" ]; then
  [ -n "${NVIDIA_API_KEY:-}" ] || fail "Set NVIDIA_API_KEY in .env first"
  export NVIDIA_API_KEY
  nemoclaw onboard
  exit 0
fi

# ── Services only ────────────────────────────────────────────────
if [ "$ACTION" = "--services" ]; then
  [ -n "${NVIDIA_API_KEY:-}" ] || fail "Set NVIDIA_API_KEY in .env first"
  info "Starting services only (no sandbox)..."
  export NVIDIA_API_KEY
  bash "$SCRIPT_DIR/scripts/start-services.sh"
  exit 0
fi

# ── Full start ───────────────────────────────────────────────────
if [ "$ACTION" = "start" ] || [ "$ACTION" = "--start" ]; then
  echo ""
  echo -e "  ${CYAN}╔═══════════════════════════════════════╗${NC}"
  echo -e "  ${CYAN}║   NemoClaw — Personal AI Agent Stack  ║${NC}"
  echo -e "  ${CYAN}╚═══════════════════════════════════════╝${NC}"
  echo ""

  # Check prerequisites
  command -v node   > /dev/null || fail "Node.js not found"
  command -v docker > /dev/null || fail "Docker not found"

  if ! docker info > /dev/null 2>&1; then
    fail "Docker is not running. Start Docker Desktop first."
  fi

  [ -n "${NVIDIA_API_KEY:-}" ] || fail "Set NVIDIA_API_KEY in .env first (get from https://build.nvidia.com/settings/api-keys)"

  # 1. Check if nemoclaw CLI is linked
  if ! command -v nemoclaw > /dev/null 2>&1; then
    info "Linking nemoclaw CLI..."
    (cd "$SCRIPT_DIR/nemoclaw" && npm install && npm run build) > /dev/null 2>&1
    (cd "$SCRIPT_DIR" && npm install --ignore-scripts && npm link) > /dev/null 2>&1
  fi

  # 2. Check if sandbox exists
  if ! grep -q "my-assistant" ~/.nemoclaw/sandboxes.json 2>/dev/null; then
    info "No sandbox found. Running onboard..."
    export NVIDIA_API_KEY
    nemoclaw onboard --non-interactive
  fi

  # 3. Start OpenShell gateway if not running
  if ! openshell status 2>&1 | grep -q "Connected"; then
    info "Starting OpenShell gateway..."
    openshell daemon start 2>/dev/null || true
    sleep 2
  fi

  # 4. Start/connect sandbox
  if ! openshell sandbox list 2>&1 | grep -q "Ready"; then
    info "Starting sandbox..."
    nemoclaw my-assistant launch 2>/dev/null || true
    sleep 3
  fi

  # 5. Ensure port forwarding for Chat UI
  if ! curl -s -o /dev/null --max-time 2 http://127.0.0.1:18789/ 2>/dev/null; then
    info "Forwarding port 18789 (Chat UI)..."
    openshell forward start 18789 my-assistant --background 2>/dev/null || true
    sleep 2
  fi

  # 6. Start auxiliary services
  info "Starting services..."
  export NVIDIA_API_KEY
  bash "$SCRIPT_DIR/scripts/start-services.sh"

  # 6. Print summary
  echo ""
  echo -e "  ${GREEN}All systems running.${NC}"
  echo ""
  echo -e "  Dashboard:   ${CYAN}http://localhost:${DASHBOARD_PORT:-3333}${NC}"
  echo -e "  Chat UI:     ${CYAN}http://localhost:18789${NC}"
  echo -e "  MCP Bridge:  ${CYAN}http://localhost:${MCP_BRIDGE_PORT:-18790}${NC}"
  echo ""
  echo -e "  ${DIM}./start.sh --status    check status${NC}"
  echo -e "  ${DIM}./start.sh --stop      stop all${NC}"
  echo ""
  exit 0
fi

echo "Usage: ./start.sh [--start|--stop|--status|--services|--onboard]"
exit 1
