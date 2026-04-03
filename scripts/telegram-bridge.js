#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Chiera Telegram Bridge — Smart Orchestrator
 *
 * Receives messages from Telegram via Cloudflare proxy,
 * classifies intent, and routes to the right backend:
 *
 *   /code <prompt>   -> Cursor Agent (code changes, git push)
 *   /projects        -> Cursor Agent (list projects)
 *   /status          -> System status (sandbox, bridges, services)
 *   /notion <query>  -> Notion API search
 *   /reset           -> Reset chat session
 *   (default)        -> OpenClaw agent in sandbox (general chat)
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN   — from @BotFather
 *   NVIDIA_API_KEY       — for inference
 *   SANDBOX_NAME         — sandbox name (default: my-assistant)
 *   TELEGRAM_API_HOST    — Cloudflare proxy host
 *   CURSOR_BRIDGE_URL    — Cursor Agent Bridge (default: http://127.0.0.1:18792)
 *   NOTION_API_KEY       — Notion integration token
 */

const http = require("http");
const https = require("https");
const { execFileSync, spawn } = require("child_process");
const { resolveOpenshell } = require("../bin/lib/resolve-openshell");
const { shellQuote, validateName } = require("../bin/lib/runner");
const { parseAllowedChatIds, isChatAllowed } = require("../bin/lib/chat-filter");

const OPENSHELL = resolveOpenshell();
if (!OPENSHELL) {
  console.error("openshell not found on PATH or in common locations");
  process.exit(1);
}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_KEY = process.env.NVIDIA_API_KEY;
const SANDBOX = process.env.SANDBOX_NAME || "my-assistant";
try { validateName(SANDBOX, "SANDBOX_NAME"); } catch (e) { console.error(e.message); process.exit(1); }
const TG_API_HOST = process.env.TELEGRAM_API_HOST || "chiera-telegram-proxy.chiera-tlle.workers.dev";
const CURSOR_BRIDGE = process.env.CURSOR_BRIDGE_URL || "http://127.0.0.1:18792";
const NOTION_KEY = process.env.NOTION_API_KEY || "";
const ALLOWED_CHATS = parseAllowedChatIds(process.env.ALLOWED_CHAT_IDS);

if (!TOKEN) { console.error("TELEGRAM_BOT_TOKEN required"); process.exit(1); }
if (!API_KEY) { console.error("NVIDIA_API_KEY required"); process.exit(1); }

let offset = 0;
const chatHistories = new Map();

const COOLDOWN_MS = 5000;
const lastMessageTime = new Map();
const busyChats = new Set();

// ── Telegram API (via Cloudflare proxy) ──────────────────────────

function tgApi(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname: TG_API_HOST,
        path: `/bot${TOKEN}/${method}`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try { resolve(JSON.parse(buf)); } catch { resolve({ ok: false, error: buf }); }
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function sendMessage(chatId, text, replyTo) {
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) {
    chunks.push(text.slice(i, i + 4000));
  }
  for (const chunk of chunks) {
    await tgApi("sendMessage", {
      chat_id: chatId,
      text: chunk,
      reply_to_message_id: replyTo,
      parse_mode: "Markdown",
    }).catch(() =>
      tgApi("sendMessage", { chat_id: chatId, text: chunk, reply_to_message_id: replyTo }),
    );
  }
}

async function sendTyping(chatId) {
  await tgApi("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
}

// ── Cursor Agent Bridge ──────────────────────────────────────────

function callCursorAgent(prompt, options = {}) {
  return new Promise((resolve, reject) => {
    const { workspace, mode } = options;
    const body = JSON.stringify({ prompt, workspace, mode });
    const url = new URL(CURSOR_BRIDGE + "/agent");

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: 300000,
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            const data = JSON.parse(buf);
            resolve(data.output || data.error || "(no output)");
          } catch {
            resolve(buf || "(empty response)");
          }
        });
      },
    );
    req.on("error", (e) => resolve(`Cursor Agent error: ${e.message}`));
    req.on("timeout", () => { req.destroy(); resolve("Cursor Agent timed out (5min)."); });
    req.write(body);
    req.end();
  });
}

// ── Notion API ───────────────────────────────────────────────────

function searchNotion(query) {
  return new Promise((resolve) => {
    if (!NOTION_KEY) {
      resolve("Notion not configured. Set NOTION_API_KEY.");
      return;
    }
    const body = JSON.stringify({ query, page_size: 10 });
    const req = https.request(
      {
        hostname: "api.notion.com",
        path: "/v1/search",
        method: "POST",
        headers: {
          "Authorization": `Bearer ${NOTION_KEY}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 15000,
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            const data = JSON.parse(buf);
            const results = data.results || [];
            if (results.length === 0) {
              resolve(`No results for "${query}" in Notion.`);
              return;
            }
            let text = `*Notion* — ${results.length} results for "${query}":\n\n`;
            results.forEach((r, i) => {
              let title = "Untitled";
              const props = r.properties || {};
              for (const key of ["title", "Title", "Name"]) {
                const t = (props[key] || {}).title || [];
                if (t.length > 0) { title = t[0].plain_text || "Untitled"; break; }
              }
              if (r.object === "database") {
                const t = r.title || [];
                if (t.length > 0) title = t[0].plain_text || "Untitled";
              }
              const url = r.url || "";
              text += `${i + 1}. *${title}* (${r.object})\n   ${url}\n\n`;
            });
            resolve(text);
          } catch (e) {
            resolve(`Notion error: ${e.message}`);
          }
        });
      },
    );
    req.on("error", (e) => resolve(`Notion error: ${e.message}`));
    req.write(body);
    req.end();
  });
}

// ── OpenClaw agent in sandbox ────────────────────────────────────

function runAgentInSandbox(message, sessionId) {
  return new Promise((resolve) => {
    const sshConfig = execFileSync(OPENSHELL, ["sandbox", "ssh-config", SANDBOX], { encoding: "utf-8" });

    const confDir = require("fs").mkdtempSync("/tmp/nemoclaw-tg-ssh-");
    const confPath = `${confDir}/config`;
    require("fs").writeFileSync(confPath, sshConfig, { mode: 0o600 });

    const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9-]/g, "");
    const cmd = `export NVIDIA_API_KEY=${shellQuote(API_KEY)} && nemoclaw-start openclaw agent --agent main --local -m ${shellQuote(message)} --session-id ${shellQuote("tg-" + safeSessionId)}`;

    const proc = spawn("ssh", ["-T", "-F", confPath, `openshell-${SANDBOX}`, cmd], {
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      try { require("fs").unlinkSync(confPath); require("fs").rmdirSync(confDir); } catch { /* ignored */ }

      const lines = stdout.split("\n").filter(
        (l) =>
          !l.startsWith("Setting up NemoClaw") &&
          !l.startsWith("[plugins]") &&
          !l.startsWith("(node:") &&
          !l.includes("NemoClaw ready") &&
          !l.includes("NemoClaw registered") &&
          !l.includes("openclaw agent") &&
          !l.includes("┌─") &&
          !l.includes("│ ") &&
          !l.includes("└─") &&
          l.trim() !== "",
      );
      const response = lines.join("\n").trim();
      resolve(response || (code !== 0 ? `Exit ${code}: ${stderr.trim().slice(0, 300)}` : "(no response)"));
    });

    proc.on("error", (err) => resolve(`Error: ${err.message}`));
  });
}

// ── Intent router ────────────────────────────────────────────────

const CODE_PATTERNS = [
  /^\/code\s+/i,
  /\b(fix|write|create|add|remove|refactor|implement|update|push|commit|deploy)\b.*\b(code|file|function|component|bug|feature)\b/i,
  /\b(code|push|commit|git|pull request|PR|merge)\b/i,
];

const NOTION_PATTERNS = [
  /^\/notion\s+/i,
  /\bnotion\b/i,
];

const PROJECT_PATTERNS = [
  /^\/projects?\b/i,
  /\b(list)\b.*\b(project)\b/i,
];

const STATUS_PATTERNS = [
  /^\/status\b/i,
  /\b(status|health)\b/i,
];

function classifyIntent(text) {
  if (text === "/start" || text === "/help") return "help";
  if (text === "/reset") return "reset";
  if (STATUS_PATTERNS.some((p) => p.test(text))) return "status";
  if (PROJECT_PATTERNS.some((p) => p.test(text))) return "projects";
  if (/^\/code\s+/.test(text)) return "code";
  if (NOTION_PATTERNS.some((p) => p.test(text))) return "notion";
  if (CODE_PATTERNS.some((p) => p.test(text))) return "code";
  return "chat";
}

// ── Handlers ─────────────────────────────────────────────────────

async function handleHelp(chatId, msgId) {
  await sendMessage(chatId,
    "*Chiera* — NemoClaw Personal Agent\n\n" +
    "*Commands:*\n" +
    "Chat normally -> AI responds (Nemotron)\n" +
    "`/code <request>` -> Cursor Agent code + push\n" +
    "`/projects` -> List managed projects\n" +
    "`/notion <keyword>` -> Search Notion\n" +
    "`/status` -> System status\n" +
    "`/reset` -> Reset session\n\n" +
    "*Smart routing:*\n" +
    "Mention code/fix/push -> auto Cursor Agent\n" +
    "Mention Notion -> auto Notion search\n" +
    "Everything else -> AI chat\n",
    msgId);
}

async function handleStatus(chatId, msgId) {
  let status = "*Chiera System Status*\n\n";

  try {
    const gwStatus = execFileSync(OPENSHELL, ["status"], { encoding: "utf-8", timeout: 10000 });
    status += gwStatus.includes("Connected") ? "Gateway: Connected\n" : "Gateway: Disconnected\n";
  } catch { status += "Gateway: Error\n"; }

  try {
    const sbList = execFileSync(OPENSHELL, ["sandbox", "list"], { encoding: "utf-8", timeout: 10000 });
    status += sbList.includes("Ready") ? "Sandbox: Ready\n" : "Sandbox: Not Ready\n";
  } catch { status += "Sandbox: Error\n"; }

  try {
    const { execSync } = require("child_process");
    const cursorHealth = execSync(`curl -s --max-time 3 ${CURSOR_BRIDGE}/health 2>/dev/null`, { encoding: "utf-8", timeout: 5000 });
    status += cursorHealth.includes('"ok"') ? "Cursor Agent: Running\n" : "Cursor Agent: Down\n";
  } catch { status += "Cursor Agent: Down\n"; }

  status += NOTION_KEY ? "Notion: Connected\n" : "Notion: Not configured\n";
  status += "Telegram: Connected (via Cloudflare)\n";

  await sendMessage(chatId, status, msgId);
}

async function handleProjects(chatId, msgId) {
  await sendTyping(chatId);
  try {
    const fs = require("fs");
    const path = require("path");
    const baseDir = "/Users/tlle/Documents/PersonalProject";
    const dirs = fs.readdirSync(baseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name);

    let text = "*Projects (" + dirs.length + "):*\n\n";
    for (const dir of dirs.sort()) {
      const full = path.join(baseDir, dir);
      let desc = "";
      const pkgPath = path.join(full, "package.json");
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
          desc = pkg.description || pkg.name || "";
        } catch {}
      }
      if (!desc) {
        const readmePath = path.join(full, "README.md");
        if (fs.existsSync(readmePath)) {
          const first = fs.readFileSync(readmePath, "utf-8").split("\n").find((l) => l.trim() && !l.startsWith("#"));
          desc = (first || "").trim().slice(0, 60);
        }
      }
      text += `- *${dir}*${desc ? " — " + desc : ""}\n`;
    }
    await sendMessage(chatId, text, msgId);
  } catch (err) {
    await sendMessage(chatId, "Error listing projects: " + err.message, msgId);
  }
}

async function handleCode(chatId, msgId, prompt) {
  const cleanPrompt = prompt.replace(/^\/code\s+/i, "");
  await sendTyping(chatId);
  await sendMessage(chatId, "Cursor Agent processing... (may take 1-3 min)", msgId);
  const typingInterval = setInterval(() => sendTyping(chatId), 4000);
  try {
    const result = await callCursorAgent(cleanPrompt, {
      workspace: "/Users/tlle/Documents/PersonalProject",
    });
    clearInterval(typingInterval);
    await sendMessage(chatId, "*Cursor Agent:*\n\n" + result, msgId);
  } catch (err) {
    clearInterval(typingInterval);
    await sendMessage(chatId, "Cursor Agent error: " + err.message, msgId);
  }
}

async function handleNotion(chatId, msgId, text) {
  const query = text.replace(/^\/notion\s+/i, "").replace(/\bnotion\b/gi, "").trim();
  if (!query) {
    await sendMessage(chatId, "Need a keyword. Example: `/notion MedicalPower`", msgId);
    return;
  }
  await sendTyping(chatId);
  const result = await searchNotion(query);
  await sendMessage(chatId, result, msgId);
}

function callNvidiaLLM(userMessage, chatId) {
  return new Promise((resolve) => {
    const history = chatHistories.get(chatId) || [];
    history.push({ role: "user", content: userMessage });
    if (history.length > 20) history.splice(0, history.length - 20);
    chatHistories.set(chatId, history);

    const systemPrompt = {
      role: "system",
      content: `You are Chiera, a personal AI agent running on NemoClaw (NVIDIA OpenShell).
You assist with engineering tasks, project management, and general questions.
Be concise and direct. Use technical language when appropriate.`
    };

    const body = JSON.stringify({
      model: "nvidia/nemotron-3-super-120b-a12b",
      messages: [systemPrompt, ...history],
      max_tokens: 1024,
    });

    const req = https.request({
      hostname: "integrate.api.nvidia.com",
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 30000,
    }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        try {
          const data = JSON.parse(buf);
          const reply = data.choices?.[0]?.message?.content || "(no response)";
          history.push({ role: "assistant", content: reply });
          chatHistories.set(chatId, history);
          resolve(reply);
        } catch {
          resolve("API error: " + buf.slice(0, 200));
        }
      });
    });
    req.on("error", (e) => resolve("LLM error: " + e.message));
    req.on("timeout", () => { req.destroy(); resolve("LLM timeout"); });
    req.write(body);
    req.end();
  });
}

async function handleChat(chatId, msgId, text) {
  await sendTyping(chatId);
  try {
    const response = await callNvidiaLLM(text, chatId);
    await sendMessage(chatId, response, msgId);
  } catch (err) {
    await sendMessage(chatId, `Error: ${err.message}`, msgId);
  }
}

// ── Poll loop ─────────────────────────────────────────────────────

async function poll() {
  try {
    const res = await tgApi("getUpdates", { offset, timeout: 30 });

    if (res.ok && res.result?.length > 0) {
      for (const update of res.result) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.text) continue;

        const chatId = String(msg.chat.id);

        if (!isChatAllowed(ALLOWED_CHATS, chatId)) {
          console.log(`[ignored] chat ${chatId} not in allowed list`);
          continue;
        }

        const userName = msg.from?.first_name || "someone";
        const text = msg.text.trim();
        const intent = classifyIntent(text);
        console.log(`[${chatId}] ${userName}: ${text.slice(0, 80)} -> [${intent}]`);

        const now = Date.now();
        const lastTime = lastMessageTime.get(chatId) || 0;
        if (now - lastTime < COOLDOWN_MS) {
          const wait = Math.ceil((COOLDOWN_MS - (now - lastTime)) / 1000);
          await sendMessage(chatId, `Please wait ${wait}s before sending another message.`, msg.message_id);
          continue;
        }

        if (busyChats.has(chatId)) {
          await sendMessage(chatId, "Still processing your previous message.", msg.message_id);
          continue;
        }

        lastMessageTime.set(chatId, now);
        busyChats.add(chatId);

        try {
          switch (intent) {
            case "help":     await handleHelp(chatId, msg.message_id); break;
            case "reset":    chatHistories.delete(chatId); await sendMessage(chatId, "Session reset.", msg.message_id); break;
            case "status":   await handleStatus(chatId, msg.message_id); break;
            case "projects": await handleProjects(chatId, msg.message_id); break;
            case "code":     await handleCode(chatId, msg.message_id, text); break;
            case "notion":   await handleNotion(chatId, msg.message_id, text); break;
            case "chat":     await handleChat(chatId, msg.message_id, text); break;
          }
        } catch (err) {
          console.error(`[${chatId}] handler error:`, err.message);
          await sendMessage(chatId, `Error: ${err.message}`, msg.message_id).catch(() => {});
        } finally {
          busyChats.delete(chatId);
        }
      }
    }
  } catch (err) {
    console.error("Poll error:", err.message);
  }

  setTimeout(poll, 1000);
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  const me = await tgApi("getMe", {});
  if (!me.ok) {
    console.error("Failed to connect to Telegram:", JSON.stringify(me));
    process.exit(1);
  }

  console.log("");
  console.log("  ┌─────────────────────────────────────────────────────┐");
  console.log("  │  Chiera — NemoClaw Telegram Orchestrator            │");
  console.log("  │                                                     │");
  console.log(`  │  Bot:       @${(me.result.username + "                  ").slice(0, 37)}│`);
  console.log("  │  Sandbox:   " + (SANDBOX + "                            ").slice(0, 40) + "│");
  console.log("  │  Cursor:    " + (CURSOR_BRIDGE + "              ").slice(0, 40) + "│");
  console.log("  │  Notion:    " + (NOTION_KEY ? "connected" : "not set").padEnd(40) + "│");
  console.log("  │                                                     │");
  console.log("  │  Routes:                                            │");
  console.log("  │    chat    -> OpenClaw (sandbox)                     │");
  console.log("  │    /code   -> Cursor Agent (host)                    │");
  console.log("  │    /notion -> Notion API                             │");
  console.log("  │    /status -> System health                          │");
  console.log("  └─────────────────────────────────────────────────────┘");
  console.log("");

  poll();
}

main();
