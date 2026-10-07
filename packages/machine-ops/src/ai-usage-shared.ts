/**
 * Types and helpers shared by the AI usage adapters (ai-usage-*.ts). The credential is read and
 * used on the machine that holds it (agent, or the server's own host); over SSH only the provider's
 * HTTP response comes back. Nothing here ever logs the token or puts it in an error or hint.
 */

/** One rate-limit window (e.g. "5 hours", "7 days"). utilization is 0..100. */
export interface AiUsageWindow {
  key: string;
  label: string;
  utilization: number;
  resets_at: string | null;
  /** Set when the window caps one model only (lowercase family, e.g. "fable"); absent = the whole account. */
  model?: string;
}

export interface AiUsageResult {
  ok: boolean;
  /** plan / tier name as reported by the provider, when available */
  plan: string | null;
  windows: AiUsageWindow[];
  /** human-readable failure and a hint on how to fix it (never contains the token) */
  error: string | null;
  hint: string | null;
  /** the provider rate-limited the usage query itself (HTTP 429): back off, keep the last reading */
  rate_limited?: boolean;
  /** provider-suggested wait before asking again (Retry-After), when given */
  retry_after_ms?: number | null;
}

export interface AiCredential {
  token: string;
  /** provider-specific extras (e.g. ChatGPT account id) */
  extra: Record<string, string>;
  /** unix ms when the token expires, if known */
  expires_at: number | null;
  /** plan hint from the credential file, if any */
  plan: string | null;
}

/** One HTTP request to the provider's usage endpoint, without any credential header. */
export interface UsageRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
}

/** The provider's answer: status, parsed JSON body (null when not JSON), raw text, Retry-After. */
export interface UsageReply {
  status: number;
  body: unknown;
  text: string;
  retryAfterMs: number | null;
}

/** Sends a UsageRequest; the implementation adds the credential's auth headers itself. */
export type UsageHttp = (req: UsageRequest) => Promise<UsageReply>;

/** What the adapters need from the credential besides the token (which only the transport sees). */
export interface UsageContext {
  plan: string | null;
  expires_at: number | null;
}

export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
export const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** unix seconds/ms or ISO string -> ISO string */
export function toIso(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === 'string' && v) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/** "5 hours" / "7 days" from a window length in seconds. */
export function windowLabel(seconds: number | null): string | null {
  if (!seconds) return null;
  const h = Math.round(seconds / 3600);
  if (h < 24) return `${h} hora${h === 1 ? '' : 's'}`;
  const d = Math.round(h / 24);
  return `${d} dia${d === 1 ? '' : 's'}`;
}

/** Retry-After header value (seconds or HTTP date) -> ms to wait, or null. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  const v = value?.trim();
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** Response text -> parsed JSON, or null when empty / not JSON. */
export function parseJsonBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const clampPercent = (n: number) => Math.max(0, Math.min(100, n));

/**
 * JSON.parse of a credential file. Node's SyntaxError message quotes part of the input, which may be
 * the token itself, so it is replaced by a fixed message.
 */
export function parseCredentialJson(stdout: string, what: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new Error(`Could not parse the ${what} credential`);
  }
}
