// adapters/claude-local/parse.js
//
// Parses Claude CLI streaming JSON output (--output-format stream-json).
// Each line is a JSON event with a `type` field. We collect content,
// tool calls, and final usage.

export async function parseClaudeStreamJson(proc) {
  const result = {
    content: "",
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    model: null,
    sessionId: null,
    costUsd: null,
    error: null,
  };

  let stdoutBuffer = "";
  let stderrBuffer = "";

  proc.stderr.on("data", (chunk) => {
    stderrBuffer += chunk.toString();
  });

  return new Promise((resolve, reject) => {
    proc.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      let newlineIdx;
      while ((newlineIdx = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, newlineIdx).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
        if (!line) continue;

        try {
          const event = JSON.parse(line);
          handleEvent(event, result);
        } catch {
          // Ignore non-JSON lines (Claude CLI sometimes emits status text)
        }
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Claude CLI spawn failed: ${err.message}`));
    });

    proc.on("close", (code) => {
      // Flush any remaining buffer
      if (stdoutBuffer.trim()) {
        try {
          handleEvent(JSON.parse(stdoutBuffer.trim()), result);
        } catch { /* ignore */ }
      }

      if (code !== 0) {
        const stderr = stderrBuffer.slice(0, 2000);
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`));
        return;
      }

      resolve(result);
    });
  });
}

function handleEvent(event, result) {
  // Claude stream-json event shapes (subject to change — verify with actual CLI output)
  switch (event.type) {
    case "system":
      if (event.session_id) result.sessionId = event.session_id;
      if (event.model) result.model = event.model;
      break;
    case "assistant":
      // Assistant message — may contain text or tool_use blocks
      if (event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === "text") result.content += block.text;
          if (block.type === "tool_use") {
            result.toolCalls.push({
              name: block.name,
              args: block.input,
              result: null, // filled in by tool_result event
              id: block.id,
            });
          }
        }
      }
      if (event.message?.usage) {
        result.usage.inputTokens += event.message.usage.input_tokens || 0;
        result.usage.outputTokens += event.message.usage.output_tokens || 0;
      }
      break;
    case "user":
      // tool_result blocks come back as user messages
      if (event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === "tool_result") {
            const tc = result.toolCalls.find((t) => t.id === block.tool_use_id);
            if (tc) tc.result = block.content;
          }
        }
      }
      break;
    case "result":
      // Final result event — contains total usage and cost
      if (event.usage) {
        result.usage.inputTokens = event.usage.input_tokens || result.usage.inputTokens;
        result.usage.outputTokens = event.usage.output_tokens || result.usage.outputTokens;
      }
      if (event.total_cost_usd != null) result.costUsd = event.total_cost_usd;
      break;
    case "error":
      result.error = event.error || event.message || "unknown";
      break;
  }
}
