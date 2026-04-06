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

  // Best-effort tool callbacks (Claude already executed them via MCP — these
  // are just for logging/Telegram)
  if (onToolStart || onToolFinish) {
    for (const tc of parsed.toolCalls) {
      if (onToolStart) await onToolStart(tc.name, tc.args);
      if (onToolFinish) await onToolFinish(tc.name, tc.result);
    }
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
