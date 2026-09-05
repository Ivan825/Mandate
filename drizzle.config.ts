import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "turso",
  schema: "./lib/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "file:./data/mandate.db",
    authToken: process.env.DATABASE_AUTH_TOKEN,
  },
});
