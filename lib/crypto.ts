import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { isProduction } from "./env";

// Provider API keys are stored encrypted with AES-256-GCM under a key that
// lives outside the database. In production set MANDATE_ENCRYPTION_KEY to
// 32 random bytes, base64-encoded (openssl rand -base64 32). In development
// it is derived from BETTER_AUTH_SECRET so nothing extra is needed.

function key(): Buffer {
  const raw = process.env.MANDATE_ENCRYPTION_KEY;
  if (raw) {
    const b = Buffer.from(raw, "base64");
    if (b.length === 32) return b;
    throw new Error("MANDATE_ENCRYPTION_KEY must be 32 bytes, base64-encoded.");
  }
  if (isProduction()) throw new Error("MANDATE_ENCRYPTION_KEY is required in production.");
  return createHash("sha256").update("mandate-enc:" + (process.env.BETTER_AUTH_SECRET ?? "dev")).digest();
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(".");
}

export function decrypt(blob: string): string {
  const [v, ivB, tagB, ctB] = blob.split(".");
  if (v !== "v1") throw new Error("Unknown ciphertext version.");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB, "base64"));
  d.setAuthTag(Buffer.from(tagB, "base64"));
  return Buffer.concat([d.update(Buffer.from(ctB, "base64")), d.final()]).toString("utf8");
}
