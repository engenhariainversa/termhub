import type { IncomingMessage } from 'node:http';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AccessLogInput } from '../db/repositories/index.js';

/** How often the buffered records are written. */
export const ACCESS_LOG_FLUSH_MS = 5_000;
/** A flush writes at most this many rows at once; more are left for the next one. */
export const ACCESS_LOG_BATCH = 1_000;
/**
 * The buffer's ceiling while the database does not take the writes (an outage): past it the oldest
 * records are dropped, and the count is logged, so the process never grows without bound.
 */
export const ACCESS_LOG_MAX_BUFFER = 50_000;

/** Probes from the container healthcheck and the deploy smoke test: no person behind them. */
const PROBES = new Set(['/api/ready', '/api/health']);

export interface AccessLogRecorder {
  record(entry: AccessLogInput): void;
  /** Writes what is buffered now; resolves once written (or failed and kept for the next try). */
  flush(): Promise<void>;
  /** Stops the timer and writes what is left; call before the database closes. */
  close(): Promise<void>;
}

/**
 * Buffers access records (TER-744, Marco Civil art. 15) and writes them in batches, off the request's
 * path: a request never waits on this insert, and a failed write keeps its rows for the next tick. Logs
 * counts only.
 */
export function createAccessLogRecorder(deps: {
  repo: { insertMany(rows: AccessLogInput[]): Promise<void> };
  log: Pick<FastifyBaseLogger, 'warn'>;
  flushMs?: number;
  maxBuffer?: number;
}): AccessLogRecorder {
  const maxBuffer = deps.maxBuffer ?? ACCESS_LOG_MAX_BUFFER;
  let buffer: AccessLogInput[] = [];
  let dropped = 0;
  let inFlight: Promise<void> | null = null;

  const writeOnce = async () => {
    while (buffer.length > 0) {
      const batch = buffer.slice(0, ACCESS_LOG_BATCH);
      try {
        await deps.repo.insertMany(batch);
      } catch (err) {
        deps.log.warn({ pending: buffer.length, code: (err as { code?: string }).code ?? 'unknown' }, 'access log: write failed, kept for the next flush');
        return;
      }
      buffer = buffer.slice(batch.length);
    }
    if (dropped > 0) {
      deps.log.warn({ dropped }, 'access log: buffer full, oldest records dropped');
      dropped = 0;
    }
  };

  const flush = (): Promise<void> => {
    if (!inFlight) inFlight = writeOnce().finally(() => (inFlight = null));
    return inFlight;
  };

  const timer = setInterval(() => void flush(), deps.flushMs ?? ACCESS_LOG_FLUSH_MS);
  timer.unref();

  return {
    record(entry) {
      buffer.push(entry);
      if (buffer.length > maxBuffer) {
        const over = buffer.length - maxBuffer;
        buffer = buffer.slice(over);
        dropped += over;
      }
    },
    flush,
    async close() {
      clearInterval(timer);
      await inFlight;
      await flush();
    },
  };
}

/**
 * The access record of one HTTP response, or null when there is nothing to keep: static files and the
 * SPA fallback (no route of their own), and the healthcheck probes. The route is Fastify's pattern
 * (`/api/tabs/:id`), so neither a query string nor an id-like secret in the path is ever stored.
 */
export function httpAccessEntry(request: FastifyRequest, reply: FastifyReply): AccessLogInput | null {
  const route = request.routeOptions?.url;
  if (!route || route.endsWith('*') || PROBES.has(route)) return null;
  const user = (request as { user?: { id: string } | null }).user ?? null;
  return {
    at: new Date(),
    ip: request.ip || null,
    user_id: user?.id ?? request.mcp?.token.user_id ?? null,
    kind: 'http',
    method: request.method,
    route,
    status: reply.statusCode,
  };
}

/** Records every HTTP response worth keeping (see `httpAccessEntry`). */
export function registerAccessLog(fastify: FastifyInstance, recorder: AccessLogRecorder): void {
  fastify.addHook('onResponse', async (request, reply) => {
    const entry = httpAccessEntry(request, reply);
    if (entry) recorder.record(entry);
  });
}

/**
 * The client address of a WebSocket upgrade, read the way Fastify's `trustProxy: true` reads `request.ip`
 * for HTTP (the leftmost X-Forwarded-For entry, else the socket peer), so both kinds agree.
 */
export function upgradeClientIp(req: IncomingMessage): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return first?.split(',')[0]?.trim() || req.socket.remoteAddress || null;
}
