// Recomputes every existing ScoreSnapshot row under the corrected cashflow
// formula (see snapshotBuilder.ts) and re-persists it at payloadVersion 4.
//
// Why this is needed: the "savings still achievable" denominator used to
// silently fall back to the unlocked amount itself whenever no
// AchievableTarget row existed (which was always), pinning the Cashflow
// driver — and therefore the whole Optimise Score — at 100 for every
// employer, every period. That bug is fixed, but every ScoreSnapshot row
// written before the fix still holds the old, inflated numbers. Bumping
// payloadVersion to 4 hides those stale rows from the month picker, score
// history chart, and "vs last period" delta — this script actually
// recomputes them so historical months work again instead of just going
// blank.
//
// Usage:  npx tsx scripts/rebuild-score-snapshots.ts
// (safe to re-run: snapshotEmployer() upserts on the employerId+period key)

import { prisma, snapshotEmployer } from "./snapshotBuilder.js";

async function main() {
  const rows = await prisma.scoreSnapshot.findMany({
    select: { employerId: true, period: true },
    orderBy: [{ employerId: "asc" }, { period: "asc" }],
  });

  if (!rows.length) {
    console.log("No existing score snapshots found — nothing to rebuild.");
    await prisma.$disconnect();
    return;
  }

  console.log(`Rebuilding ${rows.length} score snapshot(s) under the corrected cashflow formula...`);
  let recomputed = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const result = await snapshotEmployer(row.employerId, row.period);
      if (result.persisted) {
        recomputed++;
        console.log(`  ✓ ${row.employerId} ${row.period} — score ${result.scoreReady ? "recomputed" : "recomputed (incomplete feed data)"}`);
      } else {
        skipped++;
        console.log(`  – ${row.employerId} ${row.period} — skipped (not persisted; see snapshotEmployer)`);
      }
    } catch (e) {
      failed++;
      console.error(`  ✗ ${row.employerId} ${row.period} — FAILED: ${(e as Error).message}`);
    }
  }

  console.log(`\nDone. ${recomputed} recomputed, ${skipped} skipped, ${failed} failed.`);
  await prisma.$disconnect();
  if (failed) process.exit(1);
}

main().catch(async (e) => {
  console.error("Rebuild script crashed:", e);
  await prisma.$disconnect();
  process.exit(1);
});
