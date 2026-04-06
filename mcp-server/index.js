// mcp-server/index.js
//
// Exposes Meridian's tools via MCP stdio. Spawned by the Claude CLI when
// `claude --mcp-config mcp-server/config.json` is invoked.
//
// Tool definitions come from ../tools/definitions.js (OpenAI function format).
// Tool execution delegates to ../tools/executor.js (the same executor used
// by the OpenRouter adapter — same safety checks, same state updates).

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// Load .env from the meridian root (parent directory of mcp-server/) so the
// executor sees WALLET_PRIVATE_KEY, RPC_URL, and other env-driven config.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { tools as toolDefs } from "../tools/definitions.js";
import { executeTool } from "../tools/executor.js";

const server = new Server(
  { name: "meridian", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// Convert OpenAI function-calling format → MCP tool format
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolDefs.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    inputSchema: t.function.parameters,
  })),
}));

// Tool execution — delegate to Meridian's existing executor
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

const transport = new StdioServerTransport();
await server.connect(transport);
