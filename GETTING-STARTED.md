# Getting Started

Personal NemoClaw deployment — quick reference for starting, stopping, and managing the stack.

## Prerequisites

- **Docker Desktop** running
- **Node.js** >= 20
- **OpenShell CLI** installed (`openshell --version`)
- **NVIDIA API Key** from [build.nvidia.com/settings/api-keys](https://build.nvidia.com/settings/api-keys)

## First Time Setup

```bash
cd /Users/tlle/Documents/PersonalProject/NemoClaw

# 1. Install dependencies and link CLI
npm install --ignore-scripts
cd nemoclaw && npm install && npm run build && cd ..
npm link

# 2. Set your API key
# Edit .env and paste your NVIDIA_API_KEY
open .env

# 3. Run onboard (creates gateway + sandbox — takes ~5 min)
./start.sh
```

## Daily Commands

```bash
./start.sh              # Start everything (gateway + sandbox + services)
./start.sh --status     # Check what's running
./start.sh --stop       # Stop all services
./start.sh --services   # Start only bridges (MCP, dashboard, cursor agent)
```

## Access Points

| URL | What |
|-----|------|
| `http://localhost:3333` | Dashboard — system overview, MCP servers, quick actions |
| `http://127.0.0.1:18789/#token=<TOKEN>` | Chat UI — talk to the AI agent (token required) |
| `http://localhost:18790` | MCP Bridge — lists connected MCP servers |

The Chat UI token is stored in `.env` as `CHAT_UI_TOKEN`. It changes each time `nemoclaw onboard` runs.

## Sandbox Commands

```bash
# Connect to sandbox terminal
nemoclaw my-assistant connect

# Chat via TUI inside sandbox
openclaw tui

# Send a single message
openclaw agent --agent main --local -m "hello" --session-id test

# Check sandbox status
nemoclaw my-assistant status

# View sandbox logs
nemoclaw my-assistant logs --follow

# Add a policy preset (interactive)
nemoclaw my-assistant policy-add

# List applied policies
nemoclaw my-assistant policy-list
```

## Service Management

```bash
# Start/stop auxiliary services independently
bash scripts/start-services.sh
bash scripts/start-services.sh --stop
bash scripts/start-services.sh --status
```

Individual services can also be run directly for debugging:

```bash
node scripts/dashboard.js          # Dashboard on :3333
node scripts/mcp-bridge.js         # MCP Bridge on :18790
node scripts/cursor-agent-bridge.js # Cursor Agent on :18792
```

## OpenShell / Gateway Commands

```bash
# Gateway lifecycle
openshell gateway start            # Start the gateway
openshell status                   # Check gateway status

# Sandbox management
openshell sandbox list             # List sandboxes
openshell forward start 18789 my-assistant   # Forward Chat UI port
openshell forward stop 18789 my-assistant    # Stop forwarding

# Monitor network requests (approve/deny)
openshell term
```

## Git Workflow

```bash
# Sync latest from upstream NVIDIA/NemoClaw
git fetch upstream
git rebase upstream/main

# Push to personal repo
git push origin personal/tlle
```

Remotes:
- `origin` — `https://github.com/nvidia-trieaurora/OpenClawAssistant.git`
- `upstream` — `https://github.com/NVIDIA/NemoClaw.git`
- Branch: `personal/tlle`

## Brev Cloud Deployment

```bash
# Option 1: CLI deploy
nemoclaw deploy my-gpu-box

# Option 2: Brev Launchable (web UI)
# Repo: https://github.com/nvidia-trieaurora/OpenClawAssistant.git
# Branch: personal/tlle
# Startup script: scripts/brev-setup.sh
```

## Ports Reference

| Port | Service |
|------|---------|
| 3333 | Dashboard |
| 18789 | OpenClaw Chat UI |
| 18790 | MCP Bridge (HTTP) |
| 18791 | MCP Bridge (HTTPS) |
| 18792 | Cursor Agent Bridge |

## Environment Variables (.env)

| Variable | Required | Description |
|----------|----------|-------------|
| `NVIDIA_API_KEY` | Yes | API key for inference |
| `CHAT_UI_TOKEN` | Yes | Auth token for Chat UI (from sandbox) |
| `DASHBOARD_PORT` | No | Dashboard port (default: 3333) |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token from @BotFather |
| `NOTION_API_KEY` | No | Notion integration token |
| `SANDBOX_NAME` | No | Sandbox name (default: my-assistant) |

## Troubleshooting

**Gateway won't connect:**
```bash
openshell gateway start
# If port 8080 conflict:
openshell gateway destroy -g nemoclaw
nemoclaw onboard --non-interactive --yes-i-accept-third-party-software
```

**Sandbox not ready:**
```bash
nemoclaw onboard --non-interactive --yes-i-accept-third-party-software
```

**Chat UI shows "device identity required":**
Open with token URL — not the plain `http://127.0.0.1:18789`.

**MCP servers not showing:**
Check VPN is connected, then:
```bash
curl -s http://localhost:18790/ | python3 -m json.tool
```

**Docker errors:**
Ensure Docker Desktop is running and has at least 8 GB RAM allocated.

**Token changed after rebuild:**
```bash
# Extract new token from sandbox
openshell sandbox ssh-config my-assistant > /tmp/ssh.conf
ssh -T -F /tmp/ssh.conf openshell-my-assistant \
  "cat /sandbox/.openclaw/openclaw.json" | python3 -c \
  "import sys,json; print(json.load(sys.stdin)['gateway']['auth']['token'])"
# Update CHAT_UI_TOKEN in .env
```
