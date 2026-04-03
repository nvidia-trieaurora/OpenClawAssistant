#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * MCP Bridge — proxies MCP requests from the OpenClaw sandbox to remote
 * MCP servers running on the host network (where VPN + SSO are available).
 *
 * Reads server definitions from ~/.cursor/mcp.json (Cursor's MCP config)
 * and exposes them at http://0.0.0.0:18790/mcp/<serverName>/...
 *
 * The sandbox connects here instead of directly to the MCP servers,
 * allowing the bridge to use host-level VPN, SSO cookies, and auth tokens.
 *
 * Env:
 *   MCP_BRIDGE_PORT     — listen port (default: 18790)
 *   MCP_CONFIG_PATH     — path to mcp.json (default: ~/.cursor/mcp.json)
 *   MCP_AUTH_COOKIE_DIR — directory with per-server auth cookies (optional)
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const url = require("url");
const { spawn, execSync } = require("child_process");

const PORT = parseInt(process.env.MCP_BRIDGE_PORT || "18790", 10);
const TLS_KEY = process.env.MCP_BRIDGE_TLS_KEY || path.join(os.tmpdir(), "mcp-bridge-key.pem");
const TLS_CERT = process.env.MCP_BRIDGE_TLS_CERT || path.join(os.tmpdir(), "mcp-bridge-cert.pem");
const CONFIG_PATH =
  process.env.MCP_CONFIG_PATH ||
  path.join(process.env.HOME || "", ".cursor", "mcp.json");

// ── Load MCP server config ───────────────────────────────────────

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`[mcp-bridge] Config not found: ${CONFIG_PATH}`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  return raw.mcpServers || {};
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildServerMap(mcpServers) {
  const map = new Map();
  for (const [name, config] of Object.entries(mcpServers)) {
    const slug = slugify(name);
    map.set(slug, { name, slug, ...config });
  }
  return map;
}

// ── Local process servers (npx/command based) ────────────────────

const localProcesses = new Map();

function startLocalServer(slug, serverConfig) {
  if (localProcesses.has(slug)) return localProcesses.get(slug);

  const { command, args = [] } = serverConfig;
  if (!command) return null;

  console.log(`[mcp-bridge] Starting local MCP server: ${slug} (${command} ${args.join(" ")})`);

  const proc = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  const entry = { proc, ready: false, buffer: "" };

  proc.stdout.on("data", (d) => {
    entry.buffer += d.toString();
  });

  proc.stderr.on("data", (d) => {
    console.error(`[mcp-bridge] ${slug} stderr: ${d.toString().trim()}`);
  });

  proc.on("close", (code) => {
    console.log(`[mcp-bridge] ${slug} exited (code ${code})`);
    localProcesses.delete(slug);
  });

  localProcesses.set(slug, entry);
  return entry;
}

// ── HTTP proxy for remote MCP servers ────────────────────────────

function proxyToRemote(serverConfig, reqPath, reqMethod, reqHeaders, reqBody, res) {
  const targetUrl = serverConfig.url;
  if (!targetUrl) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Server has no URL configured" }));
    return;
  }

  const parsed = new URL(reqPath ? `${targetUrl.replace(/\/$/, "")}${reqPath}` : targetUrl);
  const isHttps = parsed.protocol === "https:";
  const transport = isHttps ? https : http;

  const proxyHeaders = {
    ...reqHeaders,
    host: parsed.host,
  };
  delete proxyHeaders["connection"];
  delete proxyHeaders["transfer-encoding"];

  if (serverConfig.headers) {
    Object.assign(proxyHeaders, serverConfig.headers);
  }

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: reqMethod,
    headers: proxyHeaders,
    rejectUnauthorized: false,
  };

  const proxyReq = transport.request(options, (proxyRes) => {
    const contentType = proxyRes.headers["content-type"] || "";
    const isSSE = contentType.includes("text/event-stream");

    res.writeHead(proxyRes.statusCode, proxyRes.headers);

    if (isSSE) {
      proxyRes.on("data", (chunk) => {
        res.write(chunk);
        if (res.flush) res.flush();
      });
      proxyRes.on("end", () => res.end());
    } else {
      proxyRes.pipe(res);
    }
  });

  proxyReq.on("error", (err) => {
    console.error(`[mcp-bridge] Proxy error for ${serverConfig.name}: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
    }
    res.end(JSON.stringify({ error: `Upstream error: ${err.message}` }));
  });

  if (reqBody) {
    proxyReq.write(reqBody);
  }
  proxyReq.end();
}

// ── Stdio proxy for local MCP servers (command-based) ────────────

function proxyToLocal(slug, serverConfig, reqBody, res) {
  const entry = startLocalServer(slug, serverConfig);
  if (!entry) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Cannot start local server: ${slug}` }));
    return;
  }

  const { proc } = entry;

  if (proc.stdin.destroyed) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Local server ${slug} stdin is closed` }));
    return;
  }

  entry.buffer = "";

  proc.stdin.write(reqBody + "\n");

  const timeout = setTimeout(() => {
    const response = entry.buffer.trim();
    entry.buffer = "";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(response || JSON.stringify({ error: "No response from local server" }));
  }, 10000);

  const onData = (data) => {
    const text = entry.buffer;
    const lines = text.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      try {
        JSON.parse(line);
        clearTimeout(timeout);
        proc.stdout.removeListener("data", onData);
        entry.buffer = "";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(line);
        return;
      } catch {
        // not complete JSON yet
      }
    }
  };

  proc.stdout.on("data", onData);
}

// ── HTTP server ──────────────────────────────────────────────────

function createHandler(serverMap) {
  return (req, res) => {
    // CORS for sandbox requests
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // GET / — list available servers
    if (req.url === "/" || req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      const servers = [];
      for (const [slug, config] of serverMap) {
        servers.push({
          slug,
          name: config.name,
          type: config.command ? "local" : "remote",
          url: config.url || null,
        });
      }
      res.end(JSON.stringify({ status: "ok", servers }, null, 2));
      return;
    }

    // /mcp/<slug>/... — proxy to MCP server
    const match = req.url.match(/^\/mcp\/([a-z0-9-]+)(\/.*)?$/);
    if (!match) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found. Use /mcp/<server-slug>/..." }));
      return;
    }

    const slug = match[1];
    const subPath = match[2] || "";
    const serverConfig = serverMap.get(slug);

    if (!serverConfig) {
      res.writeHead(404, { "Content-Type": "application/json" });
      const available = [...serverMap.keys()].join(", ");
      res.end(JSON.stringify({ error: `Unknown server: ${slug}`, available }));
      return;
    }

    // Collect request body
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (serverConfig.command) {
        proxyToLocal(slug, serverConfig, body, res);
      } else {
        const fwdHeaders = { ...req.headers };
        delete fwdHeaders["host"];
        proxyToRemote(serverConfig, subPath, req.method, fwdHeaders, body, res);
      }
    });
  };
}

// ── Main ─────────────────────────────────────────────────────────

function main() {
  const mcpServers = loadConfig();
  const serverMap = buildServerMap(mcpServers);

  console.log("");
  console.log("  ┌─────────────────────────────────────────────────────┐");
  console.log("  │  NemoClaw MCP Bridge                                │");
  console.log("  │                                                     │");
  console.log(`  │  Port:     ${String(PORT).padEnd(41)}│`);
  console.log(`  │  Config:   ${CONFIG_PATH.slice(-41).padEnd(41)}│`);
  console.log(`  │  Servers:  ${String(serverMap.size).padEnd(41)}│`);
  console.log("  │                                                     │");

  for (const [slug, config] of serverMap) {
    const type = config.command ? "local" : "remote";
    const label = `${slug} (${type})`;
    console.log(`  │    ${label.padEnd(48)}│`);
  }

  console.log("  │                                                     │");
  console.log("  │  Sandbox connects via:                              │");
  console.log("  │    http://host.docker.internal:18790/mcp/<slug>     │");
  console.log("  └─────────────────────────────────────────────────────┘");
  console.log("");

  // Generate self-signed cert if missing
  if (!fs.existsSync(TLS_KEY) || !fs.existsSync(TLS_CERT)) {
    console.log("[mcp-bridge] Generating self-signed TLS certificate...");
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${TLS_KEY}" -out "${TLS_CERT}" -days 365 -nodes -subj "/CN=host.docker.internal" 2>/dev/null`
    );
  }

  const handler = createHandler(serverMap);

  // Start both HTTP and HTTPS
  const httpServer = http.createServer(handler);
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`[mcp-bridge] HTTP  listening on 0.0.0.0:${PORT}`);
  });

  const httpsServer = https.createServer(
    { key: fs.readFileSync(TLS_KEY), cert: fs.readFileSync(TLS_CERT) },
    handler
  );
  const TLS_PORT = PORT + 1;
  httpsServer.listen(TLS_PORT, "0.0.0.0", () => {
    console.log(`[mcp-bridge] HTTPS listening on 0.0.0.0:${TLS_PORT}`);
  });

  // Graceful shutdown
  process.on("SIGTERM", () => {
    console.log("[mcp-bridge] Shutting down...");
    for (const [slug, entry] of localProcesses) {
      console.log(`[mcp-bridge] Stopping local server: ${slug}`);
      entry.proc.kill();
    }
    httpServer.close();
    httpsServer.close(() => process.exit(0));
  });

  process.on("SIGINT", () => {
    process.emit("SIGTERM");
  });
}

main();
