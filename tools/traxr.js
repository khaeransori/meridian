/**
 * Traxr pool safety scores — LOG-ONLY (ported from nightly-2026-04).
 *
 * Public API (no key): https://solana.traxr.pro/api/traxr/pools/<poolAddress>
 * Returns a 0-100 safety score plus node metrics (stability, depth) and an impact label.
 *
 * In this build Traxr NEVER filters or reorders candidates and is NOT shown to the LLM.
 * Scores are attached to candidates as traxr_* fields (for logs/decision log) and appended
 * to traxr-log.jsonl so they can later be compared with real outcomes before anyone decides
 * to use them as a gate.
 *
 * Config: user-config "traxrMode": "log" (default) | "off".
 */
import fs from "fs";
import { config } from "../config.js";
import { log } from "../logger.js";
import { repoPath } from "../repo-root.js";

const TRAXR_BASE = "https://solana.traxr.pro/api/traxr";
const TIMEOUT_MS = 8_000;
const LOG_PATH = repoPath("traxr-log.jsonl");
// Circuit breaker: after a fully failed round, skip Traxr for a while so an outage
// doesn't add TIMEOUT_MS to every screening cycle.
const BREAKER_MS = 30 * 60_000;
let _skipUntil = 0;

export function isTraxrLogEnabled() {
  return String(config.traxr?.mode || "log").toLowerCase() === "log";
}

export async function getTraxrPool(poolAddress) {
  if (!poolAddress) return { error: "poolAddress required" };
  try {
    const res = await fetch(`${TRAXR_BASE}/pools/${encodeURIComponent(poolAddress)}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return await res.json();
  } catch (e) {
    return { error: e.message || "fetch failed" };
  }
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Annotate candidates in place with traxr_score / traxr_stability / traxr_depth / traxr_impact.
 * Never throws, never removes candidates.
 */
export async function annotateTraxr(candidates, { source = "meteora" } = {}) {
  if (!isTraxrLogEnabled() || !Array.isArray(candidates) || candidates.length === 0) return;
  if (Date.now() < _skipUntil) return;
  const results = await Promise.allSettled(candidates.map((c) => getTraxrPool(c.pool)));
  const lines = [];
  const at = new Date().toISOString();
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const r = results[i];
    const v = r.status === "fulfilled" ? r.value : { error: String(r.reason?.message || r.reason) };
    if (!v || v.error) {
      log("traxr", `${c.name || c.pool?.slice(0, 8)}: no data (${v?.error || "empty"})`);
      continue;
    }
    c.traxr_score = num(v.score);
    c.traxr_stability = num(v.nodes?.stability);
    c.traxr_depth = num(v.nodes?.depth);
    c.traxr_impact = typeof v.impact === "string" ? v.impact : null;
    log("traxr", `${c.name}: score=${c.traxr_score ?? "?"} stability=${c.traxr_stability ?? "?"} depth=${c.traxr_depth ?? "?"} impact=${c.traxr_impact ?? "?"} (log-only)`);
    lines.push(JSON.stringify({
      at,
      source,
      pool: c.pool,
      name: c.name,
      base_mint: c.base?.mint ?? null,
      score: c.traxr_score,
      stability: c.traxr_stability,
      depth: c.traxr_depth,
      impact: c.traxr_impact,
    }));
  }
  if (lines.length === 0) {
    _skipUntil = Date.now() + BREAKER_MS;
    log("traxr", `No Traxr data for any candidate — pausing Traxr lookups for ${BREAKER_MS / 60_000}m`);
  }
  if (lines.length) {
    try {
      fs.appendFileSync(LOG_PATH, lines.join("\n") + "\n");
    } catch (e) {
      log("traxr", `Could not write traxr-log.jsonl: ${e.message}`);
    }
  }
}
