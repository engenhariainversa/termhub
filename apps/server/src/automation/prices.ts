/**
 * API prices used to estimate what a tab's tokens would cost on the Claude API (spec D23). The number is
 * an "equivalente em API": subscription accounts are not billed per token.
 *
 * Keyed by model family, so a new version of a family is priced without a release. US$ per million tokens,
 * the current model of each family (Claude Opus 5.5, Claude Sonnet 5.5, Claude Haiku 4.5). Older versions
 * of a family are priced as the current one, which makes their estimate approximate (Opus 4.x cost $5/$25).
 * Source: Anthropic's pricing page, https://platform.claude.com/docs/en/about-claude/pricing, as cached in
 * the Claude API reference on 2026-09-25 and read on 2026-10-05. Cache writes are the 5-minute rate
 * (1.25 × input); cache reads are the published rate.
 */
export const PRICES_USD_PER_MTOK = {
  opus: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  sonnet: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  haiku: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
} as const;

export type ModelFamily = keyof typeof PRICES_USD_PER_MTOK;

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** The family of a model id (`claude-opus-5-5`, `claude-3-5-sonnet-20241022`, `us.anthropic.claude-haiku-4-5`); null when unknown. */
export function familyOf(model: string): ModelFamily | null {
  const m = model.toLowerCase();
  if (!m.includes('claude')) return null;
  for (const family of Object.keys(PRICES_USD_PER_MTOK) as ModelFamily[]) {
    if (new RegExp(`(^|[^a-z])${family}([^a-z]|$)`).test(m)) return family;
  }
  return null;
}

/** The estimated cost in US$ of these counts on `model`; null for a model the table does not know. */
export function costOf(model: string, u: TokenCounts): number | null {
  const family = familyOf(model);
  if (!family) return null;
  const p = PRICES_USD_PER_MTOK[family];
  return (u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite) / 1_000_000;
}
