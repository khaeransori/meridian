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
