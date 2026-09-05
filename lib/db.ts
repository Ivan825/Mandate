import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import * as schema from "./schema";

const url = process.env.DATABASE_URL ?? "file:./data/mandate.db";
const authToken = process.env.DATABASE_AUTH_TOKEN;

// Misconfiguration is reported at request time (see configProblems), not
// at import time: `next build` also runs with NODE_ENV=production.
export function configProblems(): string[] {
  if (!process.env.VERCEL) return []; // only meaningful on Vercel; local `next start` may use a file DB
  const out: string[] = [];
  if (url.startsWith("file:")) out.push("DATABASE_URL must point at a hosted libSQL/Turso database in production; a file: path is not writable on Vercel.");
  if (!process.env.ADMIN_PASSWORD) out.push("ADMIN_PASSWORD is not set; the dashboard refuses to serve without it.");
  return out;
}

const globalForDb = globalThis as unknown as { __mandateDb?: ReturnType<typeof drizzle<typeof schema>> };

export const db =
  globalForDb.__mandateDb ??
  drizzle(createClient({ url, authToken }), { schema });

if (process.env.NODE_ENV !== "production") globalForDb.__mandateDb = db;

export type DB = typeof db;
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
export type Conn = DB | Tx;

export { schema };
