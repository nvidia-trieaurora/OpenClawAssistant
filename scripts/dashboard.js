#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * NemoClaw Dashboard — personal web interface for managing the NemoClaw stack.
 *
 * Provides:
 *   - System status overview (sandbox, services, MCP bridge)
 *   - MCP server connection map
 *   - Quick actions (restart services, open chat, view logs)
 *   - Embedded chat proxy to OpenClaw Control UI
 *
 * Env:
 *   DASHBOARD_PORT        — listen port (default: 3000)
 *   SANDBOX_PORT          — OpenClaw control UI port (default: 18789)
 *   MCP_BRIDGE_PORT       — MCP bridge port (default: 18790)
 *   CURSOR_BRIDGE_PORT    — Cursor agent bridge port (default: 18792)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const os = require("os");

const PORT = parseInt(process.env.DASHBOARD_PORT || "3000", 10);
const SANDBOX_PORT = parseInt(process.env.SANDBOX_PORT || "18789", 10);
const MCP_BRIDGE_PORT = parseInt(process.env.MCP_BRIDGE_PORT || "18790", 10);
const CURSOR_BRIDGE_PORT = parseInt(process.env.CURSOR_BRIDGE_PORT || "18792", 10);
const CHAT_UI_TOKEN = process.env.CHAT_UI_TOKEN || "";
let cachedToken = CHAT_UI_TOKEN;

function readChatUiToken() {
  if (cachedToken) return cachedToken;
  try {
    const { execFileSync } = require("child_process");
    const sandboxName = process.env.SANDBOX_NAME || "my-assistant";
    const confDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dash-"));
    const confPath = path.join(confDir, "config");
    const sshConf = execFileSync("openshell", ["sandbox", "ssh-config", sandboxName], { encoding: "utf-8", timeout: 5000 });
    fs.writeFileSync(confPath, sshConf, { mode: 0o600 });
    const configJson = execFileSync("ssh", ["-T", "-F", confPath, "-o", "ConnectTimeout=5", `openshell-${sandboxName}`, "cat /sandbox/.openclaw/openclaw.json"], { encoding: "utf-8", timeout: 10000 });
    fs.unlinkSync(confPath); fs.rmdirSync(confDir);
    const token = JSON.parse(configJson)?.gateway?.auth?.token || "";
    if (token) cachedToken = token;
    return token;
  } catch {
    return "";
  }
}

function checkPort(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 2000 }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ up: true, data: JSON.parse(data) }); }
        catch { resolve({ up: true, data }); }
      });
    });
    req.on("error", () => resolve({ up: false }));
    req.on("timeout", () => { req.destroy(); resolve({ up: false }); });
  });
}

function checkPortSimple(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/`, { timeout: 2000 }, (res) => {
      resolve({ up: res.statusCode < 500 });
    });
    req.on("error", () => resolve({ up: false }));
    req.on("timeout", () => { req.destroy(); resolve({ up: false }); });
  });
}

async function getSystemStatus() {
  const [sandbox, mcpBridge, cursorBridge] = await Promise.all([
    checkPortSimple(SANDBOX_PORT),
    checkPort(MCP_BRIDGE_PORT),
    checkPort(CURSOR_BRIDGE_PORT),
  ]);

  let openshellStatus = "unknown";
  try {
    const out = execSync("openshell status 2>&1", { encoding: "utf-8", timeout: 5000 });
    openshellStatus = out.includes("Connected") ? "connected" : "disconnected";
  } catch { openshellStatus = "unavailable"; }

  let sandboxList = [];
  try {
    const out = execSync("openshell sandbox list 2>&1", { encoding: "utf-8", timeout: 5000 });
    if (out.includes("Ready")) sandboxList.push({ name: "default", status: "ready" });
  } catch {}

  let mcpServers = [];
  if (mcpBridge.up && mcpBridge.data?.servers) {
    mcpServers = mcpBridge.data.servers;
  }

  const token = readChatUiToken();

  return {
    timestamp: new Date().toISOString(),
    gateway: openshellStatus,
    sandbox: { up: sandbox.up, port: SANDBOX_PORT, list: sandboxList, token },
    mcpBridge: { up: mcpBridge.up, port: MCP_BRIDGE_PORT, servers: mcpServers },
    cursorBridge: { up: cursorBridge.up, port: CURSOR_BRIDGE_PORT },
    system: {
      hostname: os.hostname(),
      platform: os.platform(),
      uptime: Math.floor(os.uptime()),
      memory: {
        total: Math.round(os.totalmem() / 1024 / 1024 / 1024 * 10) / 10,
        free: Math.round(os.freemem() / 1024 / 1024 / 1024 * 10) / 10,
      },
    },
  };
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NemoClaw Dashboard</title>
<style>
  :root {
    --bg-primary: #0a0a0b;
    --bg-secondary: #111113;
    --bg-card: #16161a;
    --bg-card-hover: #1a1a1f;
    --border: #2a2a30;
    --border-subtle: #1e1e24;
    --text-primary: #e4e4e7;
    --text-secondary: #a1a1aa;
    --text-muted: #71717a;
    --accent: #76b900;
    --accent-dim: rgba(118,185,0,0.15);
    --red: #ef4444;
    --red-dim: rgba(239,68,68,0.15);
    --yellow: #eab308;
    --yellow-dim: rgba(234,179,8,0.15);
    --blue: #3b82f6;
    --blue-dim: rgba(59,130,246,0.15);
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif;
    background: var(--bg-primary);
    color: var(--text-primary);
    min-height: 100vh;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 24px;
    border-bottom: 1px solid var(--border-subtle);
    background: var(--bg-secondary);
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .logo {
    width: 28px; height: 28px;
    background: var(--accent);
    border-radius: 6px;
    display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 14px; color: #000;
  }

  .header h1 {
    font-size: 16px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .header h1 span { color: var(--text-muted); font-weight: 400; }

  .header-right {
    display: flex; align-items: center; gap: 8px;
  }

  .refresh-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-secondary);
    padding: 6px 12px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    transition: all 0.15s;
  }

  .refresh-btn:hover {
    background: var(--bg-card);
    color: var(--text-primary);
  }

  .main {
    max-width: 1200px;
    margin: 0 auto;
    padding: 24px;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
  }

  .card {
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
    padding: 20px;
    transition: all 0.15s;
  }

  .card:hover {
    border-color: var(--border);
    background: var(--bg-card-hover);
  }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
  }

  .card-title {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .status-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    display: inline-block;
  }

  .status-dot.up { background: var(--accent); box-shadow: 0 0 6px var(--accent); }
  .status-dot.down { background: var(--red); box-shadow: 0 0 6px var(--red); }
  .status-dot.unknown { background: var(--yellow); }

  .card-value {
    font-size: 24px;
    font-weight: 600;
    margin-bottom: 4px;
  }

  .card-detail {
    font-size: 13px;
    color: var(--text-muted);
  }

  .section-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-secondary);
    margin-bottom: 12px;
    padding-left: 4px;
  }

  .mcp-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 10px;
    margin-bottom: 24px;
  }

  .mcp-item {
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    padding: 14px 16px;
    display: flex;
    align-items: center;
    gap: 10px;
    transition: all 0.15s;
  }

  .mcp-item:hover {
    border-color: var(--border);
    background: var(--bg-card-hover);
  }

  .mcp-icon {
    width: 32px; height: 32px;
    border-radius: 6px;
    display: flex; align-items: center; justify-content: center;
    font-size: 14px; font-weight: 600;
    flex-shrink: 0;
  }

  .mcp-icon.nvidia { background: var(--accent-dim); color: var(--accent); }
  .mcp-icon.external { background: var(--blue-dim); color: var(--blue); }
  .mcp-icon.local { background: var(--yellow-dim); color: var(--yellow); }

  .mcp-info { flex: 1; min-width: 0; }
  .mcp-name {
    font-size: 13px; font-weight: 500;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .mcp-type {
    font-size: 11px; color: var(--text-muted);
    text-transform: uppercase; letter-spacing: 0.04em;
  }

  .mcp-item { cursor: pointer; }

  .modal-overlay {
    display: none;
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.6);
    backdrop-filter: blur(4px);
    z-index: 100;
    align-items: center; justify-content: center;
  }
  .modal-overlay.active { display: flex; }

  .modal {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 12px;
    width: 90%; max-width: 520px;
    max-height: 80vh;
    overflow-y: auto;
    padding: 24px;
    position: relative;
  }

  .modal-close {
    position: absolute; top: 12px; right: 16px;
    background: none; border: none; color: var(--text-muted);
    font-size: 20px; cursor: pointer; padding: 4px 8px;
  }
  .modal-close:hover { color: var(--text-primary); }

  .modal h2 {
    font-size: 16px; font-weight: 600; margin-bottom: 16px;
    display: flex; align-items: center; gap: 10px;
  }

  .modal-field {
    margin-bottom: 12px;
  }
  .modal-label {
    font-size: 11px; color: var(--text-muted);
    text-transform: uppercase; letter-spacing: 0.06em;
    margin-bottom: 4px;
  }
  .modal-value {
    font-size: 13px; color: var(--text-primary);
    background: var(--bg-primary);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 8px 12px;
    font-family: 'SF Mono', Monaco, monospace;
    word-break: break-all;
    white-space: pre-wrap;
  }

  .modal-actions {
    display: flex; gap: 8px; margin-top: 16px;
    padding-top: 16px;
    border-top: 1px solid var(--border-subtle);
  }

  .test-result {
    margin-top: 12px;
    padding: 10px 12px;
    border-radius: 6px;
    font-size: 12px;
    font-family: 'SF Mono', Monaco, monospace;
    display: none;
  }
  .test-result.ok { display: block; background: var(--accent-dim); color: var(--accent); }
  .test-result.fail { display: block; background: var(--red-dim); color: var(--red); }
  .test-result.loading { display: block; background: var(--bg-primary); color: var(--text-muted); }

  .actions {
    display: flex; gap: 10px; flex-wrap: wrap;
    margin-bottom: 24px;
  }

  .action-btn {
    background: var(--bg-card);
    border: 1px solid var(--border);
    color: var(--text-primary);
    padding: 10px 18px;
    border-radius: 8px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    transition: all 0.15s;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .action-btn:hover {
    background: var(--accent-dim);
    border-color: var(--accent);
    color: var(--accent);
  }

  .action-btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #000;
    font-weight: 600;
  }

  .action-btn.primary:hover {
    background: #8ad400;
  }

  .system-bar {
    display: flex; gap: 20px;
    padding: 12px 16px;
    background: var(--bg-card);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    font-size: 12px;
    color: var(--text-muted);
  }

  .system-bar span { display: flex; gap: 4px; }
  .system-bar .label { color: var(--text-secondary); }

  .loading { opacity: 0.5; }

  @media (max-width: 640px) {
    .grid { grid-template-columns: 1fr; }
    .mcp-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <div class="logo">N</div>
      <h1>NemoClaw <span>Dashboard</span></h1>
    </div>
    <div class="header-right">
      <button class="refresh-btn" onclick="refresh()">Refresh</button>
    </div>
  </div>

  <div class="main">
    <div class="actions">
      <a class="action-btn primary" id="chat-link" href="http://127.0.0.1:${SANDBOX_PORT}" target="_blank">Open Chat UI</a>
      <button class="action-btn" onclick="restartServices()">Restart Services</button>
      <button class="action-btn" onclick="viewLogs()">View Logs</button>
    </div>

    <div class="grid" id="status-cards">
      <div class="card loading">
        <div class="card-header">
          <span class="card-title">Loading...</span>
        </div>
      </div>
    </div>

    <div class="section-title">MCP Servers</div>
    <div class="mcp-grid" id="mcp-servers">
      <div class="mcp-item loading">
        <div class="mcp-info"><span class="mcp-name">Loading...</span></div>
      </div>
    </div>

    <div class="system-bar" id="system-bar">
      <span><span class="label">Host:</span> loading...</span>
    </div>
  </div>

  <div class="modal-overlay" id="mcp-modal" onclick="if(event.target===this)closeModal()">
    <div class="modal">
      <button class="modal-close" onclick="closeModal()">&times;</button>
      <h2 id="modal-title">MCP Server</h2>
      <div id="modal-body"></div>
      <div class="modal-actions">
        <button class="action-btn" onclick="testMcpServer()">Test Connection</button>
        <button class="action-btn" onclick="copyBridgeUrl()">Copy Bridge URL</button>
      </div>
      <div class="test-result" id="test-result"></div>
    </div>
  </div>

  <script>
    let currentMcpSlug = '';

    function getMcpCategory(name) {
      if (name.includes('maas') || name.includes('nvidia') || name.includes('chipnemo') || name.includes('nvskills')) return 'nvidia';
      if (name.includes('local') || name === 'notion' || name === 'supabase' || name === 'gitnexus') return 'local';
      return 'external';
    }

    function getMcpInitials(name) {
      return name.replace(/^(maas-|user-)/i, '')
        .split(/[-_]/)
        .slice(0, 2)
        .map(w => w[0]?.toUpperCase() || '')
        .join('');
    }

    function formatUptime(seconds) {
      const d = Math.floor(seconds / 86400);
      const h = Math.floor((seconds % 86400) / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      if (d > 0) return d + 'd ' + h + 'h';
      if (h > 0) return h + 'h ' + m + 'm';
      return m + 'm';
    }

    async function refresh() {
      try {
        const res = await fetch('/api/status?t=' + Date.now());
        const data = await res.json();
        renderStatus(data);
      } catch (err) {
        console.error('Failed to fetch status:', err);
      }
    }

    function renderStatus(data) {
      const chatLink = document.getElementById('chat-link');
      if (data.sandbox.token) {
        chatLink.href = 'http://127.0.0.1:' + data.sandbox.port + '/#token=' + data.sandbox.token;
      }

      const cards = document.getElementById('status-cards');
      cards.innerHTML = [
        renderCard('Gateway', data.gateway === 'connected', data.gateway, 'OpenShell runtime'),
        renderCard('Sandbox', data.sandbox.up, data.sandbox.up ? 'Running' : 'Down', 'Port ' + data.sandbox.port),
        renderCard('MCP Bridge', data.mcpBridge.up, data.mcpBridge.servers.length + ' servers', 'Port ' + data.mcpBridge.port),
        renderCard('Cursor Agent', data.cursorBridge.up, data.cursorBridge.up ? 'Running' : 'Down', 'Port 18792'),
      ].join('');

      const mcpEl = document.getElementById('mcp-servers');
      if (data.mcpBridge.servers.length > 0) {
        mcpEl.innerHTML = data.mcpBridge.servers
          .sort((a, b) => a.slug.localeCompare(b.slug))
          .map(s => {
            const cat = getMcpCategory(s.slug);
            const initials = getMcpInitials(s.slug);
            const urlHint = s.url ? s.url.replace(/https?:[/][/]/, '').split('/')[0] : s.type;
            return '<div class="mcp-item" onclick="openMcpDetail(' + JSON.stringify(s.slug) + ',' + JSON.stringify(s.name) + ',' + JSON.stringify(s.type) + ')" title="Click for details">' +
              '<div class="mcp-icon ' + cat + '">' + initials + '</div>' +
              '<div class="mcp-info">' +
              '<div class="mcp-name">' + s.name + '</div>' +
              '<div class="mcp-type">' + urlHint + '</div>' +
              '</div></div>';
          }).join('');
      } else {
        mcpEl.innerHTML = '<div class="mcp-item"><div class="mcp-info"><span class="mcp-name" style="color:var(--text-muted)">MCP Bridge not running</span></div></div>';
      }

      const sysBar = document.getElementById('system-bar');
      sysBar.innerHTML =
        '<span><span class="label">Host:</span> ' + data.system.hostname + '</span>' +
        '<span><span class="label">Platform:</span> ' + data.system.platform + '</span>' +
        '<span><span class="label">Uptime:</span> ' + formatUptime(data.system.uptime) + '</span>' +
        '<span><span class="label">Memory:</span> ' + data.system.memory.free + ' / ' + data.system.memory.total + ' GB</span>';
    }

    function renderCard(title, isUp, value, detail) {
      const statusClass = isUp === true ? 'up' : (isUp === false ? 'down' : 'unknown');
      return '<div class="card">' +
        '<div class="card-header">' +
        '<span class="card-title">' + title + '</span>' +
        '<span class="status-dot ' + statusClass + '"></span>' +
        '</div>' +
        '<div class="card-value">' + value + '</div>' +
        '<div class="card-detail">' + detail + '</div>' +
        '</div>';
    }

    async function restartServices() {
      try {
        const res = await fetch('/api/restart', { method: 'POST' });
        const data = await res.json();
        alert(data.message || 'Services restarted');
        setTimeout(refresh, 2000);
      } catch (err) {
        alert('Failed to restart: ' + err.message);
      }
    }

    function viewLogs() {
      window.open('/api/logs', '_blank');
    }

    function escHtml(s) { return s.replace(/'/g, '&apos;').replace(/"/g, '&quot;'); }

    function openMcpDetail(slug, name, type) {
      currentMcpSlug = slug;
      document.getElementById('modal-title').textContent = name;
      document.getElementById('modal-body').innerHTML = '<div class="modal-field"><div class="modal-label">Loading...</div></div>';
      document.getElementById('test-result').className = 'test-result';
      document.getElementById('test-result').textContent = '';
      document.getElementById('mcp-modal').classList.add('active');

      fetch('/api/mcp/' + slug)
        .then(r => r.json())
        .then(data => {
          let html = '';
          html += field('Type', data.command ? 'Local (stdio)' : 'Remote (HTTP)');
          if (data.url) html += field('URL', data.url);
          if (data.command) html += field('Command', data.command + ' ' + (data.args || []).join(' '));
          html += field('Bridge URL', 'http://localhost:${MCP_BRIDGE_PORT}/mcp/' + slug + '/');
          if (data.headers && Object.keys(data.headers).length > 0) {
            html += field('Headers', JSON.stringify(data.headers, null, 2));
          }
          if (data.env) html += field('Env', JSON.stringify(data.env, null, 2));
          if (data.description) html += field('Description', data.description);
          if (data.tags) html += field('Tags', data.tags.join(', '));
          document.getElementById('modal-body').innerHTML = html;
        })
        .catch(err => {
          document.getElementById('modal-body').innerHTML = field('Error', err.message);
        });
    }

    function field(label, value) {
      return '<div class="modal-field"><div class="modal-label">' + label + '</div><div class="modal-value">' + value + '</div></div>';
    }

    function closeModal() {
      document.getElementById('mcp-modal').classList.remove('active');
    }

    async function testMcpServer() {
      const el = document.getElementById('test-result');
      el.className = 'test-result loading';
      el.textContent = 'Testing connection...';
      try {
        const res = await fetch('/api/mcp/' + currentMcpSlug + '/test', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          el.className = 'test-result ok';
          el.textContent = 'Connected (HTTP ' + (data.status || '200') + ') ' + (data.body || '').slice(0, 200);
        } else {
          el.className = 'test-result fail';
          el.textContent = 'Failed: ' + (data.error || 'unknown error');
        }
      } catch (err) {
        el.className = 'test-result fail';
        el.textContent = 'Error: ' + err.message;
      }
    }

    function copyBridgeUrl() {
      const url = 'http://localhost:${MCP_BRIDGE_PORT}/mcp/' + currentMcpSlug + '/';
      navigator.clipboard.writeText(url).then(() => {
        const btn = event.target;
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = 'Copy Bridge URL', 1500);
      });
    }

    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

    refresh();
    setInterval(refresh, 15000);
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Pragma": "no-cache",
    });
    res.end(HTML);
    return;
  }

  if (req.url === "/api/status") {
    const status = await getSystemStatus();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status));
    return;
  }

  if (req.url === "/api/restart" && req.method === "POST") {
    try {
      const scriptDir = path.join(__dirname);
      execSync(`bash ${path.join(scriptDir, "start-services.sh")} --stop && bash ${path.join(scriptDir, "start-services.sh")}`, {
        encoding: "utf-8",
        timeout: 30000,
        env: process.env,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Services restarted" }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.url === "/api/logs") {
    const sandboxName = process.env.SANDBOX_NAME || "default";
    const pidDir = `/tmp/nemoclaw-services-${sandboxName}`;
    let logs = "";
    for (const svc of ["mcp-bridge", "cursor-agent-bridge", "telegram-bridge", "cloudflared"]) {
      const logFile = path.join(pidDir, `${svc}.log`);
      if (fs.existsSync(logFile)) {
        const content = fs.readFileSync(logFile, "utf-8");
        const tail = content.split("\n").slice(-50).join("\n");
        logs += `=== ${svc} ===\n${tail}\n\n`;
      }
    }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(logs || "No logs found.");
    return;
  }

  // GET /api/mcp/:slug — detail + config for one MCP server
  const mcpDetail = req.url.match(/^\/api\/mcp\/([a-z0-9-]+)$/);
  if (mcpDetail && req.method === "GET") {
    const slug = mcpDetail[1];
    try {
      const configPath = process.env.MCP_CONFIG_PATH || path.join(os.homedir(), ".cursor", "mcp.json");
      const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      const servers = raw.mcpServers || {};
      let found = null;
      for (const [name, config] of Object.entries(servers)) {
        const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        if (s === slug) { found = { name, slug: s, ...config }; break; }
      }
      if (!found) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Server not found" }));
        return;
      }
      const sanitized = { ...found };
      if (sanitized.env) {
        sanitized.env = Object.fromEntries(
          Object.entries(sanitized.env).map(([k, v]) => [k, String(v).slice(0, 20) + "..."])
        );
      }
      if (sanitized.args) {
        sanitized.args = sanitized.args.map(a =>
          (a.startsWith("sbp_") || a.startsWith("ntn_")) ? a.slice(0, 8) + "..." : a
        );
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(sanitized, null, 2));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // POST /api/mcp/:slug/test — test connectivity to an MCP server
  const mcpTest = req.url.match(/^\/api\/mcp\/([a-z0-9-]+)\/test$/);
  if (mcpTest && req.method === "POST") {
    const slug = mcpTest[1];
    const testUrl = `http://127.0.0.1:${MCP_BRIDGE_PORT}/mcp/${slug}/`;
    try {
      const result = await new Promise((resolve) => {
        const req = http.get(testUrl, { timeout: 5000 }, (r) => {
          let data = "";
          r.on("data", c => data += c);
          r.on("end", () => resolve({ status: r.statusCode, ok: r.statusCode < 500, body: data.slice(0, 500) }));
        });
        req.on("error", e => resolve({ ok: false, error: e.message }));
        req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "timeout" }); });
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("  ┌─────────────────────────────────────────────────────┐");
  console.log("  │  NemoClaw Dashboard                                 │");
  console.log("  │                                                     │");
  console.log(`  │  URL:   http://localhost:${String(PORT).padEnd(35)}│`);
  console.log(`  │  Chat:  http://localhost:${String(SANDBOX_PORT).padEnd(35)}│`);
  console.log(`  │  MCP:   http://localhost:${String(MCP_BRIDGE_PORT).padEnd(35)}│`);
  console.log("  │                                                     │");
  console.log("  └─────────────────────────────────────────────────────┘");
  console.log("");
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => process.emit("SIGTERM"));
