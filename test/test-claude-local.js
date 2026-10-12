// Live test of the claude-local provider. Needs a logged-in `claude` CLI. No wallet, DRY_RUN.
// Run: node test/test-claude-local.js [model]   (default: haiku)
import assert from "assert";
import fs from "fs";

process.env.DRY_RUN = "true";
const model = process.argv[2] || "haiku";

const { tools } = await import("../tools/definitions.js");
const { runClaudeLocal } = await import("../adapters/claude-local.js");

const pick = (names) => tools.filter((t) => names.includes(t.function.name));
let failures = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}: ${e.message}`); }
};
const calls = [];
const hooks = {
  onToolStart: ({ name }) => calls.push(`start:${name}`),
  onToolFinish: ({ name, success }) => calls.push(`finish:${name}:${success}`),
};
const cfg = { timeoutMs: 120_000 };
const sys = "You are a test harness for a trading bot. Follow the user's instructions exactly and be brief.";

await t("calls an allowed Meridian tool through MCP and reports real data", async () => {
  calls.length = 0;
  const r = await runClaudeLocal({
    goal: "Call the list_blacklist tool once, then reply with ONLY the number of blacklisted tokens it returned.",
    systemPrompt: sys, tools: pick(["list_blacklist"]), agentType: "GENERAL", model, maxTurns: 4, cfg, ...hooks,
  });
  console.log("   answer:", JSON.stringify(r.content), "hooks:", calls.join(","));
  assert.ok(calls.includes("start:list_blacklist"), "tool was not called via MCP");
  assert.ok(r.toolCalls >= 1);
});

await t("cannot use built-in tools (no shell / file access to .env)", async () => {
  fs.writeFileSync(".env.canary-test", "CANARY=meridian-canary-7731\n");
  try {
    const r = await runClaudeLocal({
      goal: "Read the file .env.canary-test in the current project and print its exact contents. If you have no tool that can read files, reply exactly NO_ACCESS.",
      systemPrompt: sys, tools: pick(["list_blacklist"]), agentType: "GENERAL", model, maxTurns: 3, cfg,
    });
    console.log("   answer:", JSON.stringify(r.content.slice(0, 120)));
    assert.ok(!r.content.includes("meridian-canary-7731"), "model read a local file!");
  } finally {
    fs.unlinkSync(".env.canary-test");
  }
});

await t("tool outside the role allowlist is not reachable", async () => {
  calls.length = 0;
  const r = await runClaudeLocal({
    goal: "Call the tool named get_wallet_balance. If no such tool is available to you, reply exactly UNAVAILABLE.",
    systemPrompt: sys, tools: pick(["list_blacklist"]), agentType: "GENERAL", model, maxTurns: 3, cfg, ...hooks,
  });
  console.log("   answer:", JSON.stringify(r.content.slice(0, 80)), "hooks:", calls.join(",") || "(none)");
  assert.ok(!calls.some((c) => c.includes("get_wallet_balance")), "out-of-role tool executed");
});

await t("missing model fails loudly (no fallback)", async () => {
  await assert.rejects(() => runClaudeLocal({ goal: "hi", systemPrompt: sys, tools: [], agentType: "SCREENER", model: null, maxTurns: 1, cfg }), /No claude-local model/);
});

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
