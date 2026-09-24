// mandate-agent: a spending mandate for your AI agent.
//
//   import { Mandate } from "mandate-agent";
//   const m = new Mandate("mnd_…", { baseUrl: "https://mandate-ashen.vercel.app" });
//   const a = await m.authorize({ amount: 1299, merchant: "OpenAI", purpose: "API credits", idempotencyKey: "order-1" });
//   if (a.decision === "approved") { await pay(); await m.capture(a.transactionId, { amount: 1199 }); }
//
// Amounts are integers in the mandate's minor unit (cents, paise). Uses the
// global fetch; no dependencies.

export const VERSION = "0.5.0";
export const DEFAULT_BASE_URL = "https://mandate-ashen.vercel.app";

export type Remedy = { message: string; retryAt?: string; maxAmountNow?: number; approvalRequired?: boolean; allowedMerchants?: string[] };
export type Settlement = "held" | "captured" | "voided" | "released";
export type Decision = {
  decision: "approved" | "declined" | "pending"; reason: string; rule: string; transactionId: string; approvalId: string | null;
  settlement: Settlement | null; holdExpiresAt: string | null; remedy?: Remedy; next?: string;
  remaining?: { today: number; total: number; perTransaction: number; currency: string };
};
export type SettledState = { transactionId: string; settlement: Settlement | null; authorizedAmount: number; capturedAmount: number | null; released: number; currency: string; merchant: string; settledAt: string | null; settledBy: string | null; note: string | null };
export type MandateInfo = { mandate: string; mandateId: string; status: string; currency: string; limits: { perTransaction: number; daily: number; total: number; approvalAbove: number | null }; remaining: { today: number; total: number }; scope: { allowedMerchants: string[]; blockedCategories: string[]; activeHours: [number, number]; timezone: string }; holds: { ttlHours: number; onExpiry: string; open: SettledState[] }; pendingApprovals: number; expiresAt: string | null };

export class MandateError extends Error {
  constructor(message: string, public status?: number, public body?: Record<string, unknown>) { super(message); this.name = "MandateError"; }
}
export class MandateAuthError extends MandateError { constructor(m: string, s?: number, b?: Record<string, unknown>) { super(m, s, b); this.name = "MandateAuthError"; } }
export class MandateDeclined extends MandateError {
  constructor(public decision: Decision) { super(`declined (${decision.rule}): ${decision.reason}${decision.remedy ? " " + decision.remedy.message : ""}`); this.name = "MandateDeclined"; }
  get remedy() { return this.decision.remedy; }
}
export class MandatePending extends MandateError {
  constructor(public decision: Decision) { super(`pending approval: ${decision.reason}`); this.name = "MandatePending"; }
}

export type AuthorizeInput = { amount: number; merchant: string; purpose?: string; category?: string; idempotencyKey?: string; waitForMs?: number; pollEveryMs?: number; signal?: AbortSignal };

export class Mandate {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(token: string, opts: { baseUrl?: string; timeoutMs?: number; fetch?: typeof fetch } = {}) {
    if (!token || !token.startsWith("mnd_")) throw new MandateAuthError("A mandate token (mnd_…) is required.");
    this.token = token;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<{ status: number; body: T & { error?: string } }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    signal?.addEventListener("abort", () => ctrl.abort());
    try {
      const res = await this.fetchImpl(this.baseUrl + path, { method, signal: ctrl.signal, body: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${this.token}`, accept: "application/json", "user-agent": `mandate-agent-js/${VERSION}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers } });
      const text = await res.text();
      let parsed: unknown = {};
      try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { error: text.slice(0, 200) }; }
      const b = parsed as T & { error?: string };
      if (res.status === 401) throw new MandateAuthError(b.error ?? "Unauthorised", res.status, b as Record<string, unknown>);
      if (res.status === 429) throw new MandateError(b.error ?? "Rate limited", res.status, b as Record<string, unknown>);
      return { status: res.status, body: b };
    } catch (e) {
      if (e instanceof MandateError) throw e;
      throw new MandateError(`Mandate unreachable at ${this.baseUrl}: ${(e as Error).message}`);
    } finally { clearTimeout(timer); }
  }

  /** Ask before paying. `approved` is a hold: capture after paying, or void. With waitForMs, a pending answer is polled (same idempotency key) until the owner decides. */
  async authorize(input: AuthorizeInput): Promise<Decision> {
    if (!Number.isInteger(input.amount) || input.amount <= 0) throw new MandateError("amount must be a positive integer in minor units (1299 for 12.99)");
    const body = { amount: input.amount, merchant: input.merchant, ...(input.purpose ? { purpose: input.purpose } : {}), ...(input.category ? { category: input.category } : {}) };
    const headers: Record<string, string> = input.idempotencyKey ? { "idempotency-key": input.idempotencyKey } : {};
    const deadline = Date.now() + (input.waitForMs ?? 0);
    for (;;) {
      const { status, body: b } = await this.request<Decision>("POST", "/api/agent/authorize", body, headers, input.signal);
      if (status === 200 || status === 202 || status === 403) {
        if (b.decision !== "pending" || !input.waitForMs || Date.now() >= deadline) return b;
        await new Promise((r) => setTimeout(r, Math.min(input.pollEveryMs ?? 5000, Math.max(0, deadline - Date.now()))));
        continue;
      }
      throw new MandateError(b.error ?? `HTTP ${status}`, status, b as Record<string, unknown>);
    }
  }

  /** Like authorize, but throws MandateDeclined / MandatePending so the happy path reads straight. */
  async mustAuthorize(input: AuthorizeInput): Promise<Decision> {
    const d = await this.authorize(input);
    if (d.decision === "declined") throw new MandateDeclined(d);
    if (d.decision === "pending") throw new MandatePending(d);
    return d;
  }

  /** Record what was actually paid (defaults to the full authorised amount); less releases the difference. */
  async capture(transactionId: string, opts: { amount?: number; note?: string } = {}): Promise<SettledState> {
    const { status, body } = await this.request<SettledState>("POST", "/api/agent/capture", { transactionId, ...opts });
    if (status !== 200) throw new MandateError(body.error ?? `HTTP ${status}`, status, body as Record<string, unknown>);
    return body;
  }

  /** Nothing was paid: release the hold. */
  async void(transactionId: string, reason?: string): Promise<SettledState> {
    const { status, body } = await this.request<SettledState>("POST", "/api/agent/void", { transactionId, ...(reason ? { reason } : {}) });
    if (status !== 200) throw new MandateError(body.error ?? `HTTP ${status}`, status, body as Record<string, unknown>);
    return body;
  }

  async get(transactionId: string): Promise<SettledState> {
    const { status, body } = await this.request<SettledState>("GET", `/api/agent/transactions/${encodeURIComponent(transactionId)}`);
    if (status !== 200) throw new MandateError(body.error ?? `HTTP ${status}`, status, body as Record<string, unknown>);
    return body;
  }

  /** Limits, what is left, open holds — so the agent can plan. */
  async mandate(): Promise<MandateInfo> {
    const { status, body } = await this.request<MandateInfo>("GET", "/api/agent/mandate");
    if (status !== 200) throw new MandateError(body.error ?? `HTTP ${status}`, status, body as Record<string, unknown>);
    return body;
  }

  /**
   * Authorise, run `fn`, and settle: `fn` receives the decision and returns the amount actually paid
   * (or undefined for the full amount). If `fn` throws, or returns null, the hold is voided.
   */
  async withHold<T>(input: AuthorizeInput, fn: (hold: Decision) => Promise<{ paid?: number | null; note?: string; result?: T } | number | null | undefined>): Promise<{ state: SettledState; result?: T }> {
    const d = await this.mustAuthorize(input);
    try {
      const out = await fn(d);
      if (out === null) return { state: await this.void(d.transactionId, "not paid") };
      const paid = typeof out === "number" ? out : out?.paid;
      const note = typeof out === "object" && out ? out.note : undefined;
      if (paid === null) return { state: await this.void(d.transactionId, note ?? "not paid"), result: typeof out === "object" && out ? out.result : undefined };
      return { state: await this.capture(d.transactionId, { amount: paid ?? undefined, note }), result: typeof out === "object" && out ? out.result : undefined };
    } catch (e) {
      await this.void(d.transactionId, `error: ${(e as Error).name}`).catch(() => {});
      throw e;
    }
  }
}
