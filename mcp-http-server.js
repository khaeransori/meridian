// mcp-http-server.js
//
// In-process MCP server for the claude-local LLM provider (ported from nightly-2026-04,
// hardened). Runs inside Meridian's own process on 127.0.0.1 so Claude CLI calls reuse
// the already-loaded SDKs and RPC connections, and every tool call goes through the
// same executeTool() safety checks as the OpenRouter path.
//
// Hardening vs the April version:
// - Random port + per-cycle bearer token: only the claude process we spawned can call tools.
// - Per-cycle tool allowlist: the CLI only sees (and can only call) the role's tools.
// - Same ONCE_PER_SESSION / NO_RETRY rules as agent.js (no double deploy/swap/close).
// - Session expires when the cycle ends.

import http from "node:http";
import { randomBytes } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { executeTool } from "./tools/executor.js";
import { log } from "./logger.js";

const HOST = "127.0.0.1";
const ONCE_PER_SESSION = new Set(["deploy_position", "swap_token", "close_position"]);
const NO_RETRY_TOOLS = new Set(["deploy_position"]);

const _sessions = new Map(); // token -> { tools: Map(name -> def), firedOnce: Set, hooks, expiresAt }
let _serverPromise = null;

function buildMcpServer(session) {
  const server = new Server({ name: "meridian", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...session.tools.values()].map((t) => ({
      name: t.function.name,
      description: t.function.description,
      inputSchema: t.function.parameters,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const reply = (obj, isError = false) => ({ isError, content: [{ type: "text", text: JSON.stringify(obj) }] });

    if (!session.tools.has(name)) {
      log("mcp_http", `Blocked tool outside role allowlist: ${name}`);
      return reply({ blocked: true, error: `Tool ${name} is not available for this role.` }, true);
    }
    if (ONCE_PER_SESSION.has(name) && session.firedOnce.has(name)) {
      return reply({ blocked: true, reason: `${name} already attempted this session — do not retry. If it failed, report the error and stop.` }, true);
    }

    const step = ++session.step;
    await session.hooks.onToolStart?.({ name, args: args || {}, step });
    let result;
    try {
      result = await executeTool(name, args || {});
    } catch (e) {
      result = { success: false, error: e.message };
    }
    const ok = result?.success !== false && !result?.error && !result?.blocked;
    await session.hooks.onToolFinish?.({ name, args: args || {}, result, success: ok, step });

    if (NO_RETRY_TOOLS.has(name)) session.firedOnce.add(name);
    else if (ONCE_PER_SESSION.has(name) && result?.success === true) session.firedOnce.add(name);
    session.toolCalls += 1;

    return reply(result, !ok);
  });

  return server;
}

function startServer() {
  if (_serverPromise) return _serverPromise;
  _serverPromise = new Promise((resolve, reject) => {
    const httpServer = http.createServer((req, res) => {
      const auth = String(req.headers.authorization || "");
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const session = token ? _sessions.get(token) : null;
      if (!session || Date.now() > session.expiresAt) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (req.url !== "/mcp") {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 2_000_000) req.destroy();
      });
      req.on("end", async () => {
        let parsed;
        if (body) {
          try { parsed = JSON.parse(body); } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid JSON" }));
            return;
          }
        }
        // Stateless: fresh Server + Transport per HTTP request (each CLI run re-initializes).
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const mcpServer = buildMcpServer(session);
        res.on("close", () => {
          try { transport.close(); } catch { /* ignore */ }
          try { mcpServer.close(); } catch { /* ignore */ }
        });
        try {
          await mcpServer.connect(transport);
          await transport.handleRequest(req, res, parsed);
        } catch (e) {
          log("mcp_http", `Request error: ${e.message}`);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e.message }));
          }
        }
      });
    });
    httpServer.once("error", (err) => {
      _serverPromise = null;
      reject(err);
    });
    httpServer.listen(0, HOST, () => {
      const { port } = httpServer.address();
      httpServer.unref(); // never keep the process alive on its own
      log("startup", `MCP HTTP (claude-local) listening on http://${HOST}:${port}/mcp`);
      resolve({ host: HOST, port });
    });
  });
  return _serverPromise;
}

/**
 * Open a tool session for one agent cycle.
 * Returns { url, token, close(), stats() }.
 */
export async function openToolSession({ tools, ttlMs = 10 * 60_000, onToolStart = null, onToolFinish = null }) {
  const { host, port } = await startServer();
  const token = randomBytes(24).toString("hex");
  const session = {
    tools: new Map((tools || []).map((t) => [t.function.name, t])),
    firedOnce: new Set(),
    hooks: { onToolStart, onToolFinish },
    expiresAt: Date.now() + ttlMs,
    step: 0,
    toolCalls: 0,
  };
  _sessions.set(token, session);
  return {
    url: `http://${host}:${port}/mcp`,
    token,
    toolNames: [...session.tools.keys()],
    stats: () => ({ toolCalls: session.toolCalls }),
    close: () => _sessions.delete(token),
  };
}
