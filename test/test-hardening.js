// Offline checks for the hardened defaults. No network, no wallet.
// Run: node test/test-hardening.js
import assert from "assert";
import fs from "fs";
import { repoPath } from "../repo-root.js";

delete process.env.DRY_RUN;
delete process.env.JUPITER_REFERRAL_FEE_BPS;
delete process.env.JUPITER_REFERRAL_ACCOUNT;
delete process.env.LPAGENT_RELAY_ENABLED;
delete process.env.LLM_MODEL;
global.fetch = async () => { throw new Error("network disabled in test"); };

const userCfg = repoPath("user-config.json");
const backup = fs.existsSync(userCfg) ? fs.readFileSync(userCfg, "utf8") : null;
if (backup != null) fs.renameSync(userCfg, userCfg + ".bak-test");

let failures = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}: ${e.message}`); }
};

try {
  const { config } = await import("../config.js");
  const { tools } = await import("../tools/definitions.js");
  const { executeTool } = await import("../tools/executor.js");
  const hive = await import("../hivemind.js");
  const src = (f) => fs.readFileSync(repoPath(f), "utf8");

  await t("1 referral fee off by default", () => {
    assert.equal(config.jupiter.referralFeeBps, 0);
    assert.equal(config.jupiter.referralAccount, "");
    assert.ok(!src("config.js").includes("9MzhDUnq3KxecyPzvhguQMMPbooXQ3VAoCMPDnoijwey"));
  });
  await t("2 self_update removed", async () => {
    assert.ok(!tools.some((x) => x.function?.name === "self_update"), "still in tool definitions");
    const r = await executeTool("self_update", {});
    assert.ok(r?.error || r?.blocked || r?.success === false, "self_update should not execute");
    assert.ok(!/execSync|spawn\(/.test(src("tools/executor.js")), "child_process still used in executor");
  });
  await t("3 HiveMind off + manual pull + no shared lessons in prompt", () => {
    assert.equal(config.hiveMind.enabled, false);
    assert.equal(hive.isHiveMindEnabled(), false);
    assert.equal(hive.getHiveMindPullMode(), "manual");
    assert.equal(hive.getSharedLessonsForPrompt({ agentType: "SCREENER" }), null);
  });
  await t("4 opportunity poller off", () => assert.equal(config.opportunity.enabled, false));
  await t("5 risk: 1 position, 0.5 SOL cap, SL -15", () => {
    assert.equal(config.risk.maxPositions, 1);
    assert.equal(config.risk.maxDeployAmount, 0.5);
    assert.equal(config.management.stopLossPct, -15);
  });
  await t("6 no stealth/free default model, no fallback", () => {
    assert.equal(config.llm.screeningModel, null);
    assert.ok(!/stepfun|healer-alpha|hunter-alpha/.test(src("agent.js") + src("config.js")));
  });
  await t("7 DRY_RUN defaults to true", () => assert.equal(process.env.DRY_RUN, "true"));
  await t("8 relay locked: off, not settable via update_config", async () => {
    assert.equal(config.api.lpAgentRelayEnabled, false);
    const r = await executeTool("update_config", { changes: { lpAgentRelayEnabled: true }, reason: "test" });
    assert.equal(config.api.lpAgentRelayEnabled, false, "relay got enabled via update_config");
    assert.ok(r?.success !== true || (r?.unknown || []).includes("lpAgentRelayEnabled"), JSON.stringify(r));
  });
} finally {
  if (fs.existsSync(userCfg)) fs.unlinkSync(userCfg);
  if (backup != null) fs.renameSync(userCfg + ".bak-test", userCfg);
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
