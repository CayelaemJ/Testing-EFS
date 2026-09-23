#!/usr/bin/env node

/**
 * Configure MySQL as the live data sync source.
 * Stores connection config in Postgres integrationConfig table.
 * Run once to set up MySQL → canonical views sync pipeline.
 */

import pg from "pg";

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("ERROR: DATABASE_URL not set");
  process.exit(1);
}

const mysqlHost = process.env.MYSQLHOST || "mysql.railway.internal";
const mysqlPort = parseInt(process.env.MYSQLPORT || "3306", 10);
const mysqlUser = process.env.MYSQLUSER || "root";
const mysqlPassword = process.env.MYSQLPASSWORD;
const mysqlDatabase = process.env.MYSQLDATABASE || "mysql";

if (!mysqlPassword) {
  console.error("ERROR: MYSQLPASSWORD not set");
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });

async function configureSync() {
  const client = await pool.connect();
  try {
    console.log("🔧 Configuring MySQL as sync source...");
    console.log(`   Host: ${mysqlHost}:${mysqlPort}`);
    console.log(`   Database: ${mysqlDatabase}`);
    console.log(`   User: ${mysqlUser}`);

    const result = await client.query(
      `
      UPDATE "IntegrationConfig"
      SET 
        "enabled" = true,
        "sourceMode" = 'SQL',
        "sqlDialect" = 'MYSQL',
        "sqlHost" = $1,
        "sqlPort" = $2,
        "sqlDatabase" = $3,
        "sqlUsername" = $4,
        "sqlPassword" = $5,
        "sqlSsl" = false,
        "scheduleHours" = 24
      WHERE id = 'default'
      RETURNING *;
      `,
      [mysqlHost, mysqlPort, mysqlDatabase, mysqlUser, mysqlPassword]
    );

    if (result.rowCount === 0) {
      console.log("❌ Failed to update integrationConfig");
      process.exit(1);
    }

    console.log("✅ MySQL sync configured!");
    console.log("   Sync is ENABLED and will run every 24 hours");
    console.log("   To trigger sync now, POST to /api/admin/integration/sync");
    process.exit(0);
  } catch (err) {
    console.error("❌ Configuration failed:", err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

configureSync();
