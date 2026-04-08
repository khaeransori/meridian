import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");
const CACHE_PATH = path.join(__dirname, "hivemind-cache.json");
const PACKAGE_JSON_PATH = path.join(__dirname, "package.json");
const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000;

let _heartbeatTimer = null;

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function sanitizeText(text, maxLen = 400) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function getVersion() {
  try {
    return JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8")).version || "1.0.0";
  } catch {
    return "1.0.0";
  }
}

const AGENT_VERSION = getVersion();

function readUserConfig() {
  return readJson(USER_CONFIG_PATH, {});
}

function writeUserConfig(nextConfig) {
  writeJson(USER_CONFIG_PATH, nextConfig);
}

function readCache() {
  return readJson(CACHE_PATH, {
    sharedLessons: [],
    presets: [],
    pulledAt: null,
  });
}

function writeCache(nextCache) {
  writeJson(CACHE_PATH, nextCache);
}

function getBaseUrl() {
  return sanitizeText(config.hiveMind?.url || "", 500) || "";
}

function getApiKey() {
  return sanitizeText(config.hiveMind?.apiKey || "", 300) || "";
}

function getPullMode() {
  const mode = sanitizeText(config.hiveMind?.pullMode || "auto", 20) || "auto";
  return mode === "manual" ? "manual" : "auto";
}

export function getHiveMindPullMode() {
  return getPullMode();
}

export function isHiveMindEnabled() {
  return !!(getBaseUrl() && getApiKey());
}

export function ensureAgentId() {
  const userConfig = readUserConfig();
  if (userConfig.agentId) {
    config.hiveMind.agentId = userConfig.agentId;
    return userConfig.agentId;
  }

  const agentId = `agt_${crypto.randomBytes(12).toString("hex")}`;
  userConfig.agentId = agentId;
  writeUserConfig(userConfig);
  config.hiveMind.agentId = agentId;
  log("hivemind", `Generated agentId ${agentId}`);
  return agentId;
}

function getAgentId() {
  return config.hiveMind?.agentId || ensureAgentId();
}

function buildUrl(pathname, query = {}) {
  const url = new URL(pathname, getBaseUrl());
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function requestJson(pathname, { method = "GET", body = null, query = {} } = {}) {
  if (!isHiveMindEnabled()) return null;
  const response = await fetch(buildUrl(pathname, query), {
    method,
    headers: {
      accept: "application/json",
      "x-api-key": getApiKey(),
      ...(body != null ? { "content-type": "application/json" } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `HiveMind ${response.status}`);
  }
  return payload;
}

function normalizeSharedLesson(lesson) {
  const rule = sanitizeText(lesson?.rule, 400);
  if (!rule) return null;
  return {
    id: lesson.id || lesson.lessonId || `shared_${Date.now()}`,
    rule,
    tags: Array.isArray(lesson.tags) ? lesson.tags.map((tag) => sanitizeText(tag, 48)).filter(Boolean) : [],
    role: sanitizeText(lesson.role || "", 20) || null,
    outcome: sanitizeText(lesson.outcome || "shared", 20) || "shared",
    sourceType: sanitizeText(lesson.sourceType || lesson.source || "shared", 24) || "shared",
    score: Number.isFinite(Number(lesson.score)) ? Number(lesson.score) : null,
    created_at: lesson.created_at || lesson.createdAt || new Date().toISOString(),
  };
}

export function getSharedLessonsForPrompt({ agentType = "GENERAL", maxLessons = 6 } = {}) {
  const role = String(agentType || "GENERAL").toUpperCase();
  const shared = (readCache().sharedLessons || [])
    .map(normalizeSharedLesson)
    .filter(Boolean)
    .filter((lesson) => !lesson.role || lesson.role === role || role === "GENERAL")
    .sort((left, right) => (Number(right.score) || 0) - (Number(left.score) || 0))
    .slice(0, maxLessons);

  if (!shared.length) return null;
  return shared
    .map((lesson) => `[HIVEMIND${lesson.score != null ? ` score=${lesson.score}` : ""}] ${lesson.rule}`)
    .join("\n");
}

export async function registerHiveMindAgent({ reason = "heartbeat" } = {}) {
  if (!isHiveMindEnabled()) return null;
  try {
    return await requestJson("/api/hivemind/agents/register", {
      method: "POST",
      body: {
        agentId: getAgentId(),
        version: AGENT_VERSION,
        timestamp: new Date().toISOString(),
        reason,
        capabilities: {
          telegram: !!process.env.TELEGRAM_BOT_TOKEN,
          lpagent: !!process.env.LPAGENT_API_KEY,
          dryRun: process.env.DRY_RUN === "true",
        },
      },
    });
  } catch (error) {
    log("hivemind_warn", `Agent register failed: ${error.message}`);
    return null;
  }
}

export async function pullHiveMindLessons(limit = 12) {
  if (!isHiveMindEnabled()) return null;
  try {
    const payload = await requestJson("/api/hivemind/lessons/pull", {
      query: { agentId: getAgentId(), limit },
    });
    const cache = readCache();
    cache.sharedLessons = Array.isArray(payload?.lessons)
      ? payload.lessons.map(normalizeSharedLesson).filter(Boolean)
      : [];
    cache.pulledAt = new Date().toISOString();
    writeCache(cache);
    return cache.sharedLessons;
  } catch (error) {
    log("hivemind_warn", `Lesson pull failed: ${error.message}`);
    return null;
  }
}

export async function pullHiveMindPresets() {
  if (!isHiveMindEnabled()) return null;
  try {
    const payload = await requestJson("/api/hivemind/presets/pull", {
      query: { agentId: getAgentId() },
    });
    const cache = readCache();
    cache.presets = Array.isArray(payload?.presets) ? payload.presets : [];
    cache.pulledAt = new Date().toISOString();
    writeCache(cache);
    return cache.presets;
  } catch (error) {
    log("hivemind_warn", `Preset pull failed: ${error.message}`);
    return null;
  }
}

export async function bootstrapHiveMind() {
  if (!isHiveMindEnabled()) return null;
  ensureAgentId();
  const tasks = [registerHiveMindAgent({ reason: "startup" })];
  if (getPullMode() === "auto") {
    tasks.push(pullHiveMindLessons(), pullHiveMindPresets());
  }
  await Promise.allSettled(tasks);
  return { enabled: true, agentId: getAgentId(), pullMode: getPullMode() };
}

export function startHiveMindBackgroundSync() {
  if (!isHiveMindEnabled() || _heartbeatTimer) return null;
  _heartbeatTimer = setInterval(() => {
    const tasks = [registerHiveMindAgent({ reason: "heartbeat" })];
    if (getPullMode() === "auto") {
      tasks.push(pullHiveMindLessons(), pullHiveMindPresets());
    }
    Promise.allSettled(tasks).catch(() => null);
  }, HEARTBEAT_INTERVAL_MS);
  return _heartbeatTimer;
}

function buildLessonEvent(lesson) {
  const rule = sanitizeText(lesson?.rule, 400);
  if (!rule) return null;
  const sourceType = sanitizeText(lesson.sourceType || inferLessonSourceType(lesson), 24) || "manual";
  return {
    eventId: `lesson:${getAgentId()}:${lesson.id || crypto.randomUUID()}`,
    agentId: getAgentId(),
    version: AGENT_VERSION,
    timestamp: lesson.created_at || new Date().toISOString(),
    lesson: {
      id: lesson.id || null,
      rule,
      tags: Array.isArray(lesson.tags) ? lesson.tags.map((tag) => sanitizeText(tag, 48)).filter(Boolean) : [],
      role: sanitizeText(lesson.role || "", 20) || null,
      outcome: sanitizeText(lesson.outcome || "manual", 20) || "manual",
      sourceType,
      confidence: Number.isFinite(Number(lesson.confidence)) ? Number(lesson.confidence) : null,
      pool: sanitizeText(lesson.pool || "", 64) || null,
      pinned: !!lesson.pinned,
      metrics: {
        pnlPct: Number.isFinite(Number(lesson.pnl_pct)) ? Number(lesson.pnl_pct) : null,
        feesUsd: Number.isFinite(Number(lesson.fees_earned_usd)) ? Number(lesson.fees_earned_usd) : null,
        initialValueUsd: Number.isFinite(Number(lesson.initial_value_usd)) ? Number(lesson.initial_value_usd) : null,
        rangeEfficiency: Number.isFinite(Number(lesson.range_efficiency)) ? Number(lesson.range_efficiency) : null,
        closeReason: sanitizeText(lesson.close_reason || "", 160) || null,
      },
    },
  };
}

function inferLessonSourceType(lesson) {
  const tags = Array.isArray(lesson?.tags) ? lesson.tags.map((tag) => String(tag).toLowerCase()) : [];
  const rule = String(lesson?.rule || "").toLowerCase();
  if (tags.includes("self_tune") || tags.includes("config_change") || rule.startsWith("[self-tuned]")) {
    return "config_change";
  }
  if (lesson?.outcome === "manual") {
    return "manual";
  }
  return "performance";
}

export async function pushHiveLesson(lesson) {
  if (!isHiveMindEnabled()) return null;
  const body = buildLessonEvent(lesson);
  if (!body) return null;
  try {
    return await requestJson("/api/hivemind/lessons/push", {
      method: "POST",
      body,
    });
  } catch (error) {
    log("hivemind_warn", `Lesson push failed: ${error.message}`);
    return null;
  }
}

export function shouldCountInAdjustedWinRate(closeReason) {
  const text = String(closeReason || "").toLowerCase();
  return !(
    text.includes("out of range") ||
    text.includes("pumped far above range") ||
    text === "oor" ||
    text.includes("oor")
  );
}

export async function pushHivePerformanceEvent(perf) {
  if (!isHiveMindEnabled()) return null;
  try {
    return await requestJson("/api/hivemind/performance/push", {
      method: "POST",
      body: {
        eventId: sanitizeText(perf.eventId, 200) || `close:${getAgentId()}:${perf.position || perf.pool}:${perf.recorded_at || Date.now()}`,
        agentId: getAgentId(),
        version: AGENT_VERSION,
        timestamp: perf.recorded_at || new Date().toISOString(),
        event: {
          pool: sanitizeText(perf.pool, 64) || null,
          poolName: sanitizeText(perf.pool_name, 80) || null,
          baseMint: sanitizeText(perf.base_mint, 64) || null,
          strategy: sanitizeText(perf.strategy, 32) || null,
          closeReason: sanitizeText(perf.close_reason, 200) || "unknown",
          pnlUsd: Number(perf.pnl_usd || 0),
          pnlPct: Number(perf.pnl_pct || 0),
          feesUsd: Number(perf.fees_earned_usd || 0),
          feesSol: Number(perf.fees_earned_sol || 0),
          minutesHeld: Number(perf.minutes_held || 0),
          countInAdjustedWinRate: shouldCountInAdjustedWinRate(perf.close_reason),
        },
      },
    });
  } catch (error) {
    log("hivemind_warn", `Performance push failed: ${error.message}`);
    return null;
  }
}

// ─── Shadow-log helpers: hive summary + rule matching ──────────────────────
// Used by the screening cycle to record what pool-specific consensus rules
// would have applied to each candidate — pure logging, no deploy effect.

// The summary endpoint is a known public resource at a fixed host, unlike
// the lesson push/pull endpoints which are configurable per-agent via
// `hiveMind.url` in user-config. Hardcoding avoids misdirection when a local
// config points `hiveMindUrl` at an unrelated host (e.g. a legacy railway URL).
const SUMMARY_URL = "https://api.agentmeridian.xyz/api/hivemind/summary/public";
const SUMMARY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min — screening runs every 15m
const SUMMARY_TIMEOUT_MS = 5_000;
let _summaryCache = null;
let _summaryCacheAt = 0;

/**
 * Fetch the public hive summary. No authentication required.
 * Caches the result for 5 minutes to avoid re-fetching on back-to-back calls.
 * Returns null on failure so callers degrade gracefully.
 */
export async function fetchHiveSummary() {
  const now = Date.now();
  if (_summaryCache && (now - _summaryCacheAt) < SUMMARY_CACHE_TTL_MS) {
    return _summaryCache;
  }
  try {
    const res = await fetch(SUMMARY_URL, {
      signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      log("hivemind_warn", `Hive summary fetch failed: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    _summaryCache = data;
    _summaryCacheAt = now;
    return data;
  } catch (error) {
    log("hivemind_warn", `Hive summary fetch error: ${error.message}`);
    return null;
  }
}

/**
 * Parse a strong/emerging consensus rule string into a matchable structure.
 * Rule format: `PREFER: <poolname>-type pools (volatility=<n|null>, bin_step=<n>) with strategy="<s>" — ...`
 * Or:          `WORKED: <poolname>, strategy=<s>, bin_step=<n>, volatility=<n>, ...`
 * Returns { poolBase, binStep, volatility, strategy, action } or null if unparseable.
 */
// Normalize a pool name like "BabyTrump-SOL" or "petro" to its base token symbol
// ("babytrump", "petro") for consistent matching between parser and matcher.
function normalizePoolBase(name) {
  return String(name || "").trim().split("-")[0].toLowerCase();
}

export function parseConsensusRule(ruleText) {
  if (!ruleText || typeof ruleText !== "string") return null;

  // Format 1: PREFER/AVOID rules
  //   "PREFER: BabyTrump-SOL-type pools (volatility=null, bin_step=125) with strategy=\"bid_ask\" — ..."
  const preferMatch = ruleText.match(
    /^(PREFER|AVOID):\s*(.+?)-type\s+pools\s*\(volatility=([^,)]+),\s*bin_step=(\d+)\)\s*with\s+strategy="([^"]+)"/i
  );
  if (preferMatch) {
    const [, action, poolName, volRaw, binStepRaw, strategy] = preferMatch;
    return {
      action: action.toUpperCase(),
      poolBase: normalizePoolBase(poolName),
      binStep: Number(binStepRaw),
      volatility: volRaw === "null" ? null : Number(volRaw),
      strategy: strategy.toLowerCase(),
    };
  }

  // Format 2: WORKED rules
  //   "WORKED: PETRO-SOL, strategy=spot, bin_step=100, volatility=0.7, ..."
  const workedMatch = ruleText.match(
    /^WORKED:\s*([^,]+),\s*strategy=([a-z_]+),\s*bin_step=(\d+),\s*volatility=([^,]+)/i
  );
  if (workedMatch) {
    const [, poolName, strategy, binStepRaw, volRaw] = workedMatch;
    return {
      action: "PREFER",
      poolBase: normalizePoolBase(poolName),
      binStep: Number(binStepRaw),
      volatility: volRaw === "null" ? null : Number(volRaw),
      strategy: strategy.toLowerCase(),
    };
  }

  return null;
}

/**
 * Match a candidate pool against parsed consensus rules. A rule matches when:
 * - The pool's base symbol (before the dash) matches the rule's poolBase case-insensitively
 * - The bin_step matches exactly
 * - The volatility is within 1.0 of the rule's volatility (null matches null)
 *
 * Returns the first matching rule or null.
 */
export function matchCandidateToRule(candidate, rules) {
  if (!candidate || !Array.isArray(rules) || !rules.length) return null;
  const candBase = normalizePoolBase(candidate.name || candidate.pool_name || "");
  if (!candBase) return null;
  const candBinStep = Number(candidate.bin_step || candidate.binStep || 0);
  const candVol = candidate.volatility != null ? Number(candidate.volatility) : null;

  for (const rule of rules) {
    if (rule.poolBase !== candBase) continue;
    if (rule.binStep !== candBinStep) continue;
    // Volatility match: null↔null, or both defined within 1.0
    if (rule.volatility == null && candVol != null) continue;
    if (rule.volatility != null && candVol == null) continue;
    if (rule.volatility != null && candVol != null && Math.abs(rule.volatility - candVol) > 1.0) continue;
    return rule;
  }
  return null;
}

/**
 * Extract parsed strong + emerging consensus rules from a hive summary.
 * Only keeps rules that parse cleanly; malformed ones are silently dropped.
 * Returns { strong: [...], emerging: [...] } with per-rule metadata preserved.
 */
export function extractConsensusRules(summary) {
  if (!summary?.consensus) return { strong: [], emerging: [] };
  const enrich = (bucket) => bucket
    .map((item) => {
      const parsed = parseConsensusRule(item.rule);
      if (!parsed) return null;
      return {
        ...parsed,
        rule: item.rule,
        distinctAgents: item.distinctAgents || 0,
        sampleCount: item.sampleCount || 0,
        score: item.score || 0,
        confidence: item.confidence || 0,
      };
    })
    .filter(Boolean);
  return {
    strong: enrich(summary.consensus.strong || []),
    emerging: enrich(summary.consensus.emerging || []),
  };
}
