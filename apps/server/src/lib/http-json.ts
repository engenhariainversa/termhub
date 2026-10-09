/** Shared fetch with timeout; returns status + parsed JSON (or text). Never throws on HTTP errors. */
export async function httpJson(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ status: number; body: unknown; text: string; headers: Headers }> {
  const { timeoutMs = 12000, ...rest } = init;
  const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body, text, headers: res.headers };
}
