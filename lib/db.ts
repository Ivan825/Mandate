import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

// One driver everywhere: local Postgres in development and tests, Neon (or
// any Postgres) in production. DATABASE_URL is the only setting.

const url = process.env.DATABASE_URL ?? "postgres://mandate:mandate@localhost:5432/mandate";

export { configProblems } from "./env";

// TLS: a remote database is verified against the system CA bundle (Neon,
// Supabase, RDS and friends all present valid certificates). A self-signed
// server can opt out with DATABASE_SSL=no-verify; DATABASE_SSL=off disables
// TLS for a private network.
function ssl(): false | undefined | { rejectUnauthorized: boolean } {
  const mode = (process.env.DATABASE_SSL ?? "").toLowerCase();
  if (mode === "off") return false;
  if (mode === "no-verify") return { rejectUnauthorized: false };
  if (/localhost|127\.0\.0\.1|@db[:\/]/.test(url)) return undefined;
  return { rejectUnauthorized: true };
}

const globalForDb = globalThis as unknown as { __mandatePool?: Pool; __mandateDb?: ReturnType<typeof drizzle<typeof schema>> };

export const pool = globalForDb.__mandatePool ?? new Pool({ connectionString: url, max: 10, ssl: ssl() });
export const db = globalForDb.__mandateDb ?? drizzle(pool, { schema });

if (process.env.NODE_ENV !== "production") { globalForDb.__mandatePool = pool; globalForDb.__mandateDb = db; }

export type DB = typeof db;
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
export type Conn = DB | Tx;

export { schema };
