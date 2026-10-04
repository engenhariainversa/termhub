import type { AiProvider } from '../db/repositories/types.js';

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

export interface AiProviderAdapter {
  provider: AiProvider;
  /** Shell script (POSIX sh) that prints the credential JSON on the machine. $D = config dir. */
  credentialScript(configDir: string | null): string;
  parseCredential(stdout: string): AiCredential;
  fetchUsage(cred: AiCredential): Promise<AiUsageResult>;
  /** Hint shown when no credential was found on the machine. */
  loginHint: string;
}
