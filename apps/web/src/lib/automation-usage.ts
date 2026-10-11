import { api } from './api';
import { formatNumber } from './format';
import type { AutomationUsage, AutomationUsageLine, ProgressUsage } from './types';

/** A project's usage, or null when it cannot be read: a missing cost is never an error on screen. */
export async function loadUsage(projectId: string): Promise<AutomationUsage | null> {
  try {
    return await api.automation.usage(projectId);
  } catch {
    return null;
  }
}

/** The estimate in US$ ("US$ 1,23" / "$1.23"); "—" when nothing was priced (an unknown model, a Codex tab). Below a cent shows 4 digits. */
export function formatCost(cost: number | null): string {
  if (cost === null) return '—';
  const digits = cost > 0 && cost < 0.01 ? 4 : 2;
  return formatNumber(cost, { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Tokens, compact ("1,2 mi" / "1.2M"). */
export function formatTokenCount(tokens: number): string {
  return formatNumber(tokens, { notation: 'compact', maximumFractionDigits: 1 });
}

/** Every token of a usage line. */
export function tokensOf(line: AutomationUsageLine): number {
  return line.input_tokens + line.output_tokens + line.cache_read_tokens + line.cache_write_tokens;
}

/** The short form the cost labels show. */
export function usageOf(line: AutomationUsageLine): ProgressUsage {
  return { tokens: tokensOf(line), cost_usd: line.cost_usd };
}

export function hasTokens(line: AutomationUsageLine): boolean {
  return tokensOf(line) > 0;
}
