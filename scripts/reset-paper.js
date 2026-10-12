#!/usr/bin/env node
/**
 * Remove DRY_RUN (paper) results before going live, so the live bot starts clean.
 *
 *   node scripts/reset-paper.js          # preview only
 *   node scripts/reset-paper.js --apply  # back up, then remove
 *
 * Stop the bot first (systemctl --user stop meridian-bot): it writes these files.
 *
 * Removes: paper lessons + performance records (lessons.json), paper deploys and
 * the cooldowns they caused (pool-memory.json), paper_* tracked positions
 * (state.json). paper-positions.json is archived, not deleted. The decision log
 * is kept (history; paper entries carry metrics.paper = true).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apply = process.argv.includes("--apply");
const f = (n) => path.join(ROOT, n);
const read = (n) => (fs.existsSync(f(n)) ? JSON.parse(fs.readFileSync(f(n), "utf8")) : null);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = f(`backups/pre-live-${stamp}`);

const isPaperLesson = (l) => l?.paper === true || /\(paper\)/.test(String(l?.rule || l?.context || ""));
const isPaperPerf = (p) => p?.paper === true || /\(paper\)/.test(String(p?.pool_name || "")) || String(p?.position || "").startsWith("paper_");

const out = {};
const report = [];

// lessons.json
const lessons = read("lessons.json");
if (lessons) {
  const L0 = lessons.lessons?.length || 0, P0 = lessons.performance?.length || 0;
  lessons.lessons = (lessons.lessons || []).filter((l) => !isPaperLesson(l));
  lessons.performance = (lessons.performance || []).filter((p) => !isPaperPerf(p));
  report.push(`lessons.json: -${L0 - lessons.lessons.length} lessons, -${P0 - lessons.performance.length} performance records`);
  out["lessons.json"] = lessons;
}

// pool-memory.json
const mem = read("pool-memory.json");
const paperCloseTimes = new Set(
  (read("lessons.json")?.performance || []).filter(isPaperPerf).map((p) => p.recorded_at).filter(Boolean),
);
if (mem) {
  let dDeploys = 0, dPools = 0;
  for (const [addr, e] of Object.entries(mem)) {
    if (!Array.isArray(e?.deploys)) continue;
    const before = e.deploys.length;
    e.deploys = e.deploys.filter((d) => !(d.paper === true || paperCloseTimes.has(d.closed_at)));
    const removed = before - e.deploys.length;
    if (!removed) continue;
    dDeploys += removed;
    if (e.deploys.length === 0 && !(e.notes?.length) && !(e.snapshots?.length)) {
      delete mem[addr];
      dPools++;
      continue;
    }
    // recompute aggregates and drop cooldowns (they may have come from paper closes)
    const withPnl = e.deploys.filter((d) => d.pnl_pct != null);
    e.total_deploys = e.deploys.length;
    e.avg_pnl_pct = withPnl.length ? Math.round((withPnl.reduce((s, d) => s + d.pnl_pct, 0) / withPnl.length) * 100) / 100 : 0;
    e.win_rate = withPnl.length ? Math.round((withPnl.filter((d) => d.pnl_pct >= 0).length / withPnl.length) * 100) / 100 : 0;
    e.last_deployed_at = e.deploys.at(-1)?.closed_at || null;
    e.last_outcome = e.deploys.length ? ((e.deploys.at(-1).pnl_pct ?? 0) >= 0 ? "profit" : "loss") : null;
    delete e.cooldown_until; delete e.cooldown_reason;
    delete e.base_mint_cooldown_until; delete e.base_mint_cooldown_reason;
  }
  report.push(`pool-memory.json: -${dDeploys} paper deploys, -${dPools} pools that only had paper deploys`);
  out["pool-memory.json"] = mem;
}

// state.json
const state = read("state.json");
if (state?.positions) {
  const ids = Object.keys(state.positions).filter((k) => k.startsWith("paper_"));
  for (const k of ids) delete state.positions[k];
  report.push(`state.json: -${ids.length} paper positions`);
  out["state.json"] = state;
}

const paperBook = read("paper-positions.json");
report.push(`paper-positions.json: ${paperBook ? `${Object.keys(paperBook.open || {}).length} open / ${(paperBook.closed || []).length} closed → archived to backup` : "none"}`);

console.log(report.join("\n"));
if (!apply) {
  console.log("\nPreview only. Run with --apply to back up and remove.");
  process.exit(0);
}

fs.mkdirSync(backupDir, { recursive: true });
for (const n of ["lessons.json", "pool-memory.json", "state.json", "paper-positions.json"]) {
  if (fs.existsSync(f(n))) fs.copyFileSync(f(n), path.join(backupDir, n));
}
for (const [n, data] of Object.entries(out)) fs.writeFileSync(f(n), JSON.stringify(data, null, 2));
if (paperBook) fs.unlinkSync(f("paper-positions.json"));
console.log(`\nDone. Backup: ${path.relative(ROOT, backupDir)}`);
