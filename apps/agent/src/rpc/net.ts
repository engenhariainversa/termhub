import type { RpcParams, RpcResult } from '@termhub/agent-protocol';

export interface UrlCheck {
  url: string;
  /** The HTTP answer, or null when nothing answered (then `error` says why). */
  status: number | null;
  error: string | null;
}

/** Per address: under the server's 15 s RPC timeout, with the checks running side by side. */
export const URL_CHECK_TIMEOUT_MS = 5_000;

/**
 * An empty POST without a token, redirects not followed. termhub answers 401 on the monitor hooks and
 * MCP addresses to a caller without a token, so 401 proves the path from this machine to the app; a
 * proxy or firewall in the way answers something else, or nothing (TER-586).
 */
export async function checkUrl(url: string, timeoutMs = URL_CHECK_TIMEOUT_MS, fetchImpl: typeof fetch = fetch): Promise<UrlCheck> {
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Only the status matters; drop the body so the socket is released.
    await res.body?.cancel().catch(() => undefined);
    return { url, status: res.status, error: null };
  } catch (err) {
    return { url, status: null, error: fetchErrorText(err) };
  }
}

/** `fetch failed` says nothing: the useful part (ENOTFOUND, ECONNREFUSED, a TLS error) is in `cause`. */
function fetchErrorText(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'sem resposta (timeout)';
  const cause = e?.cause;
  const text = cause?.code ? `${cause.code}${cause.message && !cause.message.includes(cause.code) ? `: ${cause.message}` : ''}` : (cause?.message ?? e?.message ?? String(err));
  return text.slice(0, 500);
}

export async function check(params: RpcParams<'net.check'>): Promise<RpcResult<'net.check'>> {
  return { results: await Promise.all(params.urls.map((url) => checkUrl(url))) };
}
