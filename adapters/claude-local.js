// adapters/claude-local.js
//
// LLM provider "claude-local": runs an agent cycle through the local `claude` CLI
// (Claude subscription via `claude login`) instead of an OpenAI-compatible API.
// Ported from nightly-2026-04 and hardened:
//
// - Built-in Claude Code tools are disabled (--tools ""), so the model cannot read
//   files (.env / wallet key), run shell commands or browse. It only sees Meridian's
//   role-filtered tools, served by the in-process MCP server with a per-cycle token.
// - --strict-mcp-config: ignores any other MCP servers configured on the machine.
// - --setting-sources "" : ignores user/project Claude settings, hooks and CLAUDE.md.
// - Model, effort, max turns and timeout are configurable per role.
// - No automatic fallback model.

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { log } from "../logger.js";
import { openToolSession } from "../mcp-http-server.js";

const ROLE_KEY = { MANAGER: "management", SCREENER: "screening", GENERAL: "general" };

export function resolveClaudeLocalModel(agentType, cfg) {
  const role = ROLE_KEY[agentType] || "general";
  return cfg?.models?.[role] || cfg?.models?.default || null;
}

function resolveEffort(agentType, cfg) {
  const role = ROLE_KEY[agentType] || "general";
  const v = cfg?.effort?.[role] ?? cfg?.effort?.default ?? null;
  return ["low", "medium", "high", "xhigh", "max"].includes(v) ? v : null;
}

function buildPath(existing) {
  const home = os.homedir();
  const extras = [path.join(home, ".local/bin"), path.join(home, ".npm-global/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  return [...new Set([...extras, ...String(existing || "").split(":").filter(Boolean)])].join(":");
}

function serializePrompt(sessionHistory, goal) {
  const lines = [];
  for (const m of sessionHistory || []) {
    if (m.role === "user") lines.push(`User: ${m.content}`);
    else if (m.role === "assistant" && m.content) lines.push(`Assistant: ${m.content}`);
  }
  lines.push(lines.length ? `User: ${goal}` : goal);
  return lines.join("\n\n");
}

function parseStream(proc) {
  const out = { content: "", error: null, usage: null, costUsd: null, model: null, numTurns: null };
  let buf = "";
  let stderr = "";
  const handle = (line) => {
    let e;
    try { e = JSON.parse(line); } catch { return; }
    if (e.type === "system" && e.model) out.model = e.model;
    if (e.type === "assistant") {
      if (e.error || e.message?.model === "<synthetic>") {
        out.error = (e.message?.content || []).filter((b) => b.type === "text").map((b) => b.text).join(" ").trim() || String(e.error || "Claude CLI error");
      }
    }
    if (e.type === "result") {
      if (typeof e.result === "string") out.content = e.result;
      out.usage = e.usage || null;
      out.costUsd = e.total_cost_usd ?? null;
      out.numTurns = e.num_turns ?? null;
      if (e.is_error && !out.error) out.error = typeof e.result === "string" && e.result ? e.result : `Claude CLI error (${e.subtype || "unknown"})`;
    }
  };
  proc.stderr.on("data", (c) => { stderr += c.toString(); if (stderr.length > 8000) stderr = stderr.slice(-8000); });
  return new Promise((resolve, reject) => {
    proc.stdout.on("data", (c) => {
      buf += c.toString();
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) handle(line);
      }
    });
    proc.on("error", (err) => reject(new Error(`claude CLI spawn failed: ${err.message}`)));
    proc.on("close", (code) => {
      if (buf.trim()) handle(buf.trim());
      if (out.error) return reject(new Error(out.error));
      if (code !== 0) return reject(new Error(`claude CLI exited with code ${code}: ${stderr.slice(0, 1500)}`));
      resolve(out);
    });
  });
}

/**
 * Run one agent cycle through Claude CLI.
 * @returns {{ content: string, userMessage: string }}
 */
export async function runClaudeLocal({ goal, systemPrompt, sessionHistory = [], tools, agentType, model, maxTurns, onToolStart, onToolFinish, cfg }) {
  if (!model) {
    throw new Error(`No claude-local model configured for ${agentType}. Set claudeLocal.models.${ROLE_KEY[agentType] || "general"} (or .default) in user-config.json.`);
  }
  const timeoutMs = Number(cfg?.timeoutMs) > 0 ? Number(cfg.timeoutMs) : 4 * 60_000;
  const session = await openToolSession({ tools, ttlMs: timeoutMs + 60_000, onToolStart, onToolFinish });

  const mcpConfig = JSON.stringify({
    mcpServers: {
      meridian: { type: "http", url: session.url, headers: { Authorization: `Bearer ${session.token}` } },
    },
  });
  const allowed = session.toolNames.map((n) => `mcp__meridian__${n}`).join(",");
  const effort = resolveEffort(agentType, cfg);

  const args = [
    "--print",
    "--output-format", "stream-json",
    "--verbose",
    "--model", model,
    "--tools", "",                       // no built-in tools: no Bash/Read/Edit/Web
    "--strict-mcp-config",
    "--mcp-config", mcpConfig,
    "--setting-sources", "",             // ignore user/project settings, hooks, CLAUDE.md
    "--no-session-persistence",
    "--permission-mode", "bypassPermissions",
    "--max-turns", String(Math.max(1, Number(maxTurns) || 20)),
    "--append-system-prompt", systemPrompt,
  ];
  if (allowed) args.push("--allowedTools", allowed);
  if (effort) args.push("--effort", effort);

  const command = cfg?.command || "claude";
  log("agent", `[claude-local] ${agentType}: model=${model}${effort ? ` effort=${effort}` : ""} tools=${session.toolNames.length} max-turns=${maxTurns}`);

  // Run in an empty scratch dir so no project files are in scope.
  const cwd = os.tmpdir();
  const env = { ...process.env, PATH: buildPath(process.env.PATH) };
  // Never hand Meridian secrets to the CLI process environment.
  for (const k of Object.keys(env)) {
    if (/PRIVATE_KEY|WALLET|SECRET|API_KEY|TOKEN|PASSWORD|RPC_URL/i.test(k) && !/^ANTHROPIC_|^CLAUDE_/i.test(k)) delete env[k];
  }

  const proc = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  proc.stdin.end(serializePrompt(sessionHistory, goal));

  const killTimer = setTimeout(() => {
    log("agent", `[claude-local] hard timeout ${Math.round(timeoutMs / 1000)}s — killing claude CLI`);
    try { proc.kill("SIGTERM"); } catch { /* ignore */ }
    setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* ignore */ } }, 5000).unref();
  }, timeoutMs);

  try {
    const out = await parseStream(proc);
    const { toolCalls } = session.stats();
    log("agent", `[claude-local] done: turns=${out.numTurns ?? "?"} tool_calls=${toolCalls}${out.costUsd != null ? ` cost=$${Number(out.costUsd).toFixed(4)} (subscription)` : ""}`);
    if (out.content) log("agent", out.content);
    return { content: out.content || "", userMessage: goal, toolCalls };
  } finally {
    clearTimeout(killTimer);
    session.close();
  }
}
