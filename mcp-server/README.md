# Meridian MCP Server

Exposes Meridian's DLMM tools (deploy, close, screen, etc.) via the Model
Context Protocol so the Claude CLI can call them directly.

This server is **stateless** — Claude CLI spawns it on demand via stdio,
the server reads tool definitions from `../tools/definitions.js` and
delegates execution to `../tools/executor.js`. When Claude exits, the
server exits.

## Used by

The `claude-local` adapter (`../adapters/claude-local/execute.js`) passes
this directory's `config.json` to `claude --mcp-config`.

## Adding tools

You don't. Tools are read from `../tools/definitions.js` automatically.
The MCP server is purely a transport layer — all tool implementations
live in Meridian's main `tools/` folder.
