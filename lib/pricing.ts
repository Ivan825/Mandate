// Per-million-token prices in USD, used to pre-authorise a call before it is
// forwarded and to settle it afterwards. Unknown models fall back to the
// most expensive price in the family, so an estimate is never too low.
// Edit freely; prices change. Last reviewed September 2026.

export type Provider = "openai" | "anthropic" | "gemini";
export type Price = { input: number; output: number; cachedInput?: number };

export const PRICES: Record<Provider, Record<string, Price>> = {
  openai: {
    "gpt-5": { input: 1.25, output: 10, cachedInput: 0.125 },
    "gpt-5-mini": { input: 0.25, output: 2, cachedInput: 0.025 },
    "gpt-5-nano": { input: 0.05, output: 0.4, cachedInput: 0.005 },
    "gpt-4.1": { input: 2, output: 8, cachedInput: 0.5 },
    "gpt-4.1-mini": { input: 0.4, output: 1.6, cachedInput: 0.1 },
    "gpt-4.1-nano": { input: 0.1, output: 0.4, cachedInput: 0.025 },
    "gpt-4o": { input: 2.5, output: 10, cachedInput: 1.25 },
    "gpt-4o-mini": { input: 0.15, output: 0.6, cachedInput: 0.075 },
    "o3": { input: 2, output: 8, cachedInput: 0.5 },
    "o4-mini": { input: 1.1, output: 4.4, cachedInput: 0.275 },
    "text-embedding-3-small": { input: 0.02, output: 0 },
    "text-embedding-3-large": { input: 0.13, output: 0 },
  },
  anthropic: {
    "claude-opus-4-1": { input: 15, output: 75, cachedInput: 1.5 },
    "claude-opus-4": { input: 15, output: 75, cachedInput: 1.5 },
    "claude-sonnet-4": { input: 3, output: 15, cachedInput: 0.3 },
    "claude-sonnet-4-5": { input: 3, output: 15, cachedInput: 0.3 },
    "claude-3-7-sonnet": { input: 3, output: 15, cachedInput: 0.3 },
    "claude-3-5-haiku": { input: 0.8, output: 4, cachedInput: 0.08 },
    "claude-haiku-4-5": { input: 1, output: 5, cachedInput: 0.1 },
  },
  gemini: {
    "gemini-2.5-pro": { input: 1.25, output: 10, cachedInput: 0.31 },
    "gemini-2.5-flash": { input: 0.3, output: 2.5, cachedInput: 0.075 },
    "gemini-2.5-flash-lite": { input: 0.1, output: 0.4, cachedInput: 0.025 },
    "gemini-2.0-flash": { input: 0.1, output: 0.4, cachedInput: 0.025 },
    "text-embedding-004": { input: 0.15, output: 0 },
  },
};

export function priceFor(provider: Provider, model: string): { price: Price; matched: string } {
  const table = PRICES[provider];
  const m = model.toLowerCase();
  // exact, then longest prefix (handles dated suffixes like -2025-08-07 or -latest)
  if (table[m]) return { price: table[m], matched: m };
  let best: string | null = null;
  for (const k of Object.keys(table)) if (m.startsWith(k) && (!best || k.length > best.length)) best = k;
  if (best) return { price: table[best], matched: best };
  const max = Object.values(table).reduce((a, p) => ({ input: Math.max(a.input, p.input), output: Math.max(a.output, p.output) }), { input: 0, output: 0 });
  return { price: max, matched: "unknown (priced at the family maximum)" };
}

// Cost in USD cents, rounded up so an estimate is never below the true cost.
export function costCents(price: Price, inputTokens: number, outputTokens: number, cachedTokens = 0): number {
  const cachedRate = price.cachedInput ?? price.input;
  const usd = (Math.max(0, inputTokens - cachedTokens) * price.input + cachedTokens * cachedRate + outputTokens * price.output) / 1_000_000;
  return Math.max(1, Math.ceil(usd * 100));
}

// A cheap, conservative token estimate for request bodies: 1 token per 3.5
// characters of text content, which overestimates for English prose.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}
