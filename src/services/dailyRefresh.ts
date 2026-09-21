// ════════════════════════════════════════════════════════════════════
//  DAILY REFRESH — Simple scheduled sync from MySQL to Postgres
//
//  Runs once per day. Truncates Postgres tables, reloads from source views.
//  No async jobs, no polling, no complexity.
// ════════════════════════════════════════════════════════════════════

import { PrismaClient } from "@prisma/client";
import cron from "node-cron";

const prisma = new PrismaClient();

export async function startDailyRefresh() {
  // Schedule: Run every day at 2 AM
  // Format: second minute hour day-of-month month day-of-week
  const schedule = "0 2 * * *";

  cron.schedule(schedule, async () => {
    console.log(`[${new Date().toISOString()}] Starting daily refresh...`);
    try {
      await prisma.$executeRawUnsafe("CALL refresh_all_reports()");
      console.log(`[${new Date().toISOString()}] Daily refresh completed successfully`);
    } catch (error: any) {
      console.error(`[${new Date().toISOString()}] Daily refresh failed:`, error?.message ?? error);
    }
  });

  console.log(`Daily refresh scheduled at ${schedule} (2 AM UTC)`);
}

// Manual trigger (for testing or on-demand refresh)
export async function triggerRefreshNow() {
  try {
    console.log(`[${new Date().toISOString()}] Manual refresh triggered...`);
    await prisma.$executeRawUnsafe("CALL refresh_all_reports()");
    console.log(`[${new Date().toISOString()}] Manual refresh completed`);
    return { ok: true, message: "Refresh completed" };
  } catch (error: any) {
    const message = error?.message ?? String(error);
    console.error(`Manual refresh failed:`, message);
    return { ok: false, error: message };
  }
}

