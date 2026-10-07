import type { AiProvider } from './ai-credentials.js';
import { CLAUDE_LOGIN_HINT, parseClaudeCredential, queryClaudeUsage } from './ai-usage-claude.js';
import { CHATGPT_LOGIN_HINT, parseChatgptCredential, queryChatgptUsage } from './ai-usage-chatgpt.js';
import {
  ANTIGRAVITY_LOGIN_HINT,
  ANTIGRAVITY_OPTIONS,
  GEMINI_LOGIN_HINT,
  GEMINI_OPTIONS,
  parseAntigravityCredential,
  parseGeminiCredential,
  queryCodeAssistUsage,
} from './ai-usage-code-assist.js';
import { type AiCredential, type AiUsageResult, type UsageContext, type UsageHttp, parseJsonBody, parseRetryAfter } from './ai-usage-shared.js';

export * from './ai-usage-shared.js';
export { CLAUDE_USAGE_URL, parseClaudeCredential, parseUsageBody, queryClaudeUsage } from './ai-usage-claude.js';
export { CHATGPT_USAGE_URL, parseChatgptCredential, queryChatgptUsage } from './ai-usage-chatgpt.js';
export { CODE_ASSIST_URL, type CodeAssistOptions, parseAntigravityCredential, parseGeminiCredential, parseQuotaBuckets, parseQuotaSummary, queryCodeAssistUsage } from './ai-usage-code-assist.js';

/** Shown when no credential was found on the machine (or it could not be parsed). */
export const AI_LOGIN_HINTS: Record<AiProvider, string> = {
  claude: CLAUDE_LOGIN_HINT,
  chatgpt: CHATGPT_LOGIN_HINT,
  gemini: GEMINI_LOGIN_HINT,
  antigravity: ANTIGRAVITY_LOGIN_HINT,
};

/** Parses what credentialScript(provider) printed. Throws an Error (never quoting the token) when there is no token. */
export function parseAiCredential(provider: AiProvider, stdout: string): AiCredential {
  switch (provider) {
    case 'claude':
      return parseClaudeCredential(stdout);
    case 'chatgpt':
      return parseChatgptCredential(stdout);
    case 'gemini':
      return parseGeminiCredential(stdout);
    case 'antigravity':
      return parseAntigravityCredential(stdout);
  }
}

/**
 * Asks the provider for the account's usage through `http`, which holds the credential (in-process
 * fetch on the machine, or curl over SSH). May throw what `http` throws (e.g. a TimeoutError).
 */
export function queryUsage(provider: AiProvider, ctx: UsageContext, http: UsageHttp): Promise<AiUsageResult> {
  switch (provider) {
    case 'claude':
      return queryClaudeUsage(ctx, http);
    case 'chatgpt':
      return queryChatgptUsage(ctx, http);
    case 'gemini':
      return queryCodeAssistUsage(ctx, http, GEMINI_OPTIONS);
    case 'antigravity':
      return queryCodeAssistUsage(ctx, http, ANTIGRAVITY_OPTIONS);
  }
}

/**
 * A UsageHttp over the global fetch, for code running on the machine that holds the credential.
 * Adds `authorization: Bearer <token>` and, for ChatGPT with an account id, `chatgpt-account-id`.
 * Never throws on HTTP errors; a timeout rejects with a TimeoutError.
 */
export function fetchUsageHttp(provider: AiProvider, cred: AiCredential, timeoutMs = 12000): UsageHttp {
  return async (req) => {
    const headers: Record<string, string> = { ...(req.headers ?? {}), authorization: `Bearer ${cred.token}` };
    if (provider === 'chatgpt' && cred.extra.account_id) headers['chatgpt-account-id'] = cred.extra.account_id;
    const res = await fetch(req.url, { method: req.method ?? 'GET', headers, body: req.body, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    return { status: res.status, body: parseJsonBody(text), text, retryAfterMs: parseRetryAfter(res.headers.get('retry-after')) };
  };
}

/**
 * The whole query on the machine that holds the credential: parses credentialScript's output and asks
 * the provider. Never throws; failures come back as `{ ok: false, error, hint }`, never with the token.
 */
export async function usageFromCredentialOutput(provider: AiProvider, stdout: string): Promise<AiUsageResult> {
  const fail = (error: string, hint: string | null = null): AiUsageResult => ({ ok: false, plan: null, windows: [], error, hint });
  const out = stdout.trim();
  if (!out) return fail('No credential found on the machine', AI_LOGIN_HINTS[provider]);
  let cred: AiCredential;
  try {
    cred = parseAiCredential(provider, out);
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Could not parse the credential', AI_LOGIN_HINTS[provider]);
  }
  try {
    return await queryUsage(provider, { plan: cred.plan, expires_at: cred.expires_at }, fetchUsageHttp(provider, cred));
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') return fail('Provider did not answer in time');
    return fail(err instanceof Error ? err.message : 'Unknown error');
  }
}
