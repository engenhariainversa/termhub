// Every non-2xx answer of the mobile API (design spec §4). `ApiError` carries the wire `code` and
// the pt-BR `error` text as its own `message`, plus the two fields the session store reacts to:
// `retryAfter` (`423 DEVICE_LOCKED`) and `attemptsLeft` (a wrong PIN proof).
import { t } from '@/i18n';
import { errorBody } from './contract/local';

/** Case-insensitive header lookup: `FetchTransport.fetch` lower-cases every header name, but a
 * caller building `headers` by hand (as tests do) may not. */
function findHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter?: number,
    readonly attemptsLeft?: number
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /**
   * Builds an `ApiError` from a non-2xx response. A body that parses as the contract's `errorBody`
   * wins; `retry_after` in the body takes priority over the `Retry-After` header (seconds), but
   * either maps to `retryAfter`. A body that is not valid JSON, or does not match the shape, falls
   * back to `HTTP_<status>` / `'Erro do servidor (<status>)'` — never throws.
   */
  static fromBody(status: number, headers: Record<string, string>, text: string): ApiError {
    const headerRetryAfter = toNumber(findHeader(headers, 'retry-after'));

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch {
      return new ApiError(status, `HTTP_${status}`, t('Erro do servidor ({{status}})', { status }), headerRetryAfter);
    }

    const result = errorBody.safeParse(parsedJson);
    if (!result.success) {
      return new ApiError(status, `HTTP_${status}`, t('Erro do servidor ({{status}})', { status }), headerRetryAfter);
    }

    const body = result.data;
    return new ApiError(status, body.code, body.error, body.retry_after ?? headerRetryAfter, body.attempts_left);
  }
}
