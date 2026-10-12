# Hardened build (kiko/hardened)

Built on `nightly` (main + GMGN). Each change is one commit, so it can be reviewed or reverted on its own.

| # | Change | Default now | How to loosen later |
|---|--------|-------------|---------------------|
| 1 | Jupiter referral fee | 0 bps, no referral wallet | env `JUPITER_REFERRAL_ACCOUNT` + `JUPITER_REFERRAL_FEE_BPS` |
| 2 | `self_update` (git pull + restart) | removed | update manually: `git pull`, review, restart |
| 3 | HiveMind telemetry + shared lessons | off, pull mode `manual` | `"hiveMindEnabled": true` in user-config.json |
| 4 | Opportunity poller (45s) | off | `"opportunityPollEnabled": true` |
| 5 | Risk | `maxPositions` 1, `maxDeployAmount` 0.5 SOL, `stopLossPct` -15 | user-config.json or Telegram `/setcfg` |
| 6 | LLM models | no default stealth model, no free fallback; cycle fails if unset | set `LLM_MODEL` or per-role models |
| 7 | Dry run | on unless `DRY_RUN=false` | `DRY_RUN=false` in .env |
| 8 | LPAgent relay | off; not settable via LLM/Telegram/user-config | env `LPAGENT_RELAY_ENABLED=true` |

Not a code change: keep the private key in a **separate burner wallet** with only what you can afford to lose.
`.env` / `user-config.json` store the key in plain text; `envcrypt` is XOR obfuscation, not encryption.

Note: chart indicators (used by GMGN Stage 4 and indicator confirmations) still come from api.agentmeridian.xyz.
If that server is down, GMGN screening yields zero candidates (fail-closed by design).

Suggested rollout:
1. 1-2 weeks DRY_RUN with `screeningSource: "gmgn"`; review the decision log.
2. Live with 2-3 SOL burner, 0.5 SOL x 1 position for 2-4 weeks.
3. Loosen step by step: positions 1 -> 2 -> 3, size 0.5 -> 1 SOL, poller on, stop loss if it cuts too many winners.

Tests (offline, mocked network): `npm run test:hardening && npm run test:gmgn`

## Ported from nightly-2026-04

| Feature | Default | Setting |
|---|---|---|
| Stale-position exit: close if older than N min and PnL below X% | 1440 min, 2% | `maxPositionAgeMinutes`, `maxPositionAgePnlPct` (null = off) |
| OOR-frequency exit: close after N separate out-of-range events | 4 | `oorFrequencyLimit` (null = off) |
| Volatility-spike exit: close when pool volatility > N× deploy volatility | 3× | `volatilitySpikeRatio` (null = off) |
| Suspect PnL guard: cache-fallback close PnL is flagged and excluded from lessons, threshold evolution and signal weights | on | — |
| Stale-lock watchdog: a management/screening/chat busy flag stuck longer than N min is force-cleared (+ Telegram alert) so the bot keeps working | 15 min | `STALE_LOCK_MINUTES` in `.env` (min 5) |
| Telegram: offset persisted across restarts (no replayed commands); in groups only answers when @mentioned or replied to | always on | — |
| Traxr pool safety score — **log only**, never filters; 30-min circuit breaker if the API is down | on | `traxrMode`: `log` / `off`; log in `traxr-log.jsonl` |
| `claude-local` LLM provider (Claude CLI via your subscription) | off | see below |

### claude-local

```json
{
  "llmProvider": "claude-local",
  "claudeLocal": {
    "models": { "default": "claude-sonnet-5-5" },
    "effort": { "default": null, "screening": "high" },
    "timeoutMs": 240000
  }
}
```

- `llmProvider` can also be per role: `{ "default": "openai", "screening": "claude-local" }`.
- Models/effort tunable live via Telegram/`update_config`: `claudeLocalModel`, `claudeLocalScreeningModel`, `claudeLocalManagementModel`, `claudeLocalGeneralModel`, `claudeLocalEffort`, `claudeLocalScreeningEffort`, `claudeLocalManagementEffort`.
- Needs `claude` installed and `claude login` done on the bot machine.
- Isolation: no built-in Claude Code tools (no shell/file/web), `--strict-mcp-config`, `--setting-sources ""`, temp cwd, wallet/API secrets stripped from the CLI env. Meridian tools are served on 127.0.0.1 (random port) with a per-cycle token and the role's tool allowlist; deploy/swap/close are once-per-cycle like the OpenAI path.
- Test: `npm run test:claude-local` (live, uses your subscription).

Offline tests: `npm run test:offline` (27 checks).

## Paper trading (DRY_RUN)

In `DRY_RUN` a deploy opens a **simulated** position (`paper_…` id, stored in `paper-positions.json`). Nothing is signed or sent.

- Marked to market from the Meteora pool API (price, TVL, 1h fees) every poll.
- Single-sided SOL bins fill into token as price falls (spot / curve / bid_ask weights).
- Fees accrue only while in range: `pool fees/min × (position value / pool TVL) × paperFeeShare` (default 0.7, set `paperFeeShare`).
- All exit rules (stop loss, trailing TP, OOR, low yield, age/OOR-count/vol-spike) run on paper positions exactly like live ones.
- On close the token leg is priced with a **real Jupiter quote** → slippage and price impact are counted; network fees are estimated (~0.00075 SOL per close).
- Paper closes are recorded in lessons and the decision log (flagged `paper: true`) but **never** feed threshold evolution or signal weights.
- Telegram `/paper` shows open/closed count, win rate, total PnL in SOL, fees and slippage.

Limits: fee income is an estimate (real share depends on which bins are active), the price feed is ~1 min fresh, MEV/failed-tx costs aren't modeled. Treat paper PnL as an honest upper-ish bound, not a promise.
