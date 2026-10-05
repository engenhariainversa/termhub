import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine } from '../db/repositories/types.js';
import type { Screen, SimStatus, SimulatorBackend, Viewer } from './session-manager.js';
import { NO_FREE_PORTS_MESSAGE, RELOCATING_MESSAGE, SimulatorSessionManager, mjpegPortTakenMessage, streamDeadMessage } from './session-manager.js';
import { wdaPortCandidates, wdaPorts, type WdaPorts } from './ports.js';
import { WdaClient } from './wda-client.js';

const machine: Machine = { id: 'm1', name: 'mac', host: 'mac.local', ssh_user: 'u', ssh_port: 22, type: 'ssh', os: 'macos', capabilities: ['wda'], checked_at: null, owner_id: null, owner_name: null, created_at: '' };
const UDID = 'BAE07EB5-8CA8-4C6E-819A-A0240342FF00';

function makeBackend(overrides: Partial<SimulatorBackend> = {}) {
  let frameCb: ((f: Buffer) => void) | null = null;
  let endCb: ((e?: Error) => void) | null = null;
  let tunnelOnClose: ((err?: Error) => void) | null = null;
  const tunnelCloses: ReturnType<typeof vi.fn>[] = [];
  let tunnelSeq = 0;
  let failTunnelsFrom: number | null = null;
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = (json: unknown, status = 200) => new Response(JSON.stringify(json), { status });
    if (url.endsWith('/status')) return body({ value: { ready: true } });
    if (url.endsWith('/session') && init?.method === 'POST') return body({ sessionId: 'S1', value: {} });
    if (url.endsWith('/window/size')) return body({ value: { width: 390, height: 844 } });
    if (url.endsWith('/orientation')) return body({ value: 'PORTRAIT' });
    return body({ value: null });
  }) as unknown as typeof fetch;
  const createClientCalls: string[] = [];
  const createClientInstances: WdaClient[] = [];
  // Falso só na 1ª chamada (o start inicial decide iniciar o runner); depois disso, "vivo" — como na
  // vida real, onde o runner segue rodando em tmux até algo matá-lo. Testes que querem simular o
  // runner morrendo (ex.: durante a recuperação) sobrescrevem runnerAlive explicitamente.
  let runnerAliveCalls = 0;
  // Where the fake runner listens. `runnerUp` follows startRunner/stopRunner; before either is
  // called it follows the last runnerAlive answer, so "runner already alive" tests find it on
  // candidate 0 like a runner started by the previous release.
  let runnerAt: WdaPorts = wdaPorts(UDID);
  let runnerUp: boolean | null = null;
  let lastAlive = false;
  const backend: SimulatorBackend = {
    boot: vi.fn(async () => {}),
    runnerAlive: vi.fn(async () => {
      runnerAliveCalls++;
      return runnerAliveCalls > 1;
    }),
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
    runnerTail: vi.fn(async () => ['linha do runner']),
    // Portas locais distintas a cada chamada, como o túnel ssh real (findFreePort por conexão).
    openTunnel: vi.fn(async (_m, ports) => {
      const n = tunnelSeq++;
      if (failTunnelsFrom !== null && n >= failTunnelsFrom) {
        throw new Error(`túnel falhou (tentativa ${n})`);
      }
      const close = vi.fn();
      tunnelCloses.push(close);
      return {
        wdaPort: 20000 + n,
        mjpegPort: 21000 + n,
        close,
        onClose(cb: (err?: Error) => void) {
          tunnelOnClose = cb;
        },
      };
    }),
    createClient: vi.fn((baseUrl: string) => {
      createClientCalls.push(baseUrl);
      const c = new WdaClient(baseUrl, fetchFn);
      createClientInstances.push(c);
      return c;
    }),
    openMjpeg: vi.fn((_port, onFrame, onEnd) => {
      frameCb = onFrame;
      endCb = onEnd;
      return vi.fn();
    }),
    ...overrides,
  };
  const innerAlive = backend.runnerAlive;
  backend.runnerAlive = vi.fn(async (m: Machine, u: string) => {
    lastAlive = await innerAlive(m, u);
    return lastAlive;
  });
  return {
    backend,
    runnerPorts: () => runnerAt,
    fetchFn,
    createClientCalls,
    createClientInstances,
    tunnelCloses,
    emitFrame: (f: Buffer) => frameCb?.(f),
    endStream: (e?: Error) => endCb?.(e),
    dropTunnel: (e?: Error) => tunnelOnClose?.(e),
    failTunnelsFrom: (n: number) => {
      failTunnelsFrom = n;
    },
  };
}

function makeViewer(): Viewer & { frames: Buffer[]; statuses: string[]; fullStatuses: SimStatus[]; screens: Screen[] } {
  const v = {
    frames: [] as Buffer[],
    statuses: [] as string[],
    fullStatuses: [] as SimStatus[],
    screens: [] as Screen[],
    onFrame(f: Buffer) {
      v.frames.push(f);
    },
    onStatus(s: SimStatus) {
      v.statuses.push(s.state);
      v.fullStatuses.push(s);
    },
    onScreen(s: Screen) {
      v.screens.push(s);
    },
  };
  return v;
}

function deleteCalls(fetchFn: ReturnType<typeof vi.fn>) {
  return fetchFn.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE');
}

function postSessionCalls(fetchFn: ReturnType<typeof vi.fn>) {
  return fetchFn.mock.calls.filter((c) => String(c[0]).endsWith('/session') && (c[1] as RequestInit | undefined)?.method === 'POST');
}

describe('SimulatorSessionManager', () => {

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
    const started: number[] = [];
    const b = makeBackend({
      startRunner: vi.fn(async (_m, _u, p) => {
        started.push(p.wdaPort);
      }),
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
    const b = makeBackend({
      probePorts: vi.fn(async (_m, p) => {
        if (p.wdaPort === cands[0].wdaPort) return { wda: 'free', mjpeg: 'taken' } as const;
        if (p.wdaPort === cands[1].wdaPort && (b.backend.startRunner as ReturnType<typeof vi.fn>).mock.calls.length) return RUNNER;
        return FREE;
      }),
    });
    const probe = b.backend.probePorts as ReturnType<typeof vi.fn>;
    const mgr = new SimulatorSessionManager(b.backend, { pollMs: 10, idleMs: 10 });
    const h = await mgr.acquire(machine, UDID, makeViewer());
    h.release();
    await vi.advanceTimersByTimeAsync(20); // idle → disposed with stopRunner
    probe.mockClear();
    (b.backend.runnerAlive as ReturnType<typeof vi.fn>).mockImplementation(async () => true);
    probe.mockImplementation(async (_m, p) => (p.wdaPort === cands[1].wdaPort ? RUNNER : FREE));
    await mgr.acquire(machine, UDID, makeViewer());
    expect(probe.mock.calls[0][1]).toEqual(cands[1]);
  });
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

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

  it('a frame in between resets the strikes: two dead streams, a working one, two more dead keep the session', async () => {
    const b = makeBackend();
    const mgr = new SimulatorSessionManager(b.backend, { pollMs: 10 });
    const v = makeViewer();
    await mgr.acquire(machine, UDID, v);
    const dead = async () => {
      b.endStream(new Error('MJPEG respondeu 404'));
      await vi.advanceTimersByTimeAsync(3000);
    };
    await dead();
    await dead();
    b.emitFrame(Buffer.from('f'));
    b.endStream(new Error('caiu'));
    await vi.advanceTimersByTimeAsync(3000);
    await dead();
    await dead();
    expect(v.statuses.at(-1)).toBe('ready');
    expect(mgr.isReady('m1', UDID)).toBe(true);
    expect(v.fullStatuses.some((st) => st.state === 'error')).toBe(false);
  });

  it('MJPEG reported free right after /status is re-probed once before relocating', async () => {
    const answers = [{ wda: 'wda', mjpeg: 'free' }, { wda: 'wda', mjpeg: 'mjpeg' }] as const;
    let i = 0;
    const b = makeBackend({
      probePorts: vi.fn(async () => {
        if (!(b.backend.startRunner as ReturnType<typeof vi.fn>).mock.calls.length) return FREE;
        return answers[Math.min(i++, 1)];
      }),
    });
    const mgr = new SimulatorSessionManager(b.backend, { pollMs: 10 });
    const v = makeViewer();
    const acquiring = mgr.acquire(machine, UDID, v);
    await vi.advanceTimersByTimeAsync(100);
    await acquiring;
    expect(b.backend.stopRunner).not.toHaveBeenCalled();
    expect(b.backend.startRunner).toHaveBeenCalledTimes(1);
    expect(v.statuses.at(-1)).toBe('ready');
  });

  it('streamDeadMessage keeps the reader pt-BR causes and hides anything else', () => {
    expect(streamDeadMessage(new Error('MJPEG sem dados por 15s'))).toBe('O vídeo do simulador não responde (MJPEG sem dados por 15s)');
    expect(streamDeadMessage(new Error('socket hang up'))).toBe('O vídeo do simulador não responde');
    expect(streamDeadMessage()).toBe('O vídeo do simulador não responde');
  });

  it('sobe runner, túnel, sessão WDA e entrega status/screen/frames', async () => {
    const b = makeBackend();
    const mgr = new SimulatorSessionManager(b.backend, { idleMs: 1000 });
    const v = makeViewer();
    const h = await mgr.acquire(machine, UDID, v);
    expect(b.backend.boot).toHaveBeenCalledWith(machine, UDID);
    expect(b.backend.startRunner).toHaveBeenCalledTimes(1);
    expect(b.backend.openTunnel).toHaveBeenCalledTimes(1);
    expect(v.statuses).toEqual(['booting', 'starting', 'ready']);
    expect(v.screens[0]).toEqual({ width: 390, height: 844, orientation: 'portrait' });
    expect(h.client.sessionId).toBe('S1');
    b.emitFrame(Buffer.from('f1'));
    expect(v.frames).toEqual([Buffer.from('f1')]);
    expect(mgr.isReady('m1', UDID)).toBe(true);
  });

  it('runner já vivo não é iniciado de novo', async () => {
    const b = makeBackend({ runnerAlive: vi.fn(async () => true) });
    const mgr = new SimulatorSessionManager(b.backend);
    await mgr.acquire(machine, UDID, makeViewer());
    expect(b.backend.startRunner).not.toHaveBeenCalled();
  });

  it('segundo viewer compartilha a sessão e recebe os mesmos frames', async () => {
    const b = makeBackend();
    const mgr = new SimulatorSessionManager(b.backend);
    const v1 = makeViewer();
    const v2 = makeViewer();
    await mgr.acquire(machine, UDID, v1);
    await mgr.acquire(machine, UDID, v2);
    expect(b.backend.startRunner).toHaveBeenCalledTimes(1);
    expect(b.backend.openTunnel).toHaveBeenCalledTimes(1);
    expect(v2.statuses).toEqual(['ready']);
    b.emitFrame(Buffer.from('x'));
    expect(v1.frames).toHaveLength(1);
    expect(v2.frames).toHaveLength(1);
  });

  it('último release encerra tudo depois de idleMs, e um novo acquire cancela', async () => {
    const b = makeBackend();
    const mgr = new SimulatorSessionManager(b.backend, { idleMs: 5000 });
    const h = await mgr.acquire(machine, UDID, makeViewer());
    h.release();
    await vi.advanceTimersByTimeAsync(4000);
    expect(b.backend.stopRunner).not.toHaveBeenCalled();
    // novo viewer dentro da janela cancela o encerramento
    const h2 = await mgr.acquire(machine, UDID, makeViewer());
    await vi.advanceTimersByTimeAsync(6000);
    expect(b.backend.stopRunner).not.toHaveBeenCalled();
    h2.release();
    await vi.advanceTimersByTimeAsync(5001);
    expect(b.backend.stopRunner).toHaveBeenCalledWith(machine, UDID);
    expect(b.tunnelCloses[0]).toHaveBeenCalled();
    const del = deleteCalls(b.fetchFn as unknown as ReturnType<typeof vi.fn>).find(() => true);
    expect(String(del?.[0])).toContain('/session/S1');
    expect(mgr.isReady('m1', UDID)).toBe(false);
  });

  it('status nunca pronto → error com o tail do runner e sessão descartada', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ value: { ready: false } }))) as unknown as typeof fetch;
    // sempre "não vivo": cada acquire aqui é uma sessão nova de verdade, não a recuperação de uma existente
    const b = makeBackend({ createClient: (baseUrl) => new WdaClient(baseUrl, fetchFn), runnerAlive: vi.fn(async () => false) });
    const mgr = new SimulatorSessionManager(b.backend, { readyTimeoutMs: 3000, pollMs: 1000 });
    const v = makeViewer();
    const p = mgr.acquire(machine, UDID, v);
    const rejected = expect(p).rejects.toThrow(/não ficou pronto/);
    await vi.advanceTimersByTimeAsync(4000);
    await rejected;
    expect(v.statuses.at(-1)).toBe('error');
    expect(v.fullStatuses.at(-1)?.message).toMatch(/não ficou pronto/);
    expect(v.fullStatuses.at(-1)?.tail).toEqual(['linha do runner']);
    expect(mgr.isReady('m1', UDID)).toBe(false);
    expect(b.backend.runnerTail).toHaveBeenCalled();
    expect(b.backend.stopRunner).not.toHaveBeenCalled();

    // uma tentativa depois disso é uma sessão nova de verdade, não a mesma carcaça
    const v2 = makeViewer();
    const p2 = mgr.acquire(machine, UDID, v2);
    const rejected2 = expect(p2).rejects.toThrow(/não ficou pronto/);
    await vi.advanceTimersByTimeAsync(4000);
    await rejected2;
    expect(b.backend.startRunner).toHaveBeenCalledTimes(2);
  });

  it('stream MJPEG caindo reabre túnel e stream sem recriar a sessão WDA', async () => {
    const b = makeBackend();
    const mgr = new SimulatorSessionManager(b.backend, { pollMs: 10 });
    const v = makeViewer();
    const h = await mgr.acquire(machine, UDID, v);
    b.endStream(new Error('caiu'));
    await vi.advanceTimersByTimeAsync(3000);
    expect(b.backend.openTunnel).toHaveBeenCalledTimes(2);
    expect(b.backend.openMjpeg).toHaveBeenCalledTimes(2);
    expect(b.backend.startRunner).toHaveBeenCalledTimes(1);
    expect(v.statuses).toEqual(['booting', 'starting', 'ready', 'starting', 'ready']);
    // a sessão WDA nunca é recriada: só um POST /session em toda a recuperação
    expect(postSessionCalls(b.fetchFn as unknown as ReturnType<typeof vi.fn>)).toHaveLength(1);
    expect(h.client.sessionId).toBe('S1');
    // o handle obtido antes da queda aponta agora para o client do túnel novo
    expect(h.client).toBe(b.createClientInstances.at(-1));
    expect(b.createClientInstances.length).toBeGreaterThan(1);
  });

  it('túnel caindo (onClose) também reabre túnel e stream sem recriar a sessão WDA', async () => {
    const b = makeBackend();
    const mgr = new SimulatorSessionManager(b.backend, { pollMs: 10 });
    const v = makeViewer();
    await mgr.acquire(machine, UDID, v);
    b.dropTunnel(new Error('túnel caiu'));
    await vi.advanceTimersByTimeAsync(3000);
    expect(b.backend.openTunnel).toHaveBeenCalledTimes(2);
    expect(b.backend.startRunner).toHaveBeenCalledTimes(1);
    expect(v.statuses).toEqual(['booting', 'starting', 'ready', 'starting', 'ready']);
  });

  it('recuperação esgota as tentativas → error, sem stopRunner, túneis fechados', async () => {
    const b = makeBackend();
    const mgr = new SimulatorSessionManager(b.backend, { pollMs: 10 });
    const v = makeViewer();
    await mgr.acquire(machine, UDID, v);
    // a partir da 2ª chamada de openTunnel (a 1ª recuperação), toda tentativa de reabrir falha
    b.failTunnelsFrom(1);
    b.dropTunnel(new Error('caiu de vez'));
    await vi.runAllTimersAsync();
    expect(v.statuses.at(-1)).toBe('error');
    expect(v.fullStatuses.at(-1)?.message).toMatch(/perdida/);
    expect(mgr.isReady('m1', UDID)).toBe(false);
    expect(b.backend.stopRunner).not.toHaveBeenCalled();
    for (const close of b.tunnelCloses) expect(close).toHaveBeenCalled();
  });

  it('runner morto durante a recuperação desiste na hora, sem reabrir túnel', async () => {
    // sempre "não vivo": simula o runner (sessão tmux) morto de vez na máquina
    const b = makeBackend({ runnerAlive: vi.fn(async () => false) });
    const mgr = new SimulatorSessionManager(b.backend, { pollMs: 10 });
    const v = makeViewer();
    await mgr.acquire(machine, UDID, v);
    const openTunnelCallsBefore = (b.backend.openTunnel as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    b.dropTunnel(new Error('túnel caiu'));
    await vi.runAllTimersAsync();
    expect(v.statuses.at(-1)).toBe('error');
    expect(v.fullStatuses.at(-1)?.message).toBe('Runner do WDA encerrou na máquina');
    expect(v.fullStatuses.at(-1)?.tail).toEqual(['linha do runner']);
    // não tentou reabrir túnel nenhuma vez: percebeu o runner morto antes de sequer tentar
    expect((b.backend.openTunnel as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(openTunnelCallsBefore);
    expect(b.backend.stopRunner).not.toHaveBeenCalled();
    expect(mgr.isReady('m1', UDID)).toBe(false);

    // uma sessão nova de verdade depois disso: começa o runner de novo
    const v2 = makeViewer();
    await mgr.acquire(machine, UDID, v2);
    expect(b.backend.startRunner).toHaveBeenCalledTimes(2);
  });

  it('runnerAlive rejeitando em toda tentativa de recuperação: tenta RECOVER_ATTEMPTS vezes e descarta com a mensagem da rejeição (sem unhandled rejection)', async () => {
    // 1ª chamada (start inicial): resolve false, manda iniciar o runner normalmente.
    // Da 2ª chamada em diante (checagem da recuperação): rejeita sempre, simulando a máquina
    // inacessível (ex.: um agente reconectando) — não é prova de que o runner morreu, então cada
    // rejeição soma uma tentativa em vez de descartar a sessão na primeira.
    let calls = 0;
    const runnerAlive = vi.fn(async () => {
      calls++;
      if (calls === 1) return false;
      throw new Error('Agente desconectado');
    });
    const b = makeBackend({ runnerAlive });
    const mgr = new SimulatorSessionManager(b.backend, { pollMs: 10 });
    const v = makeViewer();
    await mgr.acquire(machine, UDID, v);
    const openTunnelCallsBefore = (b.backend.openTunnel as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    const callsBeforeRecover = runnerAlive.mock.calls.length;
    b.dropTunnel(new Error('túnel caiu'));
    await vi.runAllTimersAsync();
    // exatamente RECOVER_ATTEMPTS chamadas de runnerAlive durante a recuperação (todas rejeitadas)
    expect(runnerAlive.mock.calls.length - callsBeforeRecover).toBe(3);
    expect(b.backend.stopRunner).not.toHaveBeenCalled();
    expect(v.statuses.at(-1)).toBe('error');
    expect(v.fullStatuses.at(-1)?.message).toBe('Agente desconectado');
    // uma máquina inalcançável não é prova de runner morto: nunca tenta reabrir o túnel
    expect((b.backend.openTunnel as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(openTunnelCallsBefore);
    expect(mgr.isReady('m1', UDID)).toBe(false);
    // se a rejeição escapasse de doRecover (chamado via "void this.recover(...)"), o vitest reportaria
    // um unhandled rejection e este teste (ou a suíte) falharia sozinho.
  });

  it('runnerAlive rejeita uma vez e depois resolve true: recupera normalmente reabrindo o túnel', async () => {
    // 1ª chamada (start inicial): resolve true (runner já vivo, não inicia de novo).
    // 2ª chamada (1ª tentativa de recuperação): rejeita, simulando uma reconexão do agente em curso.
    // Da 3ª em diante: resolve true — a máquina voltou a responder.
    let calls = 0;
    const runnerAlive = vi.fn(async () => {
      calls++;
      if (calls === 2) throw new Error('Agente desconectado');
      return true;
    });
    const b = makeBackend({ runnerAlive });
    const mgr = new SimulatorSessionManager(b.backend, { pollMs: 10 });
    const v = makeViewer();
    await mgr.acquire(machine, UDID, v);
    expect(b.backend.startRunner).not.toHaveBeenCalled();
    const startRunnerCallsBefore = (b.backend.startRunner as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    const bootCallsBefore = (b.backend.boot as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    b.dropTunnel(new Error('túnel caiu'));
    await vi.runAllTimersAsync();
    expect(v.statuses.at(-1)).toBe('ready');
    expect(mgr.isReady('m1', UDID)).toBe(true);
    expect(b.backend.openTunnel).toHaveBeenCalledTimes(2);
    // nem o boot nem o startRunner rodam de novo: a sessão WDA continua a mesma de antes
    expect((b.backend.boot as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(bootCallsBefore);
    expect((b.backend.startRunner as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(startRunnerCallsBefore);
  });

  it('recuperação com runner vivo mas /status nunca pronto usa recoverReadyTimeoutMs, não readyTimeoutMs', async () => {
    let statusReady = true;
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = (json: unknown) => new Response(JSON.stringify(json), { status: 200 });
      if (url.endsWith('/status')) return body({ value: { ready: statusReady } });
      if (url.endsWith('/session') && init?.method === 'POST') return body({ sessionId: 'S1', value: {} });
      if (url.endsWith('/window/size')) return body({ value: { width: 390, height: 844 } });
      if (url.endsWith('/orientation')) return body({ value: 'PORTRAIT' });
      return body({ value: null });
    }) as unknown as typeof fetch;
    // runner sempre vivo (não é isso que está falhando aqui, é o /status que nunca fica pronto)
    const b = makeBackend({ createClient: (baseUrl) => new WdaClient(baseUrl, fetchFn), runnerAlive: vi.fn(async () => true) });
    const mgr = new SimulatorSessionManager(b.backend, { pollMs: 50, recoverReadyTimeoutMs: 5000 });
    const v = makeViewer();
    await mgr.acquire(machine, UDID, v);
    statusReady = false;
    const start = Date.now();
    b.dropTunnel(new Error('caiu'));
    await vi.runAllTimersAsync();
    const elapsed = Date.now() - start;
    // 3 tentativas de recoverReadyTimeoutMs (5000) + 2 esperas de RECOVER_DELAY_MS (2000) entre elas = 19s,
    // bem menos que as 3×90s que o readyTimeoutMs padrão daria.
    expect(elapsed).toBeGreaterThanOrEqual(3 * 5000 + 2 * 2000 - 250);
    expect(elapsed).toBeLessThan(3 * 5000 + 2 * 2000 + 3000);
    expect(v.fullStatuses.at(-1)?.message).toMatch(/perdida/);
    expect(mgr.isReady('m1', UDID)).toBe(false);
  });

  it('túnel fechando durante o start (sem canais livres) falha na hora com a mensagem do túnel, sem recuperação concorrente', async () => {
    // /status nunca pronto: sem o fail-fast o start ficaria pollando a porta morta até readyTimeoutMs
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ value: { ready: false } }))) as unknown as typeof fetch;
    const b = makeBackend({ createClient: (baseUrl) => new WdaClient(baseUrl, fetchFn) });
    const mgr = new SimulatorSessionManager(b.backend, { readyTimeoutMs: 90_000, pollMs: 1000 });
    const v = makeViewer();
    const p = mgr.acquire(machine, UDID, v);
    const rejected = expect(p).rejects.toThrow('Máquina sem canais livres');
    await vi.advanceTimersByTimeAsync(2000);
    const start = Date.now();
    b.dropTunnel(new Error('Máquina sem canais livres'));
    await vi.advanceTimersByTimeAsync(1500);
    await rejected;
    expect(Date.now() - start).toBeLessThan(5000);
    expect(v.statuses.at(-1)).toBe('error');
    expect(v.fullStatuses.at(-1)?.message).toBe('Máquina sem canais livres');
    // nenhuma recuperação correu em paralelo: um único túnel aberto, nenhum "Reconectando…"
    expect(b.backend.openTunnel).toHaveBeenCalledTimes(1);
    expect(v.fullStatuses.some((st) => st.message === 'Reconectando ao simulador…')).toBe(false);
    expect(b.backend.stopRunner).not.toHaveBeenCalled();
    expect(b.tunnelCloses[0]).toHaveBeenCalled();
    expect(mgr.isReady('m1', UDID)).toBe(false);
  });

  it('agente cai depois de pronto e todo túnel da recuperação morre igual → error "Agente desconectado"', async () => {
    const b = makeBackend();
    let tunnels = 0;
    // o túnel do start fica de pé; cada túnel reaberto na recuperação morre assim que alguém escuta o onClose
    b.backend.openTunnel = vi.fn(async () => {
      const n = tunnels++;
      const close = vi.fn();
      b.tunnelCloses.push(close);
      return {
        wdaPort: 20000 + n,
        mjpegPort: 21000 + n,
        close,
        onClose(cb: (err?: Error) => void) {
          if (n === 0) first = cb;
          else cb(new Error('Agente desconectado'));
        },
      };
    });
    let first: ((err?: Error) => void) | null = null;
    const mgr = new SimulatorSessionManager(b.backend, { pollMs: 10 });
    const v = makeViewer();
    await mgr.acquire(machine, UDID, v);
    first!(new Error('Agente desconectado'));
    await vi.runAllTimersAsync();
    expect(b.backend.openTunnel).toHaveBeenCalledTimes(4);
    expect(v.statuses.at(-1)).toBe('error');
    expect(v.fullStatuses.at(-1)?.message).toBe('Agente desconectado');
    expect(b.backend.stopRunner).not.toHaveBeenCalled();
    expect(mgr.isReady('m1', UDID)).toBe(false);
  });

  it('recuperação que falha com mensagem não destinada ao usuário (inglês, do agente) mostra a mensagem genérica', async () => {
    let calls = 0;
    const runnerAlive = vi.fn(async () => {
      calls++;
      if (calls === 1) return false;
      throw new Error('connect failed: internal');
    });
    const b = makeBackend({ runnerAlive });
    const mgr = new SimulatorSessionManager(b.backend, { pollMs: 10 });
    const v = makeViewer();
    await mgr.acquire(machine, UDID, v);
    b.dropTunnel(new Error('túnel caiu'));
    await vi.runAllTimersAsync();
    expect(v.fullStatuses.at(-1)).toMatchObject({ state: 'error', message: 'Conexão com o simulador perdida' });
  });

  it('rejeição antiga de runnerAlive não vira a mensagem final quando a máquina voltou a responder', async () => {
    let calls = 0;
    const runnerAlive = vi.fn(async () => {
      calls++;
      if (calls === 2) throw new Error('Agente desconectado');
      return true;
    });
    const b = makeBackend({ runnerAlive });
    const mgr = new SimulatorSessionManager(b.backend, { pollMs: 10 });
    const v = makeViewer();
    await mgr.acquire(machine, UDID, v);
    b.failTunnelsFrom(1);
    b.dropTunnel(new Error('túnel caiu'));
    await vi.runAllTimersAsync();
    expect(v.fullStatuses.at(-1)).toMatchObject({ state: 'error', message: 'Conexão com o simulador perdida' });
  });

  it('acquire durante recover espera a recuperação e devolve client apontando para o túnel novo', async () => {
    const b = makeBackend();
    const mgr = new SimulatorSessionManager(b.backend, { pollMs: 10 });
    const v1 = makeViewer();
    const h1 = await mgr.acquire(machine, UDID, v1);
    const clientAntes = h1.client;
    b.endStream(new Error('caiu'));
    // acquire chega enquanto a recuperação está em andamento (mesmo microtask turn)
    const v2 = makeViewer();
    const h2 = await mgr.acquire(machine, UDID, v2);
    expect(v2.statuses.at(-1)).toBe('ready');
    expect(h1.client).toBe(h2.client);
    expect(h1.client).not.toBe(clientAntes);
    expect(h1.client.sessionId).toBe('S1');
    expect(v2.screens.length).toBeGreaterThan(0);
    expect(v2.screens.at(-1)).toEqual(h2.screen);
  });

  it('disposal no meio do start fecha tudo sem vazar túnel/stream', async () => {
    let resolveBoot!: () => void;
    const bootPromise = new Promise<void>((r) => (resolveBoot = r));
    const b = makeBackend({ boot: vi.fn(() => bootPromise) });
    const mgr = new SimulatorSessionManager(b.backend);
    const v = makeViewer();
    const acquirePromise = mgr.acquire(machine, UDID, v);
    const shutdownPromise = mgr.shutdownAll();
    resolveBoot();
    await expect(acquirePromise).rejects.toThrow();
    await shutdownPromise;
    expect(b.backend.openMjpeg).not.toHaveBeenCalled();
    expect(mgr.isReady('m1', UDID)).toBe(false);
    if ((b.backend.openTunnel as unknown as ReturnType<typeof vi.fn>).mock.calls.length > 0) {
      for (const close of b.tunnelCloses) expect(close).toHaveBeenCalled();
    }
  });

  it('disposal durante o polling de /status interrompe o loop sem continuar agendando sleeps', async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = (json: unknown) => new Response(JSON.stringify(json), { status: 200 });
      if (url.endsWith('/status')) return body({ value: { ready: false } });
      return body({ value: null });
    }) as unknown as typeof fetch;
    const b = makeBackend({ createClient: (baseUrl) => new WdaClient(baseUrl, fetchFn) });
    const mgr = new SimulatorSessionManager(b.backend, { pollMs: 100, readyTimeoutMs: 60_000 });
    const v = makeViewer();
    const acquirePromise = mgr.acquire(machine, UDID, v);
    acquirePromise.catch(() => {}); // a asserção da rejeição vem depois; isso só evita unhandled rejection
    await vi.advanceTimersByTimeAsync(250);
    const statusCalls = () => fetchFn.mock.calls.filter((c) => String(c[0]).endsWith('/status')).length;
    const before = statusCalls();
    expect(before).toBeGreaterThan(0);
    await mgr.shutdownAll();
    await vi.advanceTimersByTimeAsync(1000); // bem menos que os 60s de readyTimeoutMs
    expect(statusCalls()).toBe(before); // loop parou: nenhum /status a mais depois do dispose
    await expect(acquirePromise).rejects.toThrow();
    expect(b.backend.openMjpeg).not.toHaveBeenCalled();
    expect(mgr.isReady('m1', UDID)).toBe(false);
  });

  it('acquire concorrente com dispose por ociosidade espera o dispose terminar antes de reiniciar', async () => {
    let resolveDelete!: () => void;
    const deleteGate = new Promise<void>((r) => (resolveDelete = r));
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = (json: unknown, status = 200) => new Response(JSON.stringify(json), { status });
      if (init?.method === 'DELETE') {
        await deleteGate;
        return body({ value: {} });
      }
      if (url.endsWith('/status')) return body({ value: { ready: true } });
      if (url.endsWith('/session') && init?.method === 'POST') return body({ sessionId: 'S1', value: {} });
      if (url.endsWith('/window/size')) return body({ value: { width: 390, height: 844 } });
      if (url.endsWith('/orientation')) return body({ value: 'PORTRAIT' });
      return body({ value: null });
    }) as unknown as typeof fetch;
    const callOrder: string[] = [];
    const b = makeBackend({
      createClient: (baseUrl) => new WdaClient(baseUrl, fetchFn),
      runnerAlive: vi.fn(async () => {
        callOrder.push('runnerAlive');
        return false;
      }),
      stopRunner: vi.fn(async () => {
        callOrder.push('stopRunner');
      }),
    });
    const mgr = new SimulatorSessionManager(b.backend, { idleMs: 1000 });
    const h = await mgr.acquire(machine, UDID, makeViewer());
    h.release();
    await vi.advanceTimersByTimeAsync(1000); // dispara o idle timer; dispose fica pendurado no DELETE /session
    expect(callOrder).not.toContain('stopRunner');

    const acquirePromise = mgr.acquire(machine, UDID, makeViewer());
    resolveDelete();
    await acquirePromise;

    expect(callOrder.filter((c) => c === 'stopRunner')).toHaveLength(1);
    const stopIdx = callOrder.indexOf('stopRunner');
    const secondRunnerAliveIdx = callOrder.lastIndexOf('runnerAlive');
    expect(secondRunnerAliveIdx).toBeGreaterThan(stopIdx);
    expect(b.backend.startRunner).toHaveBeenCalledTimes(2);
  });

  it('shutdownAll fecha túnel e apaga a sessão WDA sem chamar stopRunner', async () => {
    const b = makeBackend();
    const mgr = new SimulatorSessionManager(b.backend);
    await mgr.acquire(machine, UDID, makeViewer());
    await mgr.shutdownAll();
    expect(b.backend.stopRunner).not.toHaveBeenCalled();
    expect(b.tunnelCloses[0]).toHaveBeenCalled();
    const del = deleteCalls(b.fetchFn as unknown as ReturnType<typeof vi.fn>);
    expect(del.length).toBeGreaterThan(0);
    expect(String(del[0]?.[0])).toContain('/session/S1');
    expect(mgr.isReady('m1', UDID)).toBe(false);
  });

  it('viewer que lança em onStatus no fast path não impede acquire nem quebra o refcount', async () => {
    const b = makeBackend();
    const mgr = new SimulatorSessionManager(b.backend, { idleMs: 1000 });
    const v1 = makeViewer();
    const h1 = await mgr.acquire(machine, UDID, v1);
    const throwingViewer: Viewer = {
      onFrame() {},
      onStatus() {
        throw new Error('viewer quebrado');
      },
      onScreen() {},
    };
    const h2 = await mgr.acquire(machine, UDID, throwingViewer);
    h1.release();
    h2.release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(b.backend.stopRunner).toHaveBeenCalledWith(machine, UDID);
  });

  it('setPaused fecha e reabre o stream MJPEG mantendo runner/túnel de pé', async () => {
    const b = makeBackend();
    const mgr = new SimulatorSessionManager(b.backend);
    const v = makeViewer();
    const h = await mgr.acquire(machine, UDID, v);
    expect(b.backend.openMjpeg).toHaveBeenCalledTimes(1);
    const closeFn = (b.backend.openMjpeg as unknown as ReturnType<typeof vi.fn>).mock.results[0]!.value;

    h.setPaused(true);
    expect(closeFn).toHaveBeenCalledTimes(1);
    expect(b.backend.openMjpeg).toHaveBeenCalledTimes(1);

    h.setPaused(false);
    expect(b.backend.openMjpeg).toHaveBeenCalledTimes(2);
    b.emitFrame(Buffer.from('depois-do-resume'));
    expect(v.frames.at(-1)).toEqual(Buffer.from('depois-do-resume'));

    // pausar de novo depois do resume fecha o SEGUNDO stream (o reaberto), não o primeiro de novo
    const closeFn2 = (b.backend.openMjpeg as unknown as ReturnType<typeof vi.fn>).mock.results[1]!.value;
    h.setPaused(true);
    expect(closeFn2).toHaveBeenCalledTimes(1);
    expect(b.backend.openMjpeg).toHaveBeenCalledTimes(2);

    expect(b.backend.startRunner).toHaveBeenCalledTimes(1);
    expect(b.backend.openTunnel).toHaveBeenCalledTimes(1);
  });

  it('duas viewers: pausar uma mantém o stream aberto, pausar as duas fecha, retomar uma reabre', async () => {
    const b = makeBackend();
    const mgr = new SimulatorSessionManager(b.backend);
    const v1 = makeViewer();
    const v2 = makeViewer();
    const h1 = await mgr.acquire(machine, UDID, v1);
    const h2 = await mgr.acquire(machine, UDID, v2);
    expect(b.backend.openMjpeg).toHaveBeenCalledTimes(1);
    const closeFn = (b.backend.openMjpeg as unknown as ReturnType<typeof vi.fn>).mock.results[0]!.value;

    h1.setPaused(true);
    expect(closeFn).not.toHaveBeenCalled();
    expect(b.backend.openMjpeg).toHaveBeenCalledTimes(1);

    h2.setPaused(true);
    expect(closeFn).toHaveBeenCalledTimes(1);
    expect(b.backend.openMjpeg).toHaveBeenCalledTimes(1);

    h2.setPaused(false);
    expect(b.backend.openMjpeg).toHaveBeenCalledTimes(2);
  });

  it('último release fecha o stream na hora; stopRunner/tunnel.close só depois de idleMs', async () => {
    const b = makeBackend();
    const mgr = new SimulatorSessionManager(b.backend, { idleMs: 5000 });
    const v = makeViewer();
    const h = await mgr.acquire(machine, UDID, v);
    const closeFn = (b.backend.openMjpeg as unknown as ReturnType<typeof vi.fn>).mock.results[0]!.value;

    h.release();
    expect(closeFn).toHaveBeenCalledTimes(1);
    expect(b.backend.stopRunner).not.toHaveBeenCalled();
    expect(b.tunnelCloses[0]).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5001);
    expect(b.backend.stopRunner).toHaveBeenCalledWith(machine, UDID);
    expect(b.tunnelCloses[0]).toHaveBeenCalled();
  });

  it('acquire numa sessão ociosa-mas-viva (sem viewers, stream fechado) reabre o stream sem recriar runner/túnel', async () => {
    const b = makeBackend();
    const mgr = new SimulatorSessionManager(b.backend, { idleMs: 5000 });
    const v1 = makeViewer();
    const h1 = await mgr.acquire(machine, UDID, v1);
    h1.release();
    expect(b.backend.openMjpeg).toHaveBeenCalledTimes(1);

    const v2 = makeViewer();
    const h2 = await mgr.acquire(machine, UDID, v2);
    expect(v2.statuses.at(-1)).toBe('ready');
    expect(b.backend.openMjpeg).toHaveBeenCalledTimes(2);
    expect(b.backend.startRunner).toHaveBeenCalledTimes(1);
    expect(b.backend.openTunnel).toHaveBeenCalledTimes(1);

    b.emitFrame(Buffer.from('f'));
    expect(v2.frames).toHaveLength(1);
    void h2;
  });

  it('fechar o stream de propósito (pause) não dispara recuperação', async () => {
    const b = makeBackend();
    const mgr = new SimulatorSessionManager(b.backend);
    const v = makeViewer();
    const h = await mgr.acquire(machine, UDID, v);
    expect(b.backend.openTunnel).toHaveBeenCalledTimes(1);

    h.setPaused(true);
    // simula o onEnd do reader chegando depois do close intencional (fecho de rede real, atrasado)
    b.endStream(new Error('encerrado'));
    await vi.runAllTimersAsync();

    expect(b.backend.openTunnel).toHaveBeenCalledTimes(1);
    expect(v.statuses).toEqual(['booting', 'starting', 'ready']);
  });

  it('resume durante a recuperação não reabre o stream antes dela terminar; abre uma vez no túnel novo depois', async () => {
    const b = makeBackend();
    const mgr = new SimulatorSessionManager(b.backend, { pollMs: 10 });
    const v = makeViewer();
    const h = await mgr.acquire(machine, UDID, v);
    expect(b.backend.openMjpeg).toHaveBeenCalledTimes(1);
    const closeFn1 = (b.backend.openMjpeg as unknown as ReturnType<typeof vi.fn>).mock.results[0]!.value;

    h.setPaused(true);
    expect(closeFn1).toHaveBeenCalledTimes(1);

    b.dropTunnel(new Error('caiu'));
    // ainda na mesma volta síncrona: doRecover já marcou a sessão como não-pronta antes do 1º await
    expect(mgr.isReady('m1', UDID)).toBe(false);
    h.setPaused(false);
    // resume chegando com a recuperação em andamento: não reabre na hora (sessão não está pronta)
    expect(b.backend.openMjpeg).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3000);
    expect(mgr.isReady('m1', UDID)).toBe(true);
    // reabriu exatamente uma vez, já no túnel novo, porque havia um viewer ativo ao terminar
    expect(b.backend.openMjpeg).toHaveBeenCalledTimes(2);
    b.emitFrame(Buffer.from('novo-tunel'));
    expect(v.frames).toEqual([Buffer.from('novo-tunel')]);
  });

  it('recuperação com zero viewers ativos termina com o stream fechado; viewer pausado ainda recebe ready/screen', async () => {
    const b = makeBackend();
    const mgr = new SimulatorSessionManager(b.backend, { pollMs: 10 });
    const v = makeViewer();
    const h = await mgr.acquire(machine, UDID, v);
    const closeFn1 = (b.backend.openMjpeg as unknown as ReturnType<typeof vi.fn>).mock.results[0]!.value;
    h.setPaused(true);
    expect(closeFn1).toHaveBeenCalledTimes(1);
    v.statuses.length = 0;
    v.screens.length = 0;

    b.dropTunnel(new Error('caiu'));
    await vi.advanceTimersByTimeAsync(3000);

    expect(mgr.isReady('m1', UDID)).toBe(true);
    expect(v.statuses).toEqual(['starting', 'ready']);
    expect(v.screens.length).toBeGreaterThan(0);
    // ninguém ativo: a recuperação não reabriu o stream
    expect(b.backend.openMjpeg).toHaveBeenCalledTimes(1);
  });

  it('release de um viewer pausado com outro ativo não fecha o stream do viewer ativo', async () => {
    const b = makeBackend();
    const mgr = new SimulatorSessionManager(b.backend);
    const v1 = makeViewer();
    const v2 = makeViewer();
    const h1 = await mgr.acquire(machine, UDID, v1);
    const h2 = await mgr.acquire(machine, UDID, v2);
    expect(b.backend.openMjpeg).toHaveBeenCalledTimes(1);
    const closeFn = (b.backend.openMjpeg as unknown as ReturnType<typeof vi.fn>).mock.results[0]!.value;

    h1.setPaused(true);
    expect(closeFn).not.toHaveBeenCalled();

    h1.release();
    expect(closeFn).not.toHaveBeenCalled();
    expect(b.backend.openMjpeg).toHaveBeenCalledTimes(1);

    b.emitFrame(Buffer.from('ainda-vivo'));
    expect(v2.frames).toEqual([Buffer.from('ainda-vivo')]);
    void h2;
  });

  it('onEnd de um reader antigo chegando depois que o resume abriu um novo não dispara recuperação', async () => {
    const b = makeBackend();
    const mgr = new SimulatorSessionManager(b.backend, { pollMs: 10 });
    const v = makeViewer();
    const h = await mgr.acquire(machine, UDID, v);
    const openMjpegMock = b.backend.openMjpeg as unknown as ReturnType<typeof vi.fn>;
    const oldEndCb = openMjpegMock.mock.calls[0]![2] as (e?: Error) => void;

    h.setPaused(true);
    h.setPaused(false);
    expect(openMjpegMock).toHaveBeenCalledTimes(2);
    expect(b.backend.openTunnel).toHaveBeenCalledTimes(1);

    // o reader antigo (do stream já fechado pelo pause) chega atrasado com seu onEnd
    oldEndCb(new Error('reader antigo encerrando atrasado'));
    await vi.runAllTimersAsync();

    expect(b.backend.openTunnel).toHaveBeenCalledTimes(1);
    expect(v.statuses).toEqual(['booting', 'starting', 'ready']);
  });
});
