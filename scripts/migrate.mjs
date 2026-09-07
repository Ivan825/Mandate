// Applies committed SQL migrations in ./drizzle to DATABASE_URL.
// Used locally (npm run db:migrate) and in CI/production deploys.
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const url = process.env.DATABASE_URL ?? "postgres://mandate:mandate@localhost:5432/mandate";
// Same TLS policy as lib/db.ts: verify remote servers; DATABASE_SSL=no-verify / off to relax.
const mode = (process.env.DATABASE_SSL ?? "").toLowerCase();
const ssl = mode === "off" ? false : mode === "no-verify" ? { rejectUnauthorized: false } : /localhost|127\.0\.0\.1|@db[:\/]/.test(url) ? undefined : { rejectUnauthorized: true };
const pool = new Pool({ connectionString: url, ssl });
await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
await pool.end();
console.log("migrations applied");
