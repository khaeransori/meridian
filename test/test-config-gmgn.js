// Offline test: update_config validation + GMGN persistence + secret redaction.
// Run: DRY_RUN=true node test/test-config-gmgn.js   (backs up and restores config files)
import assert from "assert";
import fs from "fs";
import { repoPath } from "../repo-root.js";

process.env.DRY_RUN = "true";
const files = ["user-config.json", "gmgn-config.json"].map((f) => repoPath(f));
const backup = Object.fromEntries(files.map((f) => [f, fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null]));
global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "{}" });

let failures = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}: ${e.message}`); }
};

try {
  const { executeTool } = await import("../tools/executor.js");
  const { config, reloadScreeningThresholds } = await import("../config.js");
  const upd = (changes) => executeTool("update_config", { changes, reason: "test" });

  await t("string 'false' for boolean is coerced correctly, not truthy", async () => {
    const r = await upd({ gmgnRequireKol: "false" });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(config.gmgn.requireKol, false);
  });
  await t("garbage for boolean rejected", async () => {
    const r = await upd({ gmgnIndicatorFilter: "maybe" });
    assert.notEqual(r.success, true, "should have failed");
  });
  await t("non-numeric for number rejected", async () => {
    const r = await upd({ gmgnMinHolders: "lots" });
    assert.notEqual(r.success, true);
  });
  await t("invalid enum rejected (screeningSource)", async () => {
    const r = await upd({ screeningSource: "dexscreener" });
    assert.notEqual(r.success, true);
    assert.notEqual(config.screening.source, "dexscreener");
  });
  await t("valid GMGN changes applied + persisted to gmgn-config.json (nested rule too)", async () => {
    const r = await upd({ screeningSource: "gmgn", gmgnMinHolders: 750, gmgnMinRsi: 30, gmgnPreferredKolNames: ["alpha", "beta"] });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(config.screening.source, "gmgn");
    assert.equal(config.gmgn.indicatorRules.minRsi, 30);
    const g = JSON.parse(fs.readFileSync(repoPath("gmgn-config.json"), "utf8"));
    assert.equal(g.minHolders, 750);
    assert.equal(g.indicatorRules.minRsi, 30);
    assert.deepEqual(g.preferredKolNames, ["alpha", "beta"]);
    const u = JSON.parse(fs.readFileSync(repoPath("user-config.json"), "utf8"));
    assert.equal(u.screeningSource, "gmgn");
    assert.ok(!("gmgn:minHolders" in u) && !("minHolders" in u && u.minHolders === 750), "gmgn key leaked into user-config.json");
  });
  await t("reload picks up gmgn-config.json edits", async () => {
    const g = JSON.parse(fs.readFileSync(repoPath("gmgn-config.json"), "utf8"));
    g.minHolders = 999; g.indicatorRules.maxRsi = 70;
    fs.writeFileSync(repoPath("gmgn-config.json"), JSON.stringify(g));
    reloadScreeningThresholds();
    assert.equal(config.gmgn.minHolders, 999);
    assert.equal(config.gmgn.indicatorRules.maxRsi, 70);
    assert.equal(config.gmgn.indicatorRules.minRsi, 30, "sibling rule lost on reload");
  });
  await t("API key is redacted in update_config output", async () => {
    const r = await upd({ gmgnApiKey: "SECRET-should-not-appear" });
    assert.ok(!JSON.stringify(r).includes("SECRET-should-not-appear"), "secret leaked in result");
  });
} finally {
  for (const [f, content] of Object.entries(backup)) {
    if (content == null) { if (fs.existsSync(f)) fs.unlinkSync(f); }
    else fs.writeFileSync(f, content);
  }
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
