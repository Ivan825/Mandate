import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

// One driver everywhere: local Postgres in development and tests, Neon (or
// any Postgres) in production. DATABASE_URL is the only setting.

const url = process.env.DATABASE_URL ?? "postgres://mandate:mandate@localhost:5432/mandate";

export function configProblems(): string[] {
  if (!process.env.VERCEL) return [];
  const out: string[] = [];
  if (!process.env.DATABASE_URL) out.push("DATABASE_URL is not set.");
  if (!process.env.BETTER_AUTH_SECRET) out.push("BETTER_AUTH_SECRET is not set; sessions cannot be signed.");
  if (!process.env.NEXT_PUBLIC_BASE_URL) out.push("NEXT_PUBLIC_BASE_URL is not set; sign-in links and MCP discovery need the public URL.");
  return out;
}

const globalForDb = globalThis as unknown as { __mandatePool?: Pool; __mandateDb?: ReturnType<typeof drizzle<typeof schema>> };

export const pool = globalForDb.__mandatePool ?? new Pool({ connectionString: url, max: 10, ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false } });
export const db = globalForDb.__mandateDb ?? drizzle(pool, { schema });

if (process.env.NODE_ENV !== "production") { globalForDb.__mandatePool = pool; globalForDb.__mandateDb = db; }

export type DB = typeof db;
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
export type Conn = DB | Tx;

export { schema };
