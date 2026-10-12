// Offline test for the features ported from nightly-2026-04. No network, no wallet.
// Run: node test/test-ported.js
import assert from "assert";
import fs from "fs";
import { repoPath } from "../repo-root.js";

process.env.DRY_RUN = "true";
const files = ["state.json", "lessons.json", "traxr-log.jsonl"].map((f) => repoPath(f));
const backup = Object.fromEntries(files.map((f) => [f, fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null]));
let failures = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}: ${e.message}`); }
};

try {
  const { config } = await import("../config.js");
  const state = await import("../state.js");
  const mgmt = { ...config.management, stopLossPct: -15, trailingTakeProfit: false, outOfRangeWaitMinutes: 9999, minFeePerTvl24h: null };

  const track = (addr, extra = {}) => state.trackPosition({
    position: addr, pool: "Pool" + addr, pool_name: "T-SOL", strategy: "bid_ask", bin_range: { min: 1, max: 2 },
    amount_sol: 0.5, active_bin: 1, bin_step: 100, volatility: 2, fee_tvl_ratio: 1, organic_score: 70, initial_value_usd: 100, ...extra,
  });

  await t("defaults: age 24h/<2%, OOR x4, vol spike 3x", () => {
    assert.equal(config.management.maxPositionAgeMinutes, 1440);
    assert.equal(config.management.maxPositionAgePnlPct, 2);
    assert.equal(config.management.oorFrequencyLimit, 4);
    assert.equal(config.management.volatilitySpikeRatio, 3);
  });

  await t("STALE_POSITION fires after max age when PnL below threshold", () => {
    track("A1");
    const r = state.updatePnlAndCheckExits("A1", { pnl_pct: 1, in_range: true, age_minutes: 1500 }, mgmt);
    assert.equal(r?.action, "STALE_POSITION");
    const ok = state.updatePnlAndCheckExits("A1", { pnl_pct: 5, in_range: true, age_minutes: 1500 }, mgmt);
    assert.equal(ok, null, "should not close a profitable aged position");
  });

  await t("OOR_FREQUENCY counts separate OOR events", () => {
    track("B1");
    let r = null;
    for (let i = 0; i < 4; i++) {
      r = state.updatePnlAndCheckExits("B1", { pnl_pct: 0, in_range: false, age_minutes: 10 }, mgmt);
      if (i < 3) assert.equal(r, null, `fired too early at event ${i + 1}`);
      state.updatePnlAndCheckExits("B1", { pnl_pct: 0, in_range: true, age_minutes: 10 }, mgmt);
    }
    assert.equal(r?.action, "OOR_FREQUENCY");
  });

  await t("VOLATILITY_SPIKE uses current_volatility vs deploy volatility", () => {
    track("C1", { volatility: 2 });
    assert.equal(state.updatePnlAndCheckExits("C1", { pnl_pct: 0, in_range: true, age_minutes: 10, current_volatility: 4 }, mgmt), null);
    assert.equal(state.updatePnlAndCheckExits("C1", { pnl_pct: 0, in_range: true, age_minutes: 10, current_volatility: 6.5 }, mgmt)?.action, "VOLATILITY_SPIKE");
  });

  await t("null disables each new exit", () => {
    track("D1", { volatility: 2 });
    const off = { ...mgmt, maxPositionAgeMinutes: null, oorFrequencyLimit: null, volatilitySpikeRatio: null };
    assert.equal(state.updatePnlAndCheckExits("D1", { pnl_pct: 0, in_range: true, age_minutes: 99999, current_volatility: 100 }, off), null);
  });

  await t("suspect PnL records are excluded from lessons + evolution", async () => {
    const lessons = await import("../lessons.js");
    const before = JSON.parse(fs.existsSync(repoPath("lessons.json")) ? fs.readFileSync(repoPath("lessons.json"), "utf8") : '{"lessons":[]}').lessons?.length ?? 0;
    await lessons.recordPerformance({
      position: "S1", pool: "PoolS1", pool_name: "SUS-SOL", strategy: "bid_ask", amount_sol: 0.5,
      initial_value_usd: 100, final_value_usd: 25, fees_earned_usd: 0, minutes_held: 60, minutes_in_range: 10,
      close_reason: "out of range", pnl_source_suspect: true,
    });
    const after = JSON.parse(fs.readFileSync(repoPath("lessons.json"), "utf8"));
    assert.equal(after.lessons.length, before, "a lesson was derived from a suspect record");
    const perf = Array.from({ length: 10 }, (_, i) => ({ pnl_pct: -50, pnl_source_suspect: true, i }));
    assert.equal(lessons.evolveThresholds(perf, config), null, "evolution ran on suspect-only data");
  });

  await t("Traxr is log-only and never removes candidates", async () => {
    const realFetch = global.fetch;
    global.fetch = async (u) => (String(u).includes("traxr")
      ? { ok: true, status: 200, json: async () => ({ score: 5, impact: "CRITICAL", nodes: { stability: 0, depth: 1 } }) }
      : realFetch(u));
    const { annotateTraxr } = await import("../tools/traxr.js");
    const cands = [{ pool: "P1", name: "BAD-SOL", base: { mint: "M1" } }, { pool: "P2", name: "BAD2-SOL", base: { mint: "M2" } }];
    await annotateTraxr(cands, { source: "gmgn" });
    global.fetch = realFetch;
    assert.equal(cands.length, 2, "candidate removed");
    assert.equal(cands[0].traxr_score, 5);
    assert.ok(fs.readFileSync(repoPath("traxr-log.jsonl"), "utf8").includes('"pool":"P1"'));
  });

  await t("claude-local wiring: provider per role, models tunable", async () => {
    assert.deepEqual(Object.keys(config.llm.provider).sort(), ["general", "management", "screening"]);
    assert.equal(config.llm.provider.screening, "openai", "default provider should stay openai");
    const { resolveClaudeLocalModel } = await import("../adapters/claude-local.js");
    assert.equal(resolveClaudeLocalModel("SCREENER", { models: { default: "sonnet", screening: "opus" } }), "opus");
    assert.equal(resolveClaudeLocalModel("MANAGER", { models: { default: "sonnet" } }), "sonnet");
    const { executeTool } = await import("../tools/executor.js");
    const bad = await executeTool("update_config", { changes: { claudeLocalEffort: "turbo" }, reason: "test" });
    assert.notEqual(bad.success, true, "invalid effort accepted");
  });
} finally {
  for (const [f, content] of Object.entries(backup)) {
    if (content == null) { if (fs.existsSync(f)) fs.unlinkSync(f); }
    else fs.writeFileSync(f, content);
  }
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
