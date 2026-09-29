import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch, type Dispatcher, type Response as UResponse } from "undici";
import { isPrivateAddress, isMetadataAddress } from "./net";

// fetch() for URLs a user chose. The name is resolved by OUR lookup and the
// connection is made to the address that passed the check, so a hostname
// cannot answer "public" when we validate it and "10.0.0.5" a moment later
// (DNS rebinding), and a target cannot be re-pointed at an internal service
// after it was added. Every fetch has a deadline; callers that read a body
// read it through readCapped(), so a hostile upstream cannot fill memory.

export type SafeFetchOptions = { timeoutMs?: number; allowPrivate?: boolean; signal?: AbortSignal };

class BlockedAddress extends Error { constructor(host: string, addr: string) { super(`${host} resolves to ${addr}, which this server will not connect to.`); this.name = "BlockedAddress"; } }

type Addr = { address: string; family: number };
type LookupFn = (hostname: string, options: { family?: number; hints?: number; all?: boolean }, callback: (err: Error | null, address: string | Addr[], family?: number) => void) => void;

function guardedLookup(allowPrivate: boolean): LookupFn {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { family: options.family === 4 || options.family === 6 ? options.family : 0, hints: options.hints, all: true }, (err, addresses) => {
      if (err) return callback(err, "", 0);
      const list: Addr[] = Array.isArray(addresses) ? addresses : [addresses as unknown as Addr];
      // Every answer must pass: a mixed public/private answer is an attack, not a CDN.
      for (const a of list) {
        if (isMetadataAddress(a.address) || (!allowPrivate && isPrivateAddress(a.address))) return callback(new BlockedAddress(hostname, a.address), "", 0);
      }
      const first = list[0];
      if (!first) return callback(new Error(`${hostname} did not resolve`), "", 0);
      // net asks for every address when it auto-selects a family; otherwise one.
      if (options.all) callback(null, list);
      else callback(null, first.address, first.family);
    });
  };
}

const agents = new Map<string, Dispatcher>();
function agentFor(allowPrivate: boolean): Dispatcher {
  const key = allowPrivate ? "private" : "public";
  let a = agents.get(key);
  if (!a) { a = new Agent({ connect: { lookup: guardedLookup(allowPrivate) as never, timeout: 10_000 }, connections: 64, headersTimeout: 30_000, bodyTimeout: 60_000 }); agents.set(key, a); }
  return a;
}

export async function safeFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string | Buffer | null } = {}, opts: SafeFetchOptions = {}): Promise<UResponse> {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http(s) URLs can be fetched.");
  if (u.username || u.password) throw new Error("URLs with credentials are refused.");
  // A literal address never goes through lookup, so it is checked here.
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && (isMetadataAddress(host) || (!opts.allowPrivate && isPrivateAddress(host)))) throw new BlockedAddress(host, host);
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 30_000);
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
  return undiciFetch(u, { method: init.method ?? "GET", headers: init.headers, body: init.body ?? undefined, redirect: "manual", signal, dispatcher: agentFor(Boolean(opts.allowPrivate)) });
}

// Read a response body up to `max` bytes; beyond that the stream is cancelled
// and an error thrown, so a hostile upstream cannot exhaust memory.
export async function readCapped(res: UResponse | Response, max: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new Error(`Response too large (${declared} bytes; limit ${max}).`);
  if (!res.body) return Buffer.alloc(0);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); throw new Error(`Response too large (over ${max} bytes).`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}
