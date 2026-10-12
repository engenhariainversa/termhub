import { type AiCredential, type AiUsageResult, type AiUsageWindow, type UsageContext, type UsageHttp, isObj, num, parseCredentialJson, str, toIso, windowLabel } from './ai-usage-shared.js';

/**
 * ChatGPT (Plus / Pro / Team subscription).
 * Credential: Codex CLI login — ~/.codex/auth.json. Usage comes from the endpoint
 * Codex's /status uses. Best effort: the endpoint is not documented by OpenAI.
 */
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

export const CHATGPT_LOGIN_HINT = 'Run `codex` on that machine and sign in with ChatGPT (or set the config dir if you use CODEX_HOME).';

export function parseChatgptCredential(stdout: string): AiCredential {
  const json = parseCredentialJson(stdout, 'Codex');
  const tokens = isObj(json) && isObj(json.tokens) ? json.tokens : null;
  const token = tokens ? str(tokens.access_token) : null;
  if (!token) throw new Error('Codex credential has no ChatGPT access token (API-key logins have no usage limits to show)');
  const accountId = tokens ? str(tokens.account_id) : null;
  // the access token is a JWT: exp is in seconds
  let expiresAt: number | null = null;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    const exp = num(payload.exp);
    if (exp) expiresAt = exp * 1000;
  } catch {
    /* not a JWT: fine */
  }
  const extra: Record<string, string> = accountId ? { account_id: accountId } : {};
  return { token, extra, expires_at: expiresAt, plan: null };
}

/** The transport adds `authorization` and, when the credential has an account id, `chatgpt-account-id`. */
export async function queryChatgptUsage(ctx: UsageContext, http: UsageHttp): Promise<AiUsageResult> {
  const base: AiUsageResult = { ok: false, plan: null, windows: [], error: null, hint: null };
  if (ctx.expires_at && ctx.expires_at < Date.now()) {
    return { ...base, error: 'ChatGPT token expired', hint: 'Run `codex` on that machine once; it refreshes the token on use.' };
  }
  const r = await http({ url: CHATGPT_USAGE_URL, headers: { accept: 'application/json', 'user-agent': 'termhub' } });
  if (r.status === 401 || r.status === 403) return { ...base, error: `OpenAI rejected the token (${r.status})`, hint: 'Run `codex` on that machine once to refresh the login.' };
  if (r.status === 429) return { ...base, error: 'OpenAI rate-limited the usage query', hint: 'Showing the last reading; retrying in a few minutes.', rate_limited: true, retry_after_ms: r.retryAfterMs };
  if (r.status >= 400 || !isObj(r.body)) return { ...base, error: `Unexpected response from OpenAI (${r.status})`, hint: r.text.slice(0, 200) || null };

  const plan = str(r.body.plan_type) ?? str(r.body.plan) ?? null;
  const windows: AiUsageWindow[] = [];
  const rl = isObj(r.body.rate_limit) ? r.body.rate_limit : r.body;
  const named: [string, string][] = [
    ['primary_window', 'primary'],
    ['secondary_window', 'secondary'],
  ];
  for (const [key, fallback] of named) {
    const w = rl[key];
    if (!isObj(w)) continue;
    const used = num(w.used_percent);
    if (used === null) continue;
    const seconds = num(w.limit_window_seconds);
    const resetAt = toIso(w.reset_at) ?? (num(w.reset_after_seconds) !== null ? new Date(Date.now() + (num(w.reset_after_seconds) as number) * 1000).toISOString() : null);
    windows.push({ key, label: windowLabel(seconds) ?? fallback, utilization: Math.max(0, Math.min(100, used)), resets_at: resetAt });
  }
  if (windows.length === 0) return { ...base, plan, error: 'No usage windows in the response', hint: r.text.slice(0, 200) || null };
  return { ...base, ok: true, plan, windows };
}
