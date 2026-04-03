#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Cursor Agent Bridge — exposes the Cursor Agent CLI as an HTTP API
 * so that Chiera (OpenClaw inside sandbox) can request code changes
 * from a remote chat interface (Telegram, Web UI, etc.).
 *
 * Flow: Chiera -> Bridge HTTP API -> Cursor Agent CLI -> code + git push
 *
 * Env:
 *   CURSOR_BRIDGE_PORT     — listen port (default: 18792)
 *   CURSOR_BIN             — path to cursor binary
 *   CURSOR_WORKSPACE       — default workspace path
 *   CURSOR_MODEL           — model to use (default: auto)
 */

const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const PORT = parseInt(process.env.CURSOR_BRIDGE_PORT || "18792", 10);
const CURSOR_BIN =
  process.env.CURSOR_BIN ||
  "/Applications/Cursor.app/Contents/Resources/app/bin/cursor";
const DEFAULT_WORKSPACE =
  process.env.CURSOR_WORKSPACE ||
  path.join(process.env.HOME || "", "Documents", "PersonalProject");
const DEFAULT_MODEL = process.env.CURSOR_MODEL || "auto";

const activeJobs = new Map();
let jobCounter = 0;

function runCursorAgent(prompt, options = {}) {
  const {
    workspace = DEFAULT_WORKSPACE,
    model = DEFAULT_MODEL,
    mode,
  } = options;

  const jobId = ++jobCounter;

  return new Promise((resolve) => {
    const args = [
      "agent",
      "--print",
      "--trust",
      "--workspace", workspace,
      "--model", model,
    ];

    if (mode === "plan" || mode === "ask") {
      args.push("--mode", mode);
    }

    args.push(prompt);

    const proc = spawn(CURSOR_BIN, args, {
      timeout: 300000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    activeJobs.set(jobId, { proc, prompt: prompt.slice(0, 100), startedAt: Date.now() });

    proc.on("close", (code) => {
      activeJobs.delete(jobId);
      resolve({
        jobId,
        exitCode: code,
        output: stdout.trim(),
        error: stderr.trim() || null,
        durationMs: Date.now() - activeJobs.get(jobId)?.startedAt || 0,
      });
    });

    proc.on("error", (err) => {
      activeJobs.delete(jobId);
      resolve({
        jobId,
        exitCode: -1,
        output: null,
        error: err.message,
      });
    });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      service: "cursor-agent-bridge",
      defaultWorkspace: DEFAULT_WORKSPACE,
      model: DEFAULT_MODEL,
      activeJobs: activeJobs.size,
    }));
    return;
  }

  if (req.url === "/jobs") {
    res.writeHead(200, { "Content-Type": "application/json" });
    const jobs = [];
    for (const [id, job] of activeJobs) {
      jobs.push({ id, prompt: job.prompt, runningMs: Date.now() - job.startedAt });
    }
    res.end(JSON.stringify({ jobs }));
    return;
  }

  // POST /agent — run cursor agent
  if (req.method === "POST" && req.url === "/agent") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
      }

      const { prompt, workspace, model, mode } = parsed;
      if (!prompt) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing 'prompt' field" }));
        return;
      }

      console.log(`[cursor-bridge] Job started: ${prompt.slice(0, 80)}...`);

      const result = await runCursorAgent(prompt, { workspace, model, mode });

      console.log(`[cursor-bridge] Job ${result.jobId} done (exit ${result.exitCode})`);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found. Use POST /agent" }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("  ┌─────────────────────────────────────────────────────┐");
  console.log("  │  Cursor Agent Bridge for Chiera                     │");
  console.log("  │                                                     │");
  console.log(`  │  Port:       ${String(PORT).padEnd(39)}│`);
  console.log(`  │  Workspace:  ${DEFAULT_WORKSPACE.slice(-39).padEnd(39)}│`);
  console.log(`  │  Model:      ${DEFAULT_MODEL.padEnd(39)}│`);
  console.log("  │                                                     │");
  console.log("  │  POST /agent  { prompt, workspace?, model?, mode? } │");
  console.log("  │  GET  /health                                       │");
  console.log("  │  GET  /jobs                                         │");
  console.log("  └─────────────────────────────────────────────────────┘");
  console.log("");
});

process.on("SIGTERM", () => {
  for (const [, job] of activeJobs) job.proc.kill();
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => process.emit("SIGTERM"));
