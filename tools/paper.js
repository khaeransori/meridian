/**
 * Paper trading for DRY_RUN.
 *
 * A dry-run deploy opens a simulated single-sided SOL position. It is marked to
 * market from real Meteora pool data, the same exit rules run on it, and on
 * close the token leg is priced with a real Jupiter quote (price impact +
 * route), so slippage is counted. Nothing is ever signed or sent.
 *
 * Model (single-sided SOL, bins from activeBin-N .. activeBin):
 *  - SOL is split across N+1 bins by strategy shape (spot = flat, curve = more
 *    near the active bin, bid_ask = more toward the bottom).
 *  - When price falls through a bin, that bin's SOL becomes token at the bin
 *    price (that's how DLMM fills). Value = remaining SOL + tokens * price.
 *  - Fees: while in range, the position earns
 *    pool_fees_per_minute * minutes * (position_value / pool_TVL) * paperFeeShare.
 *    paperFeeShare (default 0.7) is a haircut because only bins near the active
 *    bin earn, and our liquidity is spread wide.
 *  - Close: token leg -> SOL via Jupiter quote, minus estimated network fees.
 *
 * Limitations (said plainly in the report): fees are an estimate, the price
 * feed is the Meteora API (~1 min fresh), and bins partially filled are
 * interpolated. Treat paper PnL as optimistic-but-honest, not exact.
 */

import fs from "fs";
import { config } from "../config.js";
import { log } from "../logger.js";
import { repoPath } from "../repo-root.js";

const FILE = repoPath("paper-positions.json");
const SOL_MINT = "So11111111111111111111111111111111111111112";
const POOL_API = "https://pool-discovery-api.datapi.meteora.ag/pools";
const JUP_QUOTE = "https://api.jup.ag/swap/v1/quote";
const DEFAULT_JUP_KEY = "b15d42e9-e0e4-4f90-a424-ae41ceeaa382"; // same public default as wallet.js
const NETWORK_FEE_SOL = 0.00025 * 3; // claim + close + swap, incl. priority fee estimate
const MAX_ACCRUAL_MIN = 5; // don't invent fees across downtime gaps
const SNAPSHOT_TTL_MS = 30_000;

export function isPaperMode() {
  return process.env.DRY_RUN === "true";
}

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return { open: d.open || {}, closed: d.closed || [] };
  } catch {
    return { open: {}, closed: [] };
  }
}
function save(d) {
  fs.writeFileSync(FILE, JSON.stringify(d, null, 2));
}

// ─── Market snapshot (Meteora pool API, 1h timeframe for fee rate) ──
const _snap = new Map();
export function _clearSnapshotCache() { _snap.clear(); } // tests
export async function getPoolSnapshot(pool_address, { force = false } = {}) {
  const hit = _snap.get(pool_address);
  if (!force && hit && Date.now() - hit.at < SNAPSHOT_TTL_MS) return hit.data;
  const url = `${POOL_API}?page_size=1&filter_by=${encodeURIComponent(`pool_address=${pool_address}`)}&timeframe=1h`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`pool API ${res.status}`);
  const p = (await res.json())?.data?.[0];
  if (!p) throw new Error("pool not found in Meteora API");
  const solUsd = Number(p.token_y?.price);
  const tokenUsd = Number(p.token_x?.price);
  if (p.token_y?.address !== SOL_MINT || !(solUsd > 0) || !(tokenUsd > 0)) {
    throw new Error("unsupported pool for paper trading (quote token must be SOL with live prices)");
  }
  const data = {
    name: p.name,
    base_mint: p.token_x.address,
    base_decimals: Number(p.token_x.decimals ?? 6),
    price_sol: tokenUsd / solUsd, // token price in SOL
    sol_usd: solUsd,
    tvl_usd: Number(p.active_tvl ?? p.tvl) || Number(p.tvl) || 0,
    fees_1h_usd: Number(p.fee) || 0,
    volatility: p.volatility != null ? Number(p.volatility) : null,
    bin_step: Number(p.dlmm_params?.bin_step) || null,
  };
  _snap.set(pool_address, { at: Date.now(), data });
  return data;
}

function weights(strategy, n) {
  // index k = bins below the entry active bin (0 = active bin, n = bottom)
  const w = [];
  for (let k = 0; k <= n; k++) {
    if (strategy === "spot") w.push(1);
    else if (strategy === "curve") w.push(n + 1 - k);
    else w.push(k + 1); // bid_ask: heavier further down
  }
  const s = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / s);
}

/** Value the position at token price `price` (in SOL). Returns SOL/token legs. */
function valueAt(pos, price) {
  const step = 1 + pos.bin_step / 10_000;
  // how many bins price has moved DOWN from entry (negative = moved up)
  const kNow = Math.log(pos.entry_price_sol / price) / Math.log(step);
  let sol = 0;
  let tokens = 0;
  pos.bin_sol.forEach((s, k) => {
    const binPrice = pos.entry_price_sol / Math.pow(step, k);
    const filled = Math.min(1, Math.max(0, kNow - k + 0.5)); // share of this bin already swapped to token
    sol += s * (1 - filled);
    tokens += (s * filled) / binPrice;
  });
  const n = pos.bin_sol.length - 1;
  const inRange = kNow >= -0.5 && kNow <= n + 0.5;
  return { sol, tokens, value_sol: sol + tokens * price, kNow, inRange, activeBin: pos.entry_active_bin - Math.round(kNow) };
}

export async function openPaperPosition({ pool_address, pool_name, strategy, amount_sol, bins_below, active_bin, bin_step }) {
  const snap = await getPoolSnapshot(pool_address, { force: true });
  const n = Math.max(1, Number(bins_below));
  const w = weights(strategy, n);
  const id = `paper_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const pos = {
    position: id,
    pool: pool_address,
    pool_name: pool_name || snap.name,
    base_mint: snap.base_mint,
    base_decimals: snap.base_decimals,
    strategy,
    amount_sol,
    bin_step: Number(bin_step) || snap.bin_step,
    bins_below: n,
    entry_active_bin: active_bin,
    entry_price_sol: snap.price_sol,
    entry_sol_usd: snap.sol_usd,
    initial_value_usd: amount_sol * snap.sol_usd,
    bin_sol: w.map((x) => x * amount_sol),
    fees_sol: 0,
    claimed_sol: 0,
    opened_at: new Date().toISOString(),
    last_mark_at: Date.now(),
    last: null,
  };
  const d = load();
  d.open[id] = pos;
  save(d);
  log("paper", `OPEN ${pos.pool_name} ${amount_sol} SOL ${strategy} bins_below=${n} entry=${snap.price_sol.toExponential(4)} SOL/token (${id})`);
  return pos;
}

/** Mark one paper position to market (accrues fees). Returns a getMyPositions-shaped row. */
async function mark(pos) {
  const snap = await getPoolSnapshot(pos.pool);
  const v = valueAt(pos, snap.price_sol);
  const now = Date.now();
  const dtMin = Math.min(MAX_ACCRUAL_MIN, Math.max(0, (now - (pos.last_mark_at || now)) / 60_000));
  if (v.inRange && snap.tvl_usd > 0 && dtMin > 0) {
    const share = Math.min(1, (v.value_sol * snap.sol_usd) / snap.tvl_usd);
    const feeShare = Number(config.management.paperFeeShare ?? 0.7);
    pos.fees_sol += ((snap.fees_1h_usd / 60) * dtMin * share * feeShare) / snap.sol_usd;
  }
  pos.last_mark_at = now;
  const unclaimed = pos.fees_sol - pos.claimed_sol;
  const totalSol = v.value_sol + pos.fees_sol - (pos.extra_network_sol || 0);
  const solMode = !!config.management.solMode;
  const usd = (x) => x * snap.sol_usd;
  const pnlPct = ((usd(totalSol) - pos.initial_value_usd) / pos.initial_value_usd) * 100;
  pos.last = { price_sol: snap.price_sol, value_sol: v.value_sol, tokens: v.tokens, in_range: v.inRange, at: new Date().toISOString() };
  const ageMin = Math.floor((now - new Date(pos.opened_at).getTime()) / 60_000);
  return {
    position: pos.position,
    pool: pos.pool,
    pair: `${pos.pool_name} (paper)`,
    base_mint: pos.base_mint,
    lower_bin: pos.entry_active_bin - pos.bins_below,
    upper_bin: pos.entry_active_bin,
    active_bin: v.activeBin,
    in_range: v.inRange,
    unclaimed_fees_usd: Math.round((solMode ? unclaimed : usd(unclaimed)) * 10000) / 10000,
    total_value_usd: Math.round((solMode ? v.value_sol : usd(v.value_sol)) * 10000) / 10000,
    total_value_true_usd: Math.round(usd(v.value_sol) * 10000) / 10000,
    collected_fees_usd: Math.round((solMode ? pos.fees_sol : usd(pos.fees_sol)) * 10000) / 10000,
    collected_fees_true_usd: Math.round(usd(pos.fees_sol) * 10000) / 10000,
    pnl_usd: Math.round((solMode ? totalSol - pos.amount_sol : usd(totalSol) - pos.initial_value_usd) * 10000) / 10000,
    pnl_true_usd: Math.round((usd(totalSol) - pos.initial_value_usd) * 10000) / 10000,
    pnl_pct: Math.round(pnlPct * 100) / 100,
    pnl_pct_derived: null,
    pnl_pct_diff: null,
    pnl_pct_suspicious: false,
    fee_per_tvl_24h: snap.tvl_usd > 0 ? Math.round(((snap.fees_1h_usd * 24) / snap.tvl_usd) * 10000) / 100 : null,
    age_minutes: ageMin,
    minutes_out_of_range: null, // filled by caller from state.js
    instruction: null,
    paper: true,
  };
}

/** All open paper positions, marked to market. Errors on one pool don't drop the others. */
export async function getPaperPositions() {
  const d = load();
  const rows = [];
  for (const pos of Object.values(d.open)) {
    try {
      rows.push(await mark(pos));
    } catch (e) {
      log("paper_warn", `mark failed for ${pos.pool_name}: ${e.message} — PnL rules paused this tick`);
      rows.push({
        position: pos.position, pool: pos.pool, pair: `${pos.pool_name} (paper)`, base_mint: pos.base_mint,
        in_range: pos.last?.in_range ?? true, pnl_pct: null, pnl_pct_suspicious: true, paper: true,
        age_minutes: Math.floor((Date.now() - new Date(pos.opened_at).getTime()) / 60_000),
      });
    }
  }
  save(d);
  return rows;
}

export function getPaperPosition(id) {
  return load().open[id] || null;
}

export function claimPaperFees(id) {
  const d = load();
  const pos = d.open[id];
  if (!pos) return { success: false, error: "Paper position not found" };
  const sol = pos.fees_sol - pos.claimed_sol;
  pos.claimed_sol = pos.fees_sol;
  pos.extra_network_sol = (pos.extra_network_sol || 0) + NETWORK_FEE_SOL / 3; // one claim tx
  save(d);
  return { success: true, paper: true, position: id, claimed_sol: Math.round(sol * 1e6) / 1e6, txs: [] };
}

async function jupiterQuote(base_mint, tokens, decimals) {
  const raw = BigInt(Math.floor(tokens * Math.pow(10, decimals)));
  if (raw <= 0n) return null;
  const key = config.jupiter?.apiKey || process.env.JUPITER_API_KEY || DEFAULT_JUP_KEY;
  const url = `${JUP_QUOTE}?inputMint=${base_mint}&outputMint=${SOL_MINT}&amount=${raw}&slippageBps=${Number(config.paper?.slippageBps ?? 300)}`;
  const res = await fetch(url, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Jupiter quote ${res.status}`);
  const q = await res.json();
  if (!q.outAmount) throw new Error(q.error || "no route");
  return { out_sol: Number(q.outAmount) / 1e9, price_impact_pct: Number(q.priceImpactPct) * 100, route: (q.routePlan || []).map((r) => r.swapInfo?.label).filter(Boolean).join(" > ") };
}

/** Close a paper position: value at market, token leg through a real Jupiter quote. */
export async function closePaperPosition(id, reason) {
  const d = load();
  const pos = d.open[id];
  if (!pos) return { success: false, error: "Paper position not found or already closed" };
  let snap;
  try {
    snap = await getPoolSnapshot(pos.pool, { force: true });
  } catch (e) {
    return { success: false, error: `Paper close failed: no market data (${e.message}). Try again next cycle.` };
  }
  // final fee accrual up to now
  const row = await mark(pos).catch(() => null);
  const v = valueAt(pos, snap.price_sol);
  const midSol = v.tokens * snap.price_sol;
  let swapSol = midSol;
  let quote = null;
  let quoteFailed = false;
  if (v.tokens > 0) {
    try {
      quote = await jupiterQuote(pos.base_mint, v.tokens, pos.base_decimals);
      if (quote) swapSol = quote.out_sol;
    } catch (e) {
      quoteFailed = true;
      log("paper_warn", `Jupiter quote failed for ${pos.pool_name}: ${e.message} — using mid price, record flagged suspect`);
    }
  }
  const slippageSol = Math.max(0, midSol - swapSol);
  const finalSol = v.sol + swapSol + pos.fees_sol - NETWORK_FEE_SOL - (pos.extra_network_sol || 0);
  const finalUsd = finalSol * snap.sol_usd;
  const pnlUsd = finalUsd - pos.initial_value_usd;
  const pnlPct = (pnlUsd / pos.initial_value_usd) * 100;
  const pnlSolPct = ((finalSol - pos.amount_sol) / pos.amount_sol) * 100;
  const minutesHeld = Math.floor((Date.now() - new Date(pos.opened_at).getTime()) / 60_000);
  const closed = {
    ...pos,
    closed_at: new Date().toISOString(),
    close_reason: reason || "agent decision",
    exit_price_sol: snap.price_sol,
    exit_sol_usd: snap.sol_usd,
    exit_sol_leg: v.sol,
    exit_tokens: v.tokens,
    exit_token_mid_sol: midSol,
    exit_token_quote_sol: swapSol,
    slippage_sol: slippageSol,
    slippage_pct_of_token_leg: midSol > 0 ? (slippageSol / midSol) * 100 : 0,
    price_impact_pct: quote?.price_impact_pct ?? null,
    route: quote?.route ?? null,
    quote_failed: quoteFailed,
    network_fee_sol: NETWORK_FEE_SOL,
    final_sol: finalSol,
    pnl_usd: pnlUsd,
    pnl_pct: pnlPct,
    pnl_sol_pct: pnlSolPct,
    minutes_held: minutesHeld,
    last_row: row,
  };
  delete d.open[id];
  d.closed.push(closed);
  save(d);
  log(
    "paper",
    `CLOSE ${pos.pool_name}: ${pnlPct.toFixed(2)}% USD / ${pnlSolPct.toFixed(2)}% SOL | fees ${pos.fees_sol.toFixed(5)} SOL | slippage ${slippageSol.toFixed(5)} SOL (${closed.slippage_pct_of_token_leg.toFixed(2)}% of token leg) | ${reason}`,
  );
  return {
    success: true,
    paper: true,
    position: id,
    pool: pos.pool,
    pool_name: `${pos.pool_name} (paper)`,
    pnl_usd: Math.round(pnlUsd * 100) / 100,
    pnl_pct: Math.round(pnlPct * 100) / 100,
    pnl_sol_pct: Math.round(pnlSolPct * 100) / 100,
    fees_sol: Math.round(pos.fees_sol * 1e6) / 1e6,
    slippage_sol: Math.round(slippageSol * 1e6) / 1e6,
    price_impact_pct: quote?.price_impact_pct != null ? Math.round(quote.price_impact_pct * 100) / 100 : null,
    final_value_usd: finalUsd,
    fees_earned_usd: pos.fees_sol * snap.sol_usd,
    minutes_held: minutesHeld,
    quote_failed: quoteFailed,
    base_mint: null, // nothing to auto-swap: the swap was simulated above
    txs: [],
    message: "PAPER close — no transaction sent",
  };
}

export function getPaperSummary() {
  const d = load();
  const c = d.closed;
  const wins = c.filter((x) => x.pnl_pct > 0).length;
  const sum = (f) => c.reduce((a, x) => a + (Number(f(x)) || 0), 0);
  return {
    open: Object.keys(d.open).length,
    closed: c.length,
    win_rate_pct: c.length ? Math.round((wins / c.length) * 1000) / 10 : null,
    total_pnl_sol: Math.round(sum((x) => x.final_sol - x.amount_sol) * 1e5) / 1e5,
    avg_pnl_pct: c.length ? Math.round((sum((x) => x.pnl_pct) / c.length) * 100) / 100 : null,
    total_fees_sol: Math.round(sum((x) => x.fees_sol) * 1e5) / 1e5,
    total_slippage_sol: Math.round(sum((x) => x.slippage_sol) * 1e5) / 1e5,
    last: c.slice(-5).map((x) => ({ pool: x.pool_name, pnl_pct: Math.round(x.pnl_pct * 100) / 100, held_min: x.minutes_held, reason: x.close_reason })),
  };
}
