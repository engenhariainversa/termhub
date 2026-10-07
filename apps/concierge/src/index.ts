import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, IncomingMessage } from 'node:http';
import { z } from 'zod';
import { RunFailed, runClaude } from './run.js';

const SECRET = process.env.CONCIERGE_SECRET ?? '';
const PORT = Number(process.env.PORT ?? 4100);

// An 8000-character message plus the rest of the JSON envelope fits comfortably under this; a
// larger body is rejected before it is ever fully buffered.
const MAX_BODY_BYTES = 64 * 1024;

const body = z.object({
  session_id: z.string().uuid(),
  resume: z.boolean(),
  text: z.string().min(1).max(8000),
  config_dir: z.string().min(1),
  model: z.string().max(60).nullish(),
  token: z.string().min(1),
  mcp_url: z.string().url(),
});

/** Constant-time check of the shared secret; an empty secret refuses everything. Hashing first makes the lengths equal. */
export function secretMatches(header: string | string[] | undefined, secret: string): boolean {
  if (!secret || typeof header !== 'string') return false;
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(header), digest(secret));
}

/** Reads the request body, bailing out (without buffering the rest) once it exceeds the cap. */
async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') return res.writeHead(200).end('ok');
    if (req.method !== 'POST' || req.url !== '/run') return res.writeHead(404).end();
    // The compose network is not authentication: the shared secret is (spec §7.2).
    if (!secretMatches(req.headers['x-concierge-secret'], SECRET)) return res.writeHead(401).end();

    const raw = await readBody(req);
    if (raw === null) {
      // Close the connection: the client may still be sending bytes we never finished reading.
      return res.writeHead(413, { 'content-type': 'application/json', connection: 'close' }).end(JSON.stringify({ error: 'body too large' }));
    }

    let json: unknown;
    try {
      json = raw.length ? JSON.parse(raw.toString()) : {};
    } catch {
      return res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid body' }));
    }
    const parsed = body.safeParse(json);
    if (!parsed.success) return res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid body' }));

    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
    try {
      for await (const line of runClaude(parsed.data)) res.write(line + '\n');
      res.end();
    } catch (e) {
      // The frames already sent stay valid; the last line says why it stopped. The failure is
      // classified here, in the only place that has the CLI's stderr, and only the resulting label
      // crosses the wire: stderr itself can carry terminal content and the prompt (spec §7.1), so
      // neither it nor an arbitrary error message is ever put on the frame. `missing_session` is
      // what lets the app retry on a fresh session instead of failing forever.
      const failed = e instanceof RunFailed ? e : null;
      res.write(JSON.stringify({ type: 'termhub_error', code: failed?.code ?? null, reason: failed?.reason ?? 'run_failed' }) + '\n');
      res.end();
    }
  } catch {
    // One bad request must never be able to end the process: nothing above may escape unhandled.
    if (!res.headersSent) res.writeHead(500).end();
    else res.end();
  }
});

server.listen(PORT, () => console.log(`concierge listening on ${PORT}`));
