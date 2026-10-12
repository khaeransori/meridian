// Offline test for paper trading (DRY_RUN). Fake Meteora + Jupiter responses, no wallet tx.
// Run: node test/test-paper.js
import assert from "assert";
import fs from "fs";
import { repoPath } from "../repo-root.js";

process.env.DRY_RUN = "true";
const files = ["paper-positions.json", "state.json", "lessons.json", "decision-log.json", "pool-memory.json"].map((f) => repoPath(f));
const backup = Object.fromEntries(files.map((f) => [f, fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null]));
for (const f of files) if (fs.existsSync(f)) fs.unlinkSync(f);

let failures = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}: ${e.stack.split("\n").slice(0, 2).join(" | ")}`); }
};

// Fake market: token at 0.001 SOL, SOL $100, TVL $50k, fees $500/h.
const market = { priceSol: 0.001, solUsd: 100, tvl: 50_000, fees1h: 500, quoteImpact: 0.02 };
const realFetch = global.fetch;
global.fetch = async (u) => {
  const s = String(u);
  if (s.includes("pool-discovery-api")) {
    return { ok: true, status: 200, json: async () => ({ data: [{
      name: "TEST-SOL", token_x: { address: "TestMint111", decimals: 6, price: market.priceSol * market.solUsd },
      token_y: { address: "So11111111111111111111111111111111111111112", price: market.solUsd },
      tvl: market.tvl, active_tvl: market.tvl, fee: market.fees1h, volatility: 2, dlmm_params: { bin_step: 100 },
    }] }) };
  }
  if (s.includes("api.jup.ag/swap/v1/quote")) {
    const amount = Number(new URL(s).searchParams.get("amount")) / 1e6;
    const out = amount * market.priceSol * (1 - market.quoteImpact);
    return { ok: true, status: 200, json: async () => ({ outAmount: String(Math.floor(out * 1e9)), priceImpactPct: String(market.quoteImpact), routePlan: [{ swapInfo: { label: "Meteora DLMM" } }] }) };
  }
  throw new Error("unexpected fetch " + s);
};

try {
  const paper = await import("../tools/paper.js");
  const state = await import("../state.js");

  let id;
  await t("open: simulated position, value = deposit", async () => {
    const pos = await paper.openPaperPosition({ pool_address: "PoolT", pool_name: "TEST-SOL", strategy: "bid_ask", amount_sol: 0.5, bins_below: 40, active_bin: 1000, bin_step: 100 });
    id = pos.position;
    state.trackPosition({ position: id, pool: "PoolT", pool_name: "TEST-SOL", strategy: "bid_ask", bin_range: { min: 960, max: 1000 }, amount_sol: 0.5, active_bin: 1000, bin_step: 100, volatility: 2, initial_value_usd: pos.initial_value_usd });
    assert.ok(id.startsWith("paper_"));
    assert.equal(Math.round(pos.bin_sol.reduce((a, b) => a + b, 0) * 1e9), 0.5e9);
    const [row] = await paper.getPaperPositions();
    assert.ok(Math.abs(row.pnl_pct) < 0.01, `pnl at entry should be ~0, got ${row.pnl_pct}`);
    assert.equal(row.in_range, true);
  });

  await t("bid_ask earns more once price sits in the heavy lower bins", async () => {
    const p = paper.getPaperPosition(id);
    const top = p.bin_sol[0], bottom = p.bin_sol[p.bin_sol.length - 1];
    assert.ok(bottom > top * 30, `weights top ${top} bottom ${bottom}`);
  });

  await t("price drop: SOL converts to token, PnL negative, still in range", async () => {
    market.priceSol = 0.001 / Math.pow(1.01, 20); // ~20 bins down (-18%)
    paper._clearSnapshotCache();
    const [row] = await paper.getPaperPositions();
    const pos = paper.getPaperPosition(id);
    assert.ok(pos.last.tokens > 0, "no tokens after drop");
    assert.ok(row.pnl_pct < 0 && row.pnl_pct > -18, `pnl ${row.pnl_pct}`);
    assert.equal(row.in_range, true);
  });

  await t("price below range: out of range, fully in token", async () => {
    market.priceSol = 0.001 / Math.pow(1.01, 60);
    paper._clearSnapshotCache();
    const [row] = await paper.getPaperPositions();
    assert.equal(row.in_range, false);
    assert.ok(paper.getPaperPosition(id).last.value_sol < 0.5);
  });

  await t("fees accrue only in range", async () => {
    market.priceSol = 0.001; // back to entry
    paper._clearSnapshotCache();
    const pos0 = JSON.parse(fs.readFileSync(repoPath("paper-positions.json"), "utf8")).open[id];
    pos0.last_mark_at = Date.now() - 3 * 60_000; // 3 min ago
    const d = JSON.parse(fs.readFileSync(repoPath("paper-positions.json"), "utf8")); d.open[id] = pos0;
    fs.writeFileSync(repoPath("paper-positions.json"), JSON.stringify(d));
    await paper.getPaperPositions();
    const fees = paper.getPaperPosition(id).fees_sol;
    // bid_ask, at the TOP bin: weight 1/861 → 0.5/861 SOL × 41 bins ≈ 0.0238 SOL ≈ $2.38 → share 4.76e-5 of $50k TVL
    // expected = $500/60 × 3 min × 4.76e-5 × 0.7 / $100 ≈ 8.3e-6 SOL (vs 1.75e-4 if the whole position earned)
    assert.ok(fees > 7e-6 && fees < 1e-5, `fees ${fees}`);
  });

  await t("close via dlmm.closePosition: real quote path, slippage counted, records performance", async () => {
    market.priceSol = 0.001 / Math.pow(1.01, 10); // some token leg to swap
    const { closePosition, getMyPositions } = await import("../tools/dlmm.js");
    const r = await closePosition({ position_address: id, reason: "test close" });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.ok(r.slippage_sol > 0, "slippage not counted");
    assert.equal(r.price_impact_pct, 2);
    assert.equal(r.base_mint, null, "would trigger a real auto-swap");
    const left = await getMyPositions({ force: true });
    assert.equal(left.source, "paper");
    assert.equal(left.total_positions, 0);
    const lessons = JSON.parse(fs.readFileSync(repoPath("lessons.json"), "utf8"));
    const perf = lessons.performance.at(-1);
    assert.equal(perf.paper, true);
    assert.equal(perf.close_reason, "test close");
    const sum = paper.getPaperSummary();
    assert.equal(sum.closed, 1);
  });

  await t("paper records never feed threshold evolution", async () => {
    const { evolveThresholds } = await import("../lessons.js");
    const { config } = await import("../config.js");
    const perf = Array.from({ length: 12 }, () => ({ pnl_pct: -30, paper: true }));
    assert.equal(evolveThresholds(perf, config), null);
  });

  await t("live mode untouched: isPaperMode false when DRY_RUN=false", async () => {
    process.env.DRY_RUN = "false";
    assert.equal(paper.isPaperMode(), false);
    process.env.DRY_RUN = "true";
  });
} finally {
  global.fetch = realFetch;
  for (const [f, c] of Object.entries(backup)) {
    if (c == null) { if (fs.existsSync(f)) fs.unlinkSync(f); }
    else fs.writeFileSync(f, c);
  }
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
