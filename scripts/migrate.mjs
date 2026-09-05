// Applies committed SQL migrations in ./drizzle to DATABASE_URL.
// Used locally (npm run db:migrate) and in CI/production deploys.
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const url = process.env.DATABASE_URL ?? "postgres://mandate:mandate@localhost:5432/mandate";
const pool = new Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false } });
await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
await pool.end();
console.log("migrations applied");
