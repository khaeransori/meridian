// mcp-http-server.js
//
// Embedded MCP server that runs inside Meridian's main process.
// Exposes the same tools as mcp-server/index.js (stdio version) but via
// streamable HTTP transport so the Claude CLI can connect without spawning
// a fresh Node process per call.
//
// This eliminates ~2-3s of cold-start overhead per cycle (Solana SDK +
// Meteora SDK module loading) because the MCP server shares Meridian's
// already-warm imports and RPC connections.

import http from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { tools as toolDefs } from "./tools/definitions.js";
import { executeTool } from "./tools/executor.js";
import { log } from "./logger.js";

const DEFAULT_PORT = 8765;
const DEFAULT_HOST = "127.0.0.1"; // localhost only — no external access

function buildMcpServer() {
  const server = new Server(
    { name: "meridian", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefs.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      inputSchema: t.function.parameters,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      const result = await executeTool(name, args || {});
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: e.message }) }],
      };
    }
  });

  return server;
}

/**
 * Start the embedded MCP HTTP server.
 * Returns the chosen { host, port } once listening.
 */
export async function startMcpHttpServer({ port = DEFAULT_PORT, host = DEFAULT_HOST } = {}) {
  // Stateful mode — Claude CLI sessions get unique session IDs
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  const mcpServer = buildMcpServer();
  await mcpServer.connect(transport);

  const httpServer = http.createServer(async (req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found — MCP endpoint is /mcp");
      return;
    }

    // Buffer body so we can pass it pre-parsed (transport supports it)
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      let parsed;
      if (body) {
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON body" }));
          return;
        }
      }
      try {
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

  return new Promise((resolve, reject) => {
    httpServer.once("error", (err) => {
      log("mcp_http", `Failed to start: ${err.message}`);
      reject(err);
    });
    httpServer.listen(port, host, () => {
      log("startup", `MCP HTTP: listening on http://${host}:${port}/mcp`);
      resolve({ host, port, server: httpServer });
    });
  });
}
