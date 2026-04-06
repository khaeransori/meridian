// adapters/claude-local/execute.js
//
// Claude Local adapter — shells out to the `claude` CLI in headless mode
// (--print). Uses the user's Claude Max subscription via `claude login`.
//
// Tools are exposed via the embedded MCP HTTP server (mcp-http-server.js)
// when available, otherwise falls back to the stdio MCP server. The HTTP
// transport eliminates ~2-3s of cold-start overhead per cycle by reusing
// Meridian's already-loaded modules and RPC connections.

import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { log } from "../../logger.js";
import { parseClaudeStreamJson } from "./parse.js";

const STDIO_CONFIG_PATH = path.resolve("mcp-server/config.json");

/**
 * Build an MCP config file pointing at the embedded HTTP server when enabled.
 * Falls back to the stdio config (mcp-server/index.js spawned per call) when
 * `mcpHttp.enabled` is false.
 */
function buildMcpConfigPath(mcpHttpConfig) {
  if (!mcpHttpConfig?.enabled) return STDIO_CONFIG_PATH;
  const dir = mkdtempSync(path.join(os.tmpdir(), "meridian-mcp-"));
  const filePath = path.join(dir, "mcp-config.json");
  const url = `http://${mcpHttpConfig.host || "127.0.0.1"}:${mcpHttpConfig.port || 8765}/mcp`;
  const config = {
    mcpServers: {
      meridian: {
        type: "http",
        url,
      },
    },
  };
  writeFileSync(filePath, JSON.stringify(config));
  return filePath;
}

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
  tools,                   // OpenAI-format tools filtered by role (we use this for --allowedTools)
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
  const mcpConfigPath = buildMcpConfigPath(config.mcpHttp);

  // Build the MCP-namespaced allow-list for this role so Claude CLI doesn't
  // defer-load all 47 tools (which adds a ToolSearch round-trip per call).
  const allowedToolsArg = Array.isArray(tools) && tools.length > 0
    ? tools.map((t) => `mcp__meridian__${t.function?.name ?? t.name}`).join(",")
    : null;

  // Combine session history + new user message into a single conversational prompt.
  const promptText = serializePrompt(sessionHistory, userPrompt);

  const args = [
    "--print",
    "--output-format", "stream-json",
    "--verbose", // required by claude CLI when using --print + stream-json
    "--mcp-config", mcpConfigPath,
    "--model", model,
    "--append-system-prompt", systemPrompt,
    "--dangerously-skip-permissions",
    "--max-turns", String(maxTurns),
    ...(allowedToolsArg ? ["--allowedTools", allowedToolsArg] : []),
    ...extraArgs,
  ];

  const toolCount = Array.isArray(tools) ? tools.length : 0;
  log("agent", `[claude-local] Spawning: ${command} --print --model ${model} (max-turns: ${maxTurns}, allowed-tools: ${toolCount})`);

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

  // Tool execution happens via MCP server (HTTP or stdio). The executor's
  // own logs ([tool_name] ✓ ... format) come through automatically when
  // using the embedded HTTP server. We only need adapter-level logging
  // when using stdio (separate process), which we detect by checking
  // whether the embedded HTTP server is enabled.
  const inProcessExecution = config.mcpHttp?.enabled === true;
  for (const tc of parsed.toolCalls) {
    const cleanName = tc.name.replace(/^mcp__meridian__/, "");
    if (!inProcessExecution) {
      // stdio mode: executor logs went to a separate process — surface a summary here
      log("tool", `[${cleanName}] ${summarizeResult(tc.result)}`);
    }
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
