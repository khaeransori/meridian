// Offline test for the GMGN screening pipeline + config validation.
// Mocks global fetch; never touches a wallet or the network.
// Run: DRY_RUN=true GMGN_API_KEY=test node test/test-gmgn-mock.js
import assert from "assert";

process.env.DRY_RUN = "true";
process.env.GMGN_API_KEY = process.env.GMGN_API_KEY || "test-key";

const SOL = "So11111111111111111111111111111111111111112";
const now = Math.floor(Date.now() / 1000);
const mk = (i, extra = {}) => ({
  address: `Mint${i}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`.slice(0, 44),
  symbol: `TOK${i}`,
  holder_count: 2000,
  market_cap: 800_000,
  volume: 500_000 - i * 1000,
  open_timestamp: now - 48 * 3600,
  top_10_holder_rate: 0.15,
  bundler_rate: 0.01,
  rat_trader_amount_rate: 0.01,
  bot_degen_rate: 0.05,
  smart_degen_count: 3,
  renowned_count: 2,
  price: 0.001,
  ...extra,
});
const ranked = [mk(1), mk(2), mk(3, { holder_count: 5 }), mk(4)];
const BLACKLISTED = ranked[1].address;
const calls = [];

global.fetch = async (input, init = {}) => {
  const url = String(input);
  calls.push(url);
  const json = (body, status = 200) => ({
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  if (url.includes("openapi.gmgn.ai")) {
    assert.ok(init.headers?.["X-APIKEY"], "GMGN request must carry API key header");
    if (url.includes("/v1/market/rank")) return json({ code: 0, data: { rank: ranked } });
    if (url.includes("/v1/token/info")) {
      const addr = new URL(url).searchParams.get("address");
      const t = ranked.find((r) => r.address === addr) || ranked[0];
      return json({
        code: 0,
        data: {
          address: addr, symbol: t.symbol, price: 0.001, ath_price: 0.002, circulating_supply: 1e9,
          holder_count: t.holder_count, total_fee: 150, trade_fee: 120,
          dev: { creator_address: "Dev1111111111111111111111111111111111111111" },
          stat: { top_10_holder_rate: 0.15, dev_team_hold_rate: 0.01, fresh_wallet_rate: 0.05, bot_degen_rate: 0.05, top_bundler_trader_percentage: 0.01, top_rat_trader_percentage: 0.01 },
          wallet_tags_stat: { smart_wallets: 3, renowned_wallets: 2, sniper_wallets: 1, bundler_wallets: 0, whale_wallets: 1, fresh_wallets: 5 },
        },
      });
    }
    if (url.includes("token_top_holders") || url.includes("token_top_traders")) {
      return json({ code: 0, data: { list: [
        { address: "Kol1", tags: ["kol"], maker_token_tags: ["kol"], name: "kolA", twitter_name: "kolA", amount_percentage: 0.01, profit: 100, sell_amount_percentage: 0 },
        { address: "Smart1", tags: ["smart_degen"], maker_token_tags: ["smart_degen"], amount_percentage: 0.01, profit: 50, sell_amount_percentage: 0 },
      ] } });
    }
  }
  if (url.includes("dlmm.datapi.meteora.ag") || url.includes("dlmm-api.meteora.ag")) {
    const mint = new URL(url).searchParams.get("query");
    return json({ data: [{
      address: `Pool_${mint}`.slice(0, 44), name: "TOK-SOL",
      token_x: { address: mint, symbol: "TOK" }, token_y: { address: SOL, symbol: "SOL" },
      pool_config: { bin_step: 100, base_fee_pct: 1 }, tvl: 60_000,
    }] });
  }
  if (url.includes("pool-discovery-api.datapi.meteora.ag")) {
    return json({ data: [{ pool_address: "x", active_tvl: 50_000, tvl: 60_000, fee_active_tvl_ratio: 0.5, volatility: 3.2, volume: 400_000, fee: 2000 }] });
  }
  if (url.includes("chart-indicators")) {
    return json({ latest: { supertrend: { value: 0.0008, direction: "bullish" }, candle: { close: 0.001 }, rsi: { value: 55 }, bollinger: { upper: 0.0012, lower: 0.0008 }, states: {} } });
  }
  if (url.includes("jup.ag") || url.includes("jupiter")) return json({});
  return json({});
};

const { config } = await import("../config.js");
config.screening.source = "gmgn";
config.gmgn.requestDelayMs = 0;
config.gmgn.requireKol = false;
config.screening.avoidPvpSymbols = false;
config.indicators.enabled = false;

// Blacklist one token via the real module (isolated file, cleaned up below)
const bl = await import("../token-blacklist.js");
bl.addToBlacklist({ mint: BLACKLISTED, symbol: "TOK2", reason: "test" });

let failures = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}: ${e.message}`); }
};

try {
  const { getTopCandidates } = await import("../tools/screening.js");
  const { discoverGmgnPools } = await import("../tools/gmgn.js");

  await t("GMGN pipeline returns funnel + candidates", async () => {
    const r = await discoverGmgnPools({ limit: 10 });
    console.log("   stage_counts:", JSON.stringify(r.stage_counts), "filtered:", r.filtered_examples.map((f) => `${f.name}@S${f.stage}: ${f.reason}`).join(" | "));
    assert.ok(r.stage_counts && typeof r.stage_counts.s1 === "number");
    assert.ok(Array.isArray(r.pools));
  });

  await t("getTopCandidates(gmgn) excludes blacklisted token", async () => {
    const r = await getTopCandidates({ limit: 10 });
    console.log("   source:", r.source, "candidates:", r.candidates.map((c) => c.base?.symbol).join(","), "stage_counts:", JSON.stringify(r.stage_counts));
    assert.equal(r.source, "gmgn");
    assert.ok(!r.candidates.some((c) => c.base?.mint === BLACKLISTED), "blacklisted mint leaked through");
  });

  await t("indicator outage is fail-closed", async () => {
    const realFetch = global.fetch;
    global.fetch = async (u, i) => (String(u).includes("chart-indicators") ? { ok: false, status: 503, json: async () => ({}), text: async () => "down" } : realFetch(u, i));
    config.gmgn.indicatorFilter = true;
    const r = await discoverGmgnPools({ limit: 10 });
    global.fetch = realFetch;
    assert.equal(r.pools.length, 0, `expected 0 candidates when indicators are down, got ${r.pools.length}`);
  });

  await t("invalid screeningSource rejected", async () => {
    config.screening.source = "bogus";
    await assert.rejects(() => getTopCandidates({ limit: 5 }), /Invalid screeningSource/);
    config.screening.source = "gmgn";
  });
} finally {
  bl.removeFromBlacklist({ mint: BLACKLISTED });
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
