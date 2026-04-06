// adapters/claude-local/execute.js
//
// Claude Local adapter — shells out to the `claude` CLI in headless mode
// (--print). Uses the user's Claude Max subscription via `claude login`.
// Tools are exposed to Claude via the Meridian MCP server (mcp-server/).

import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { log } from "../../logger.js";
import { parseClaudeStreamJson } from "./parse.js";

const MCP_CONFIG_PATH = path.resolve("mcp-server/config.json");

/**
 * Build a PATH that includes common Claude CLI install locations.
 * Daemon processes (PM2, systemd) don't inherit interactive shell PATH,
 * so `~/.local/bin` and `~/.npm-global/bin` are typically missing even
 * though that's where `claude` is installed.
 */
function buildClaudePath(existingPath) {
  const home = os.homedir();
  const extras = [
    path.join(home, ".local/bin"),
    path.join(home, ".npm-global/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  const current = (existingPath || "").split(":").filter(Boolean);
  const merged = [...new Set([...extras, ...current])];
  return merged.join(":");
}

export async function execute({
  systemPrompt,
  userPrompt,
  sessionHistory = [],
  tools,                   // unused — Claude CLI gets tools via MCP, not API
  agentType,
  model,
  maxTurns,
  maxOutputTokens,         // unused — claude CLI doesn't take a token limit flag
  toolExecutor,            // unused — tool execution happens via MCP server
  onToolStart,             // best-effort: invoked from tool_use events
  onToolFinish,
  toolChoiceForFirstStep,  // unused — Claude decides when to call tools
}) {
  const { config } = await import("../../config.js");
  const cfg = config.claudeLocal || {};
  const command = cfg.command || "claude";
  const extraArgs = Array.isArray(cfg.extraArgs) ? cfg.extraArgs : [];

  // Combine session history + new user message into a single conversational prompt.
  const promptText = serializePrompt(sessionHistory, userPrompt);

  const args = [
    "--print",
    "--output-format", "stream-json",
    "--verbose", // required by claude CLI when using --print + stream-json
    "--mcp-config", MCP_CONFIG_PATH,
    "--model", model,
    "--append-system-prompt", systemPrompt,
    "--dangerously-skip-permissions",
    "--max-turns", String(maxTurns),
    ...extraArgs,
  ];

  log("agent", `[claude-local] Spawning: ${command} --print --model ${model} (max-turns: ${maxTurns})`);

  const proc = spawn(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, PATH: buildClaudePath(process.env.PATH) },
    stdio: ["pipe", "pipe", "pipe"],
  });

  proc.stdin.write(promptText);
  proc.stdin.end();

  let parsed;
  try {
    parsed = await parseClaudeStreamJson(proc);
  } catch (e) {
    log("agent", `[claude-local] Error: ${e.message}`);
    throw e;
  }

  // Surface tool calls to the main log + best-effort callbacks for Telegram.
  // Claude executes tools via the MCP server (separate process), so these
  // logs are reconstructed from the parsed stream events.
  for (const tc of parsed.toolCalls) {
    // Strip the mcp__meridian__ prefix that MCP namespaces add
    const cleanName = tc.name.replace(/^mcp__meridian__/, "");
    const summary = summarizeResult(tc.result);
    log("tool", `[${cleanName}] ${summary}`);
    if (onToolStart) await onToolStart(cleanName, tc.args);
    if (onToolFinish) await onToolFinish(cleanName, tc.result);
  }

  return {
    content: parsed.content,
    toolCalls: parsed.toolCalls,
    usage: parsed.usage,
    costUsd: parsed.costUsd ?? 0,  // Max subscription billing — typically 0
    billingType: "subscription",
    model: parsed.model || model,
  };
}

/**
 * Build a one-line summary of an MCP tool result for logging.
 * Tool results from MCP are shaped like [{ type: "text", text: "<json>" }]
 * — extract the text and try to parse it as JSON for a compact preview.
 */
function summarizeResult(result) {
  if (result == null) return "(no result)";
  let payload = result;
  if (Array.isArray(result)) {
    const text = result.find((b) => b?.type === "text")?.text;
    payload = text ?? result;
  }
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch { /* keep as string */ }
  }
  if (typeof payload === "string") return `✓ ${payload.slice(0, 120)}`;
  if (payload && typeof payload === "object") {
    if (payload.error) return `✗ ${String(payload.error).slice(0, 120)}`;
    const keys = Object.keys(payload).slice(0, 3);
    const preview = keys.map((k) => `${k}=${formatVal(payload[k])}`).join(" ");
    return `✓ ${preview}`;
  }
  return "✓";
}

function formatVal(v) {
  if (v == null) return "null";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v.length > 30 ? v.slice(0, 27) + "..." : v;
  if (Array.isArray(v)) return `[${v.length}]`;
  if (typeof v === "object") return "{...}";
  return String(v);
}

function serializePrompt(sessionHistory, userPrompt) {
  if (sessionHistory.length === 0) return userPrompt;
  const lines = [];
  for (const msg of sessionHistory) {
    if (msg.role === "user") lines.push(`User: ${msg.content}`);
    else if (msg.role === "assistant") lines.push(`Assistant: ${msg.content || ""}`);
  }
  lines.push(`User: ${userPrompt}`);
  return lines.join("\n\n");
}
