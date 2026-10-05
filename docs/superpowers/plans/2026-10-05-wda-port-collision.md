# WDA port collision (TER-983) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The iOS simulator tab moves the WDA runner to free ports when its ports are taken, and stops reconnecting forever when the MJPEG stream never delivers a frame.

**Architecture:** Server only (`apps/server/src/simulator`). A new probe classifies the ports of a candidate pair through the existing tunnel; the session manager uses it to pick a free pair before starting the runner, to find a runner that is already running, and to check the MJPEG after WDA is ready. The recovery loop counts frame-less streams and gives up after 3. No agent change.

**Tech Stack:** TypeScript, Node 22 `node:http`/`node:net`, Vitest (fake timers in the manager tests).

**Spec:** `docs/superpowers/specs/2026-10-05-wda-port-collision-design.md`

## Global Constraints

- UI copy is pt-BR; code, comments, commits and docs in English (CLAUDE.md).
- No change to `apps/agent`, `packages/agent-protocol` or `packages/machine-ops`.
- Candidate 0 must stay equal to `wdaPorts(udid)` (runners started by the previous release are found).
- Never log terminal content; logs carry metadata only (machine id, udid, ports).
- Run tests with `npm test -w @termhub/server -- <path>` from the worktree root
  (`/Volumes/Extra/projects/8020/termhub-ter-983`). Typecheck: `npm run typecheck -w @termhub/server`.
- Commit messages: imperative English subject ≤ 72 chars, ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: Port candidates

**Files:**
- Modify: `apps/server/src/simulator/ports.ts`
- Test: `apps/server/src/simulator/ports.test.ts`

**Interfaces:**
- Produces: `wdaPortCandidates(udid: string, count?: number): WdaPorts[]` (default `count = 10`).

- [ ] **Step 1: Write the failing test** (append to `ports.test.ts`, importing `wdaPortCandidates`)

```ts
describe('wdaPortCandidates', () => {
  const UDID = '8E4BF65A-8DEA-4044-9DAA-537559DBB669';

  it('starts with the pair wdaPorts gives, so runners from the previous release are found', () => {
    expect(wdaPortCandidates(UDID)[0]).toEqual(wdaPorts(UDID));
  });

  it('returns 10 distinct pairs that keep the 8100/9100 offset and wrap at 100', () => {
    const c = wdaPortCandidates(UDID);
    expect(c).toHaveLength(10);
    expect(new Set(c.map((p) => p.wdaPort)).size).toBe(10);
    for (const p of c) {
      expect(p.wdaPort).toBeGreaterThanOrEqual(8100);
      expect(p.wdaPort).toBeLessThan(8200);
      expect(p.mjpegPort - p.wdaPort).toBe(1000);
    }
  });

  it('wraps around after port 8199', () => {
    // This UDID hashes to 80: the 20th candidate wraps back to 8100.
    const c = wdaPortCandidates(UDID, 25);
    expect(c[19]).toEqual({ wdaPort: 8199, mjpegPort: 9199 });
    expect(c[20]).toEqual({ wdaPort: 8100, mjpegPort: 9100 });
  });
});
```

Check first with `node -e` that this UDID hashes to 80 (`wdaPorts` gives 8180, observed on the hulk). If the existing test file has no `describe`/`it` imports for these, add them.

- [ ] **Step 2: Run** `npm test -w @termhub/server -- src/simulator/ports.test.ts` → FAIL (`wdaPortCandidates` is not exported).

- [ ] **Step 3: Implement** in `ports.ts`, below `wdaPorts`:

```ts
/**
 * Pairs to try, in order, when the first one is taken on the machine (TER-983): the hash pair first,
 * then the next ones, wrapping inside 8100–8199 / 9100–9199.
 */
export function wdaPortCandidates(udid: string, count = 10): WdaPorts[] {
  const h = fnv1a(udid.toUpperCase()) % 100;
  return Array.from({ length: count }, (_, k) => {
    const off = (h + k) % 100;
    return { wdaPort: 8100 + off, mjpegPort: 9100 + off };
  });
}
```

- [ ] **Step 4: Run** the same command → PASS.

- [ ] **Step 5: Commit** `Simulator: list WDA port candidates per device`

---

### Task 2: Port probe and backend wiring

**Files:**
- Create: `apps/server/src/simulator/port-probe.ts`
- Test: `apps/server/src/simulator/port-probe.test.ts`
- Modify: `apps/server/src/simulator/session-manager.ts` (only the `SimulatorBackend` interface)
- Modify: `apps/server/src/simulator/backend.ts`
- Modify: `apps/server/src/simulator/session-manager.test.ts` (only `makeBackend`, so the suite keeps passing)

**Interfaces:**
- Produces (in `port-probe.ts`):
  ```ts
  export type WdaPortState = 'free' | 'wda' | 'taken';
  export type MjpegPortState = 'free' | 'mjpeg' | 'taken';
  export interface PortProbe { wda: WdaPortState; mjpeg: MjpegPortState }
  export function probeLocalPorts(wdaPort: number, mjpegPort: number, timeoutMs?: number): Promise<PortProbe>;
  ```
- Produces (in `SimulatorBackend`): `probePorts(machine: Machine, ports: WdaPorts): Promise<PortProbe>`.

- [ ] **Step 1: Write the failing test** `port-probe.test.ts`, with real servers on `127.0.0.1:0`:

```ts
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { findFreePort } from './tunnel-types.js';
import { probeLocalPorts } from './port-probe.js';

const servers: { close(): void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function listen(server: net.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return (server.address() as AddressInfo).port;
}
const httpServer = (handler: http.RequestListener) => listen(http.createServer(handler));

describe('probeLocalPorts', () => {
  it('refused ports are free', async () => {
    expect(await probeLocalPorts(await findFreePort(), await findFreePort())).toEqual({ wda: 'free', mjpeg: 'free' });
  });

  it('a socket closed without a response is free (what ssh and agent tunnels do on ECONNREFUSED)', async () => {
    const port = await listen(net.createServer((sock) => sock.destroy()));
    expect(await probeLocalPorts(port, port)).toEqual({ wda: 'free', mjpeg: 'free' });
  });

  it('recognizes WDA /status and the WDA MJPEG stream', async () => {
    const wda = await httpServer((req, res) => {
      expect(req.url).toBe('/status');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ value: { ready: true }, sessionId: 'x' }));
    });
    const mjpeg = await httpServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=--BoundaryString' });
      res.write('--BoundaryString\r\n'); // and never ends, like WDA
    });
    expect(await probeLocalPorts(wda, mjpeg)).toEqual({ wda: 'wda', mjpeg: 'mjpeg' });
  });

  it('any other HTTP answer means the port is taken (the hulk case: a foreign 404 on 9180)', async () => {
    const foreign = await httpServer((_req, res) => {
      res.statusCode = 404;
      res.end('<html><head><title>Not Found</title></head><body><h1>404 Not Found</h1></body></html>');
    });
    expect(await probeLocalPorts(foreign, foreign)).toEqual({ wda: 'taken', mjpeg: 'taken' });
  });

  it('200 JSON without value.ready is not WDA', async () => {
    const other = await httpServer((_req, res) => res.end(JSON.stringify({ ok: true })));
    expect((await probeLocalPorts(other, await findFreePort())).wda).toBe('taken');
  });

  it('a listener that accepts and stays silent is taken', async () => {
    const silent = await listen(net.createServer(() => {}));
    expect(await probeLocalPorts(silent, silent, 200)).toEqual({ wda: 'taken', mjpeg: 'taken' });
  });
});
```

The `net.Server` used by `listen` holds open sockets in the silent case: close them in `afterEach` too (keep the accepted sockets in an array and `destroy()` them), or the suite hangs.

- [ ] **Step 2: Run** `npm test -w @termhub/server -- src/simulator/port-probe.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** `port-probe.ts`:

```ts
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
 * (WDA's MJPEG stream never ends).
 */
function get(port: number, path: string, timeoutMs: number, headersOnly: boolean): Promise<Raw> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: Raw) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(r);
    };
    const req = http.get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      const status = res.statusCode ?? 0;
      const contentType = String(res.headers['content-type'] ?? '');
      if (headersOnly) return done({ kind: 'response', status, contentType, body: '' });
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > MAX_BODY) done({ kind: 'response', status, contentType, body });
      });
      res.on('end', () => done({ kind: 'response', status, contentType, body }));
      res.on('error', () => done({ kind: 'response', status, contentType, body }));
    });
    req.on('error', () => done({ kind: 'closed' }));
    const timer = setTimeout(() => done({ kind: 'silent' }), timeoutMs);
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
```

If a timeout happens after the headers but before the WDA body ends, the `silent` result is wrong; keep it simple: the timer resolves `silent` only when no response came. Implement that by checking in the timer whether a response started (store `status`/`contentType` in outer variables and resolve `response` with the partial body if they are set).

- [ ] **Step 4: Run** the probe test → PASS.

- [ ] **Step 5: Wire the backend.** In `session-manager.ts`, import `type PortProbe` from `./port-probe.js` and add to `SimulatorBackend`:

```ts
  /** Classifies the pair's ports on the machine (through a short-lived tunnel). */
  probePorts(machine: Machine, ports: WdaPorts): Promise<PortProbe>;
```

In `backend.ts`:

```ts
    probePorts: async (machine, ports) => {
      const tunnel = await openTunnel(machine, ports, { log });
      try {
        return await probeLocalPorts(tunnel.wdaPort, tunnel.mjpegPort);
      } finally {
        tunnel.close();
      }
    },
```

- [ ] **Step 6: Keep the manager suite compiling and green.** In `session-manager.test.ts`, `makeBackend` gets a fake runner location and `probePorts`. Add `import { wdaPorts, type WdaPorts } from './ports.js';` and, inside `makeBackend`, before `const backend`:

```ts
  // Where the fake runner listens. `runnerUp` follows startRunner/stopRunner; before either is
  // called it follows the last runnerAlive answer, so "runner already alive" tests find it on
  // candidate 0 like a runner started by the previous release.
  let runnerAt: WdaPorts = wdaPorts(UDID);
  let runnerUp: boolean | null = null;
  let lastAlive = false;
```

Change `startRunner`/`stopRunner` and add `probePorts` in the object:

```ts
    startRunner: vi.fn(async (_m: Machine, _u: string, ports: WdaPorts) => {
      runnerAt = ports;
      runnerUp = true;
    }),
    stopRunner: vi.fn(async () => {
      runnerUp = false;
    }),
    probePorts: vi.fn(async (_m: Machine, ports: WdaPorts) =>
      (runnerUp ?? lastAlive) && ports.wdaPort === runnerAt.wdaPort
        ? ({ wda: 'wda', mjpeg: 'mjpeg' } as const)
        : ({ wda: 'free', mjpeg: 'free' } as const),
    ),
```

After `...overrides` builds `backend`, wrap `runnerAlive` so the fake knows its last answer (tests keep their own `vi.fn` references; the wrapper calls them):

```ts
  const innerAlive = backend.runnerAlive;
  backend.runnerAlive = vi.fn(async (m: Machine, u: string) => {
    lastAlive = await innerAlive(m, u);
    return lastAlive;
  });
```

Return `runnerAt` access for later tasks: add `runnerPorts: () => runnerAt` to the returned object.

- [ ] **Step 7: Run** `npm test -w @termhub/server -- src/simulator` and `npm run typecheck -w @termhub/server` → all PASS (the manager does not call `probePorts` yet).

- [ ] **Step 8: Commit** `Simulator: probe WDA ports through the tunnel`

---

### Task 3: Pick free ports, find a running runner, check the MJPEG

**Files:**
- Modify: `apps/server/src/simulator/session-manager.ts`
- Test: `apps/server/src/simulator/session-manager.test.ts`

**Interfaces:**
- Consumes: `wdaPortCandidates` (Task 1), `SimulatorBackend.probePorts` / `PortProbe` (Task 2), test helper `b.runnerPorts()`.
- Produces: exported constants `RELOCATING_MESSAGE`, `NO_FREE_PORTS_MESSAGE`, and `mjpegPortTakenMessage(port: number): string`.

- [ ] **Step 1: Write the failing tests** (add to the `describe` in `session-manager.test.ts`; import `wdaPortCandidates` from `./ports.js` and the new exports from `./session-manager.js`):

```ts
  const FREE = { wda: 'free', mjpeg: 'free' } as const;
  const RUNNER = { wda: 'wda', mjpeg: 'mjpeg' } as const;
  const cands = wdaPortCandidates(UDID);

  it('fresh start skips a pair whose MJPEG port is taken and starts the runner on the next free one', async () => {
    const b = makeBackend();
    const inner = b.backend.probePorts;
    b.backend.probePorts = vi.fn(async (m, p) => (p.wdaPort === cands[0].wdaPort ? { wda: 'free', mjpeg: 'taken' } : inner(m, p)));
    const mgr = new SimulatorSessionManager(b.backend, { pollMs: 10 });
    const v = makeViewer();
    await mgr.acquire(machine, UDID, v);
    expect(b.backend.startRunner).toHaveBeenCalledTimes(1);
    expect(b.backend.startRunner).toHaveBeenCalledWith(machine, UDID, cands[1]);
    expect(b.backend.openTunnel).toHaveBeenLastCalledWith(machine, cands[1]);
    expect(v.statuses.at(-1)).toBe('ready');
  });

  it('no free pair → clear error, runner never started', async () => {
    const b = makeBackend({ probePorts: vi.fn(async () => ({ wda: 'taken', mjpeg: 'taken' }) as const) });
    const mgr = new SimulatorSessionManager(b.backend, { pollMs: 10 });
    const v = makeViewer();
    await expect(mgr.acquire(machine, UDID, v)).rejects.toThrow(NO_FREE_PORTS_MESSAGE);
    expect(b.backend.startRunner).not.toHaveBeenCalled();
    expect(v.fullStatuses.at(-1)).toMatchObject({ state: 'error', message: NO_FREE_PORTS_MESSAGE });
  });

  it('runner already alive on a shifted pair is found there, not restarted', async () => {
    const b = makeBackend({
      runnerAlive: vi.fn(async () => true),
      probePorts: vi.fn(async (_m, p) => (p.wdaPort === cands[3].wdaPort ? RUNNER : FREE)),
    });
    const mgr = new SimulatorSessionManager(b.backend, { pollMs: 10 });
    await mgr.acquire(machine, UDID, makeViewer());
    expect(b.backend.startRunner).not.toHaveBeenCalled();
    expect(b.backend.stopRunner).not.toHaveBeenCalled();
    expect(b.backend.openTunnel).toHaveBeenLastCalledWith(machine, cands[3]);
  });

  it('runner alive but not found on any pair (its MJPEG is foreign) → stopped and restarted on a free pair', async () => {
    // The hulk case: the runner answers /status on candidate 0, but 9180 belongs to another program.
    let restarted = false;
    const b = makeBackend({
      runnerAlive: vi.fn(async () => true),
      startRunner: vi.fn(async () => {
        restarted = true;
      }),
      probePorts: vi.fn(async (_m, p) => {
        if (p.wdaPort === cands[0].wdaPort) return restarted ? ({ wda: 'free', mjpeg: 'taken' } as const) : ({ wda: 'wda', mjpeg: 'taken' } as const);
        if (restarted && p.wdaPort === cands[1].wdaPort) return RUNNER;
        return FREE;
      }),
    });
    const mgr = new SimulatorSessionManager(b.backend, { pollMs: 10 });
    const v = makeViewer();
    await mgr.acquire(machine, UDID, v);
    expect(b.backend.stopRunner).toHaveBeenCalledTimes(1);
    expect(b.backend.startRunner).toHaveBeenCalledWith(machine, UDID, cands[1]);
    expect(v.fullStatuses.some((st) => st.message === RELOCATING_MESSAGE)).toBe(true);
    expect(v.statuses.at(-1)).toBe('ready');
  });

  it('MJPEG taken after the runner came up → runner moved to the next free pair', async () => {
    let started: number[] = [];
    const b = makeBackend({
      startRunner: vi.fn(async (_m, _u, p) => {
        started.push(p.wdaPort);
      }),
      // Free before the start; once a runner runs on candidate 0, its MJPEG turns out to be foreign.
      probePorts: vi.fn(async (_m, p) => {
        if (!started.includes(p.wdaPort)) return FREE;
        return p.wdaPort === cands[0].wdaPort ? ({ wda: 'wda', mjpeg: 'taken' } as const) : RUNNER;
      }),
    });
    const mgr = new SimulatorSessionManager(b.backend, { pollMs: 10 });
    const v = makeViewer();
    await mgr.acquire(machine, UDID, v);
    expect(started).toEqual([cands[0].wdaPort, cands[1].wdaPort]);
    expect(b.backend.stopRunner).toHaveBeenCalledTimes(1);
    expect(v.statuses.at(-1)).toBe('ready');
  });

  it('MJPEG still taken after 2 relocations → error naming the port, with the runner tail', async () => {
    const started: number[] = [];
    const b = makeBackend({
      startRunner: vi.fn(async (_m, _u, p) => {
        started.push(p.wdaPort);
      }),
      probePorts: vi.fn(async (_m, p) => (started.includes(p.wdaPort) ? ({ wda: 'wda', mjpeg: 'taken' } as const) : FREE)),
    });
    const mgr = new SimulatorSessionManager(b.backend, { pollMs: 10 });
    const v = makeViewer();
    await expect(mgr.acquire(machine, UDID, v)).rejects.toThrow();
    expect(started).toHaveLength(3);
    expect(v.fullStatuses.at(-1)).toMatchObject({ state: 'error', message: mjpegPortTakenMessage(cands[2].mjpegPort), tail: ['linha do runner'] });
  });

  it('remembers the pair: the next session probes it first', async () => {
    const b = makeBackend({ probePorts: vi.fn(async (_m, p) => (p.wdaPort === cands[0].wdaPort ? ({ wda: 'free', mjpeg: 'taken' } as const) : FREE)) });
    // after the start, the runner on candidate 1 answers as a runner
    const probe = b.backend.probePorts as ReturnType<typeof vi.fn>;
    const mgr = new SimulatorSessionManager(b.backend, { pollMs: 10, idleMs: 10 });
    const v = makeViewer();
    probe.mockImplementation(async (_m, p) => {
      if (p.wdaPort === cands[0].wdaPort) return { wda: 'free', mjpeg: 'taken' };
      if ((b.backend.startRunner as ReturnType<typeof vi.fn>).mock.calls.length && p.wdaPort === cands[1].wdaPort) return RUNNER;
      return FREE;
    });
    const h = await mgr.acquire(machine, UDID, v);
    h.release();
    await vi.advanceTimersByTimeAsync(20); // idle → disposed with stopRunner
    probe.mockClear();
    (b.backend.runnerAlive as ReturnType<typeof vi.fn>).mockImplementation(async () => true);
    probe.mockImplementation(async (_m, p) => (p.wdaPort === cands[1].wdaPort ? RUNNER : FREE));
    await mgr.acquire(machine, UDID, makeViewer());
    expect(probe.mock.calls[0][1]).toEqual(cands[1]);
  });
```

Also update the existing test `runner já vivo não é iniciado de novo`: it keeps passing as is (the fake finds the alive runner on candidate 0 through `lastAlive`); confirm it does.

Note on the last test: the runnerAlive wrapper from Task 2 wraps `b.backend.runnerAlive`; `mockImplementation` on the wrapper replaces the wrapper's body, which is fine here.

- [ ] **Step 2: Run** `npm test -w @termhub/server -- src/simulator/session-manager.test.ts` → the new tests FAIL.

- [ ] **Step 3: Implement** in `session-manager.ts`.

Imports: `import { wdaPortCandidates, wdaPorts, type WdaPorts } from './ports.js';`.

Constants (next to the others, exported):

```ts
const MAX_RELOCATIONS = 2;
export const RELOCATING_MESSAGE = 'Reiniciando o WebDriverAgent em outras portas…';
export const NO_FREE_PORTS_MESSAGE = 'Nenhuma porta livre para o WebDriverAgent no Mac (8100–8199 / 9100–9199)';
export function mjpegPortTakenMessage(port: number): string {
  return `A porta ${port} do Mac está em uso por outro programa; o vídeo do simulador não consegue subir`;
}
```

Manager field: `private knownPorts = new Map<string, WdaPorts>();` In `acquire`, the new session uses `ports: this.knownPorts.get(key) ?? wdaPorts(udid)`.

Helpers (methods of the manager):

```ts
  /** Candidate pairs for this session: the remembered one first, then the hash order. */
  private candidates(s: Session): WdaPorts[] {
    const known = this.knownPorts.get(s.key);
    const all = wdaPortCandidates(s.udid);
    return known ? [known, ...all.filter((p) => p.wdaPort !== known.wdaPort)] : all;
  }

  /** The pair where a runner that is already running answers as WDA (status + MJPEG), if any. */
  private async locateRunner(s: Session): Promise<WdaPorts | null> {
    for (const p of this.candidates(s)) {
      const probe = await this.backend.probePorts(s.machine, p);
      if (s.disposed) throw new Error(DISPOSED_ERROR);
      if (probe.wda === 'wda' && probe.mjpeg === 'mjpeg') return p;
    }
    return null;
  }

  /** Starts the runner on the first candidate whose two ports are free, skipping `excluded`. */
  private async startRunnerOnFreePorts(s: Session, excluded: Set<number>): Promise<void> {
    for (const p of this.candidates(s)) {
      if (excluded.has(p.wdaPort)) continue;
      const probe = await this.backend.probePorts(s.machine, p);
      if (s.disposed) throw new Error(DISPOSED_ERROR);
      if (probe.wda !== 'free' || probe.mjpeg !== 'free') continue;
      s.ports = p;
      this.log('iniciando runner do WDA', { machineId: s.machine.id, udid: s.udid, ...p });
      await this.backend.startRunner(s.machine, s.udid, p);
      return;
    }
    throw new Error(NO_FREE_PORTS_MESSAGE);
  }
```

Replace the runner part of `start()` (from `if (!(await this.backend.runnerAlive(...)))` through `await this.connect(s, this.readyTimeoutMs);`) with:

```ts
      const excluded = new Set<number>();
      let fresh = true;
      if (await this.backend.runnerAlive(s.machine, s.udid)) {
        const found = await this.locateRunner(s);
        if (found) {
          s.ports = found;
          fresh = false;
        } else {
          // Alive but not answering as WDA on any candidate (e.g. its MJPEG port belongs to another
          // program): start it over on free ports.
          this.log('runner do WDA vivo sem responder nas portas candidatas; reiniciando', meta);
          this.broadcast(s, (v) => v.onStatus({ state: 'starting', message: RELOCATING_MESSAGE }));
          await this.backend.stopRunner(s.machine, s.udid);
        }
      }
      if (s.disposed) throw new Error(DISPOSED_ERROR);
      if (fresh) await this.startRunnerOnFreePorts(s, excluded);
      for (let relocations = 0; ; relocations++) {
        if (s.disposed) throw new Error(DISPOSED_ERROR);
        await this.connect(s, this.readyTimeoutMs);
        if (!fresh) break; // a located runner was already checked (status + MJPEG)
        const probe = await this.backend.probePorts(s.machine, s.ports);
        this.checkAlive(s);
        if (probe.mjpeg === 'mjpeg') break;
        // WDA is up but its MJPEG port answers as something else: WDA could not bind it.
        if (relocations >= MAX_RELOCATIONS) throw new Error(mjpegPortTakenMessage(s.ports.mjpegPort));
        this.log('porta MJPEG do WDA ocupada por outro programa; trocando de portas', { machineId: s.machine.id, udid: s.udid, ...s.ports });
        this.broadcast(s, (v) => v.onStatus({ state: 'starting', message: RELOCATING_MESSAGE }));
        excluded.add(s.ports.wdaPort);
        this.closeTunnel(s);
        await this.backend.stopRunner(s.machine, s.udid);
        await this.startRunnerOnFreePorts(s, excluded);
      }
      this.knownPorts.set(s.key, s.ports);
```

`meta` is computed at the top of `start()` from `s.ports` and goes stale after a move: change it to a function `const meta = () => ({ machineId: s.machine.id, udid: s.udid, ...s.ports });` and call `meta()` at each use (including the catch block and `'simulador pronto'`).

- [ ] **Step 4: Run** `npm test -w @termhub/server -- src/simulator` → all PASS (new and old). Run `npm run typecheck -w @termhub/server` → PASS.

- [ ] **Step 5: Commit** `Simulator: move the WDA runner to free ports when its ports are taken`

---

### Task 4: Stop the reconnect loop when the stream never delivers a frame

**Files:**
- Modify: `apps/server/src/simulator/session-manager.ts`
- Test: `apps/server/src/simulator/session-manager.test.ts`

**Interfaces:**
- Produces: exported `streamDeadMessage(cause?: Error): string`.

- [ ] **Step 1: Write the failing tests:**

```ts
  it('a stream that keeps ending before its first frame stops after 3 strikes with a clear error', async () => {
    const b = makeBackend();
    const mgr = new SimulatorSessionManager(b.backend, { pollMs: 10 });
    const v = makeViewer();
    await mgr.acquire(machine, UDID, v);
    for (let i = 0; i < 5; i++) {
      b.endStream(new Error('MJPEG respondeu 404'));
      await vi.advanceTimersByTimeAsync(3000);
    }
    expect(b.backend.openMjpeg).toHaveBeenCalledTimes(3);
    expect(v.fullStatuses.at(-1)).toEqual({ state: 'error', message: 'O vídeo do simulador não responde (MJPEG respondeu 404)' });
    expect(mgr.isReady('m1', UDID)).toBe(false);
    expect(b.backend.stopRunner).not.toHaveBeenCalled();
  });

  it('a frame resets the strikes: streams that work for a while keep recovering', async () => {
    const b = makeBackend();
    const mgr = new SimulatorSessionManager(b.backend, { pollMs: 10 });
    const v = makeViewer();
    await mgr.acquire(machine, UDID, v);
    for (let i = 0; i < 5; i++) {
      b.emitFrame(Buffer.from('f'));
      b.endStream(new Error('caiu'));
      await vi.advanceTimersByTimeAsync(3000);
    }
    expect(b.backend.openMjpeg).toHaveBeenCalledTimes(6);
    expect(v.statuses.at(-1)).toBe('ready');
  });

  it('streamDeadMessage keeps the reader pt-BR causes and hides anything else', () => {
    expect(streamDeadMessage(new Error('MJPEG sem dados por 15s'))).toBe('O vídeo do simulador não responde (MJPEG sem dados por 15s)');
    expect(streamDeadMessage(new Error('socket hang up'))).toBe('O vídeo do simulador não responde');
    expect(streamDeadMessage()).toBe('O vídeo do simulador não responde');
  });
```

- [ ] **Step 2: Run** the manager test file → the new tests FAIL.

- [ ] **Step 3: Implement.**

```ts
const STREAM_DEAD_MESSAGE = 'O vídeo do simulador não responde';
/** Only the MJPEG reader's own messages ("MJPEG respondeu 404", "MJPEG sem dados por 15s") are pt-BR. */
export function streamDeadMessage(cause?: Error): string {
  return cause?.message.startsWith('MJPEG ') ? `${STREAM_DEAD_MESSAGE} (${cause.message})` : STREAM_DEAD_MESSAGE;
}
```

`Session` gets `streamStrikes: number` (initialized to `0` in `acquire`), documented as "streams in a row that ended before their first frame".

`openStream`:

```ts
  private openStream(s: Session) {
    const port = s.tunnel!.mjpegPort;
    let gotFrame = false;
    const close = this.backend.openMjpeg(
      port,
      (frame) => {
        if (!gotFrame) {
          gotFrame = true;
          s.streamStrikes = 0;
        }
        this.broadcast(s, (v) => v.onFrame(frame));
      },
      (err) => {
        if (s.closeMjpeg !== close || s.disposed) return;
        if (!gotFrame) s.streamStrikes++;
        // A stream that dies before any frame, again and again, is not a network hiccup: reconnecting
        // "succeeds" (WDA's /status is fine) and the cycle would never end (TER-983).
        if (s.streamStrikes >= RECOVER_ATTEMPTS) {
          void this.giveUpStream(s, err);
          return;
        }
        void this.recover(s, err);
      },
    );
    s.closeMjpeg = close;
  }

  private async giveUpStream(s: Session, cause?: Error): Promise<void> {
    this.log('stream MJPEG terminou sem frames repetidas vezes; desistindo: ' + (cause?.message ?? ''), { machineId: s.machine.id, udid: s.udid, ...s.ports });
    s.ready = false;
    this.closeMjpegStream(s);
    this.closeTunnel(s);
    const message = streamDeadMessage(cause);
    this.broadcast(s, (v) => v.onStatus({ state: 'error', message }));
    await this.dispose(s, { stopRunner: false });
  }
```

- [ ] **Step 4: Run** `npm test -w @termhub/server -- src/simulator` and the typecheck → PASS.

- [ ] **Step 5: Commit** `Simulator: stop reconnecting when the stream never delivers a frame`

---

### Task 5: Readable toast for commands on a dead tunnel

**Files:**
- Modify: `apps/server/src/simulator/ws.ts`
- Test: `apps/server/src/simulator/ws.test.ts`

**Interfaces:**
- Produces: exported `commandErrorMessage(err: unknown): string` and `RECONNECTING_TOAST`.

- [ ] **Step 1: Write the failing test** (append to `ws.test.ts`):

```ts
describe('commandErrorMessage', () => {
  it('turns undici "fetch failed" into a pt-BR toast', () => {
    expect(commandErrorMessage(new TypeError('fetch failed'))).toBe(RECONNECTING_TOAST);
    expect(RECONNECTING_TOAST).toBe('Simulador reconectando; tente de novo em instantes.');
  });
  it('keeps WDA errors and other messages as before', () => {
    expect(commandErrorMessage(new WdaError(500, 'boom'))).toBe('WDA: boom');
    expect(commandErrorMessage(new Error('outra coisa'))).toBe('outra coisa');
    expect(commandErrorMessage('x')).toBe('Comando falhou');
  });
});
```

Check the real `WdaError` constructor signature in `wda-client.ts` (`new WdaError(status, message)`) and adjust if it differs.

- [ ] **Step 2: Run** `npm test -w @termhub/server -- src/simulator/ws.test.ts` → FAIL.

- [ ] **Step 3: Implement** in `ws.ts` (module level), then use it in both places that build a toast from an error (`run` and the `catch` of the message handler):

```ts
export const RECONNECTING_TOAST = 'Simulador reconectando; tente de novo em instantes.';

/** The toast for a failed command. undici's bare "fetch failed" means the tunnel under the client closed. */
export function commandErrorMessage(err: unknown): string {
  if (err instanceof WdaError) return `WDA: ${err.message}`;
  if (err instanceof TypeError && err.message === 'fetch failed') return RECONNECTING_TOAST;
  return err instanceof Error ? err.message : 'Comando falhou';
}
```

- [ ] **Step 4: Run** the ws test and the whole simulator folder → PASS.

- [ ] **Step 5: Commit** `Simulator: readable toast when a command hits a closed tunnel`

---

### Task 6: Lesson and full verification

**Files:**
- Create: `docs/lessons/2026-10-05-wda-mjpeg-port-taken.md`

- [ ] **Step 1: Write the lesson** (format in `docs/lessons/README.md`):

```markdown
---
symptom: "iOS simulator tab stuck on \"Reconectando ao simulador…\" with \"fetch failed\" toasts; server log loops \"túnel/stream caiu, tentando recuperar: MJPEG respondeu 404\""
tags: [simulator, wda, mjpeg, ports, macos]
evidence: fixed
card: TER-983
pr: <PR URL>
agent: claude
date: 2026-10-05
---
## Cause

The WDA ports come from a hash of the UDID (`8100/9100 + hash % 100`). On the Mac, another program
(root or another user, so the user's `lsof` and `netstat` do not show it) already listened on the
MJPEG port 9180. WDA logged `Cannot init screenshots broadcaster service on port 9180 ... Address
already in use` but `/status` still answered `ready: true`, so the server kept reconnecting to a
foreign server that answered 404. "fetch failed" was undici's error for commands sent through tunnels
the loop had just closed.

## Fix

The server probes the candidate pairs through the tunnel before starting the runner, checks the MJPEG
after WDA is ready, and moves the runner to the next free pair (`ports.ts`, `port-probe.ts`,
`session-manager.ts`). A stream that ends before its first frame 3 times in a row stops the session
with "O vídeo do simulador não responde (…)".

## How to check

On the Mac: `tmux capture-pane -p -J -t termhub-wda-<udid8> -S - | grep -i "broadcaster"` shows the
bind error; `python3 -c "import socket; socket.socket().bind(('127.0.0.1', 9180))"` fails with errno 48
when the port is taken even if `lsof` lists nothing. After the fix, the server log shows
"porta MJPEG do WDA ocupada por outro programa; trocando de portas" and the tab connects.
```

The PR URL is filled in after the PR is opened (amend in a follow-up commit on the same branch).

- [ ] **Step 2: Full verification** from the worktree root:

```bash
npm test -w @termhub/server -- src/simulator
npm run typecheck -w @termhub/server
npm run build -w @termhub/web
npm run build -w @termhub/landing
```

All must pass. Then `npm test -w @termhub/server` (whole server suite) and report any failure with
its output; failures in unrelated areas must be shown to be pre-existing (run the same test on
`origin/main`).

- [ ] **Step 3: Commit** `Lessons: WDA MJPEG port taken by another program`
