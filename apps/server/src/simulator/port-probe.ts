import http from 'node:http';

export type WdaPortState = 'free' | 'wda' | 'taken';
export type MjpegPortState = 'free' | 'mjpeg' | 'taken';
export interface PortProbe {
  wda: WdaPortState;
  mjpeg: MjpegPortState;
}

type Raw = { kind: 'closed' } | { kind: 'silent' } | { kind: 'response'; status: number; contentType: string; body: string };

const MAX_BODY = 64 * 1024;

/**
 * One GET on 127.0.0.1:<port>. "closed" = refused or closed before any response (an ssh or agent
 * tunnel closes the local socket when the remote connect is refused); "silent" = still open with no
 * response after `timeoutMs`. With `headersOnly` the request is dropped as soon as the headers arrive
 * (WDA's MJPEG stream never ends). If the timeout hits after the headers arrived, the partial body
 * is returned as a response.
 */
function get(port: number, path: string, timeoutMs: number, headersOnly: boolean): Promise<Raw> {
  return new Promise((resolve) => {
    let settled = false;
    let started: { status: number; contentType: string } | null = null;
    let body = '';
    const done = (r: Raw) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(r);
    };
    const req = http.get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      started = { status: res.statusCode ?? 0, contentType: String(res.headers['content-type'] ?? '') };
      if (headersOnly) return done({ kind: 'response', ...started, body: '' });
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > MAX_BODY) done({ kind: 'response', ...started!, body });
      });
      res.on('end', () => done({ kind: 'response', ...started!, body }));
      res.on('error', () => done({ kind: 'response', ...started!, body }));
      res.on('aborted', () => done({ kind: 'response', ...started!, body }));
    });
    req.on('error', () => done(started ? { kind: 'response', ...started, body } : { kind: 'closed' }));
    const timer = setTimeout(() => done(started ? { kind: 'response', ...started, body } : { kind: 'silent' }), timeoutMs);
  });
}

function classifyWda(r: Raw): WdaPortState {
  if (r.kind === 'closed') return 'free';
  if (r.kind === 'silent' || r.status !== 200) return 'taken';
  try {
    const v = JSON.parse(r.body) as { value?: { ready?: unknown } };
    return typeof v.value?.ready === 'boolean' ? 'wda' : 'taken';
  } catch {
    return 'taken';
  }
}

function classifyMjpeg(r: Raw): MjpegPortState {
  if (r.kind === 'closed') return 'free';
  if (r.kind === 'silent' || r.status !== 200) return 'taken';
  return /multipart\/x-mixed-replace/i.test(r.contentType) ? 'mjpeg' : 'taken';
}

/** Classifies the two local ports of a tunnel (or of the machine itself, for a local machine). */
export async function probeLocalPorts(wdaPort: number, mjpegPort: number, timeoutMs = 3000): Promise<PortProbe> {
  const [wda, mjpeg] = await Promise.all([get(wdaPort, '/status', timeoutMs, false), get(mjpegPort, '/', timeoutMs, true)]);
  return { wda: classifyWda(wda), mjpeg: classifyMjpeg(mjpeg) };
}
