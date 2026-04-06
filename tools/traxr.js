/**
 * Traxr Security Scoring — third-party DLMM pool safety service.
 *
 * Public API at https://solana.traxr.pro/api/traxr returns 0-100 safety
 * scores for Solana DLMM pools. Used as a hard gate during screening to
 * filter out "milker" pools (high fee/tvl but designed to dump on LPs).
 *
 * No API key required. Respects `traxrEnabled` and `screening.minTraxrScore`
 * config. Falls back gracefully when the API is unreachable.
 *
 * Ported from yunus-0x/meridian (hazman-test fork). Rewritten to use native
 * fetch instead of axios to avoid a new npm dependency.
 */

import { config } from "../config.js";
import { log } from "../logger.js";

const TRAXR_BASE = "https://solana.traxr.pro/api/traxr";
const DEFAULT_TIMEOUT_MS = 10_000;

let _initialized = false;
function logInit() {
  if (_initialized) return;
  _initialized = true;
  if (config.traxrEnabled === false) {
    log("startup", "Traxr: DISABLED (traxrEnabled=false)");
  } else {
    log("startup", "Traxr: ENABLED");
  }
}

async function traxrFetch(url, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v != null && v !== ""),
  ).toString();
  const fullUrl = qs ? `${url}?${qs}` : url;
  try {
    const res = await fetch(fullUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      return { error: `HTTP ${res.status}` };
    }
    return await res.json();
  } catch (e) {
    return { error: e.message || "fetch failed" };
  }
}

/**
 * Get pool safety score by token pair (mintA, mintB).
 * Returns: { score, impact, ... } or { error } / { disabled }
 */
export async function getPoolScore(mintA, mintB, dataset = null) {
  logInit();
  if (config.traxrEnabled === false) return { disabled: true };
  if (!mintA || !mintB) return { error: "mintA and mintB required" };
  return traxrFetch(`${TRAXR_BASE}/score`, { mintA, mintB, dataset });
}

/**
 * Get pool details by pool address. Used for active position re-scans.
 */
export async function getPoolById(poolId, dataset = null) {
  logInit();
  if (config.traxrEnabled === false) return { disabled: true };
  if (!poolId) return { error: "poolId required" };
  return traxrFetch(`${TRAXR_BASE}/pools/${encodeURIComponent(poolId)}`, { dataset });
}

/**
 * Get global active alerts.
 */
export async function getAlerts() {
  logInit();
  if (config.traxrEnabled === false) return { disabled: true };
  return traxrFetch(`${TRAXR_BASE}/alerts`, {}, 8000);
}

/**
 * Get pool trend data.
 */
export async function getPoolTrend(poolId, dataset = null) {
  logInit();
  if (config.traxrEnabled === false) return { disabled: true };
  if (!poolId) return { error: "poolId required" };
  return traxrFetch(`${TRAXR_BASE}/pool-trend`, { poolId, dataset });
}
