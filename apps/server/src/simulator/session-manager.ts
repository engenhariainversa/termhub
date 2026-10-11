import type { Machine } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';
import { AGENT_OFFLINE_MESSAGE, NO_CHANNELS_MESSAGE } from './agent-tunnel.js';
import type { PortProbe } from './port-probe.js';
import { wdaPortCandidates, wdaPorts, type WdaPorts } from './ports.js';
import type { Tunnel } from './tunnel.js';
import { WdaClient, type Orientation } from './wda-client.js';

export type SimStatus = { state: 'booting' | 'starting' | 'ready' | 'error'; message?: string; tail?: string[] };
export interface Screen {
  width: number;
  height: number;
  orientation: Orientation;
}

export interface Viewer {
  onFrame(frame: Buffer): void;
  onStatus(s: SimStatus): void;
  onScreen(s: Screen): void;
}

export interface SimulatorBackend {
  boot(machine: Machine, udid: string): Promise<void>;
  runnerAlive(machine: Machine, udid: string): Promise<boolean>;
  startRunner(machine: Machine, udid: string, ports: WdaPorts): Promise<void>;
  stopRunner(machine: Machine, udid: string): Promise<void>;
  runnerTail(machine: Machine, udid: string): Promise<string[]>;
  openTunnel(machine: Machine, ports: WdaPorts): Promise<Tunnel>;
  /** Classifies the pair's ports on the machine (through a short-lived tunnel). */
  probePorts(machine: Machine, ports: WdaPorts): Promise<PortProbe>;
  createClient(baseUrl: string): WdaClient;
  openMjpeg(port: number, onFrame: (f: Buffer) => void, onEnd: (err?: Error) => void): () => void;
}

export interface SessionHandle {
  client: WdaClient;
  readonly screen: Screen;
  setSettings(scale: number, quality: number): Promise<void>;
  refreshScreen(): Promise<Screen>;
  setPaused(paused: boolean): void;
  release(): void;
}

interface Options {
  idleMs?: number;
  readyTimeoutMs?: number;
  /** Timeout de prontidão usado durante a recuperação (túnel/stream caiu), mais curto que o do start
   *  inicial: o runner já deveria estar de pé, então não vale a pena esperar os mesmos 90s por tentativa. */
  recoverReadyTimeoutMs?: number;
  pollMs?: number;
  log?: (msg: string, meta?: object) => void;
}

const DEFAULT_SETTINGS = { mjpegServerFramerate: 30, mjpegScalingFactor: 50, mjpegServerScreenshotQuality: 40 };
const RECOVER_ATTEMPTS = 3;
const RECOVER_DELAY_MS = 2000;
const MAX_RELOCATIONS = 2;
export const RELOCATING_MESSAGE = 'Reiniciando o WebDriverAgent em outras portas…';
export const NO_FREE_PORTS_MESSAGE = 'Nenhuma porta livre para o WebDriverAgent no Mac (8100–8199 / 9100–9199)';
export function mjpegPortTakenMessage(port: number): string {
  return `A porta ${port} do Mac está em uso por outro programa; o vídeo do simulador não consegue subir`;
}
const STREAM_DEAD_MESSAGE = 'O vídeo do simulador não responde';
/** Only the MJPEG reader's own messages ("MJPEG respondeu 404", "MJPEG sem dados por 15s") are pt-BR. */
export function streamDeadMessage(cause?: Error): string {
  return cause?.message.startsWith('MJPEG ') ? `${STREAM_DEAD_MESSAGE} (${cause.message})` : STREAM_DEAD_MESSAGE;
}
const DISPOSED_ERROR = 'sessão encerrada';
const CONNECTION_LOST_MESSAGE = 'Conexão com o simulador perdida';

/**
 * The message a failed recovery shows the viewer. Only messages written for the user pass through:
 * the agent tunnel's pt-BR ones and `HttpError`s from `agentRpc`. Anything else (an agent-side
 * "internal"/"connect failed", a timeout, an ssh stderr) falls back to the generic sentence.
 */
function recoveryMessage(err: Error | undefined): string {
  if (!err) return CONNECTION_LOST_MESSAGE;
  if (err instanceof HttpError) return err.message;
  if (err.message === AGENT_OFFLINE_MESSAGE || err.message === NO_CHANNELS_MESSAGE) return err.message;
  return CONNECTION_LOST_MESSAGE;
}

interface Session {
  key: string;
  machine: Machine;
  udid: string;
  ports: WdaPorts;
  viewers: Set<Viewer>;
  /** Subconjunto de `viewers` que não está pausado — o stream MJPEG fica aberto sse a sessão está
   *  pronta e este conjunto não está vazio (ver `activateViewer`/`deactivateViewer`). */
  activeViewers: Set<Viewer>;
  starting: Promise<void> | null;
  ready: boolean;
  client: WdaClient | null;
  tunnel: Tunnel | null;
  /** Why the current `tunnel` closed on its own (null while it is up); cleared when a new one opens. */
  tunnelError: Error | null;
  closeMjpeg: (() => void) | null;
  /** Streams in a row that ended before their first frame. */
  streamStrikes: number;
  screen: Screen;
  idleTimer: ReturnType<typeof setTimeout> | null;
  recovering: Promise<void> | null;
  disposed: boolean;
  disposing: Promise<void> | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Uma sessão de WDA por máquina+udid, compartilhada entre viewers (refcount + ociosidade). */
export class SimulatorSessionManager {
  private sessions = new Map<string, Session>();
  private idleMs: number;
  private readyTimeoutMs: number;
  private recoverReadyTimeoutMs: number;
  private pollMs: number;
  private log: (msg: string, meta?: object) => void;
  private knownPorts = new Map<string, WdaPorts>();

  constructor(
    private backend: SimulatorBackend,
    opts: Options = {},
  ) {
    this.idleMs = opts.idleMs ?? 5 * 60_000;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 90_000;
    this.recoverReadyTimeoutMs = opts.recoverReadyTimeoutMs ?? 15_000;
    this.pollMs = opts.pollMs ?? 1000;
    this.log = opts.log ?? (() => {});
  }

  private key(machineId: string, udid: string) {
    return `${machineId}:${udid.toUpperCase()}`;
  }

  isReady(machineId: string, udid: string): boolean {
    return this.sessions.get(this.key(machineId, udid))?.ready ?? false;
  }

  getClient(machineId: string, udid: string): WdaClient | null {
    const s = this.sessions.get(this.key(machineId, udid));
    return s?.ready ? s.client : null;
  }

  async acquire(machine: Machine, udid: string, viewer: Viewer): Promise<SessionHandle> {
    const key = this.key(machine.id, udid);
    // Uma sessão em processo de dispose ainda pode estar no mapa (só some quando o dispose termina,
    // depois do stopRunner) — espera terminar e tenta de novo, para não reaproveitar nem duplicar o runner.
    let s = this.sessions.get(key);
    while (s?.disposed) {
      if (s.disposing) await s.disposing;
      s = this.sessions.get(key);
    }
    if (!s) {
      s = {
        key,
        machine,
        udid,
        ports: this.knownPorts.get(key) ?? wdaPorts(udid),
        viewers: new Set(),
        activeViewers: new Set(),
        starting: null,
        ready: false,
        client: null,
        tunnel: null,
        tunnelError: null,
        closeMjpeg: null,
        streamStrikes: 0,
        screen: { width: 0, height: 0, orientation: 'portrait' },
        idleTimer: null,
        recovering: null,
        disposed: false,
        disposing: null,
      };
      this.sessions.set(key, s);
      s.viewers.add(viewer);
      this.activateViewer(s, viewer);
      s.starting = this.start(s).finally(() => (s!.starting = null));
    } else {
      s.viewers.add(viewer);
      this.activateViewer(s, viewer);
    }
    if (s.idleTimer) {
      clearTimeout(s.idleTimer);
      s.idleTimer = null;
    }
    const pending = s.starting ?? s.recovering;
    if (pending) {
      try {
        await pending;
      } catch (err) {
        this.detachViewer(s, viewer);
        throw err;
      }
      if (s.disposed) {
        // A sessão não sobreviveu (start falhou de vez, ou a recuperação se esgotou): tenta de novo
        // do zero para este viewer, o que cria uma sessão nova.
        this.detachViewer(s, viewer);
        return this.acquire(machine, udid, viewer);
      }
    } else if (s.ready) {
      this.notify(viewer, (v) => v.onStatus({ state: 'ready' }));
      this.notify(viewer, (v) => v.onScreen(s!.screen));
    }
    const session = s;
    let released = false;
    return {
      get client() {
        return session.client!;
      },
      get screen() {
        return session.screen;
      },
      setSettings: async (scale, quality) => {
        await session.client!.setSettings({ mjpegServerFramerate: 30, mjpegScalingFactor: scale, mjpegServerScreenshotQuality: quality });
      },
      refreshScreen: async () => {
        const [size, orientation] = await Promise.all([session.client!.windowSize(), session.client!.orientation()]);
        session.screen = { ...size, orientation };
        this.broadcast(session, (v) => v.onScreen(session.screen));
        return session.screen;
      },
      setPaused: (paused) => {
        if (released) return;
        if (paused) this.deactivateViewer(session, viewer);
        else this.activateViewer(session, viewer);
      },
      release: () => {
        if (released) return;
        released = true;
        this.release(session, viewer);
      },
    };
  }

  private notify(viewer: Viewer, fn: (v: Viewer) => void) {
    try {
      fn(viewer);
    } catch {
      /* viewer quebrado não derruba os outros nem trava o refcount */
    }
  }

  private broadcast(s: Session, fn: (v: Viewer) => void) {
    for (const v of s.viewers) this.notify(v, fn);
  }

  // Extraídos em métodos (em vez de "s.tunnel?.close(); s.tunnel = null;" inline repetido) para não
  // depender da checagem de fluxo do TS sobre a propriedade através de awaits/chamadas.
  private closeTunnel(s: Session) {
    s.tunnel?.close();
    s.tunnel = null;
  }

  private closeMjpegStream(s: Session) {
    // Nula antes de chamar: um backend cujo close() dispara onEnd de forma síncrona não pode
    // passar pela guarda "s.closeMjpeg !== close" em openStream e disparar uma recuperação espúria.
    const close = s.closeMjpeg;
    s.closeMjpeg = null;
    close?.();
  }

  /** Marca o viewer como ativo (não pausado); reabre o stream se ele era o único ativo e a sessão
   *  já está pronta. Enquanto a sessão ainda está subindo/recuperando, `start`/`doRecover` decidem
   *  sozinhos, ao terminar, se abrem o stream (olhando `activeViewers.size` naquele momento). */
  private activateViewer(s: Session, viewer: Viewer) {
    if (s.activeViewers.has(viewer)) return;
    s.activeViewers.add(viewer);
    if (s.activeViewers.size === 1 && s.ready) this.openStream(s);
  }

  /** Marca o viewer como pausado; fecha o stream se ele era o último ativo e a sessão está pronta. */
  private deactivateViewer(s: Session, viewer: Viewer) {
    if (!s.activeViewers.delete(viewer)) return;
    if (s.activeViewers.size === 0 && s.ready) this.closeMjpegStream(s);
  }

  /** Tira o viewer dos dois conjuntos (viewers + activeViewers) — usado em toda saída de um viewer:
   *  release() normal e os dois caminhos de falha do acquire (pending rejeitou / sessão não sobreviveu). */
  private detachViewer(s: Session, viewer: Viewer) {
    s.viewers.delete(viewer);
    this.deactivateViewer(s, viewer);
  }

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

  private async start(s: Session): Promise<void> {
    const meta = () => ({ machineId: s.machine.id, udid: s.udid, ...s.ports });
    try {
      this.broadcast(s, (v) => v.onStatus({ state: 'booting' }));
      await this.backend.boot(s.machine, s.udid);
      if (s.disposed) throw new Error(DISPOSED_ERROR);
      this.broadcast(s, (v) => v.onStatus({ state: 'starting' }));
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
          this.log('runner do WDA vivo sem responder nas portas candidatas; reiniciando', meta());
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
        let probe = await this.backend.probePorts(s.machine, s.ports);
        this.checkAlive(s);
        // `free` right after /status is ambiguous (WDA may not have bound the broadcaster yet), so
        // look once more before deciding. `taken` is conclusive: another program owns the port.
        if (probe.mjpeg === 'free') {
          await sleep(this.pollMs);
          this.checkAlive(s);
          probe = await this.backend.probePorts(s.machine, s.ports);
          this.checkAlive(s);
        }
        if (probe.mjpeg === 'mjpeg') break;
        // WDA is up but its MJPEG port answers as something else: WDA could not bind it.
        if (relocations >= MAX_RELOCATIONS) throw new Error(mjpegPortTakenMessage(s.ports.mjpegPort));
        this.log('porta MJPEG do WDA ocupada por outro programa; trocando de portas', meta());
        this.broadcast(s, (v) => v.onStatus({ state: 'starting', message: RELOCATING_MESSAGE }));
        excluded.add(s.ports.wdaPort);
        this.closeTunnel(s);
        await this.backend.stopRunner(s.machine, s.udid);
        await this.startRunnerOnFreePorts(s, excluded);
      }
      this.knownPorts.set(s.key, s.ports);
      const client = s.client!;
      await client.createSession();
      this.checkAlive(s);
      await client.setSettings(DEFAULT_SETTINGS);
      this.checkAlive(s);
      const [size, orientation] = await Promise.all([client.windowSize(), client.orientation()]);
      this.checkAlive(s);
      s.screen = { ...size, orientation };
      if (s.activeViewers.size > 0) this.openStream(s);
      s.ready = true;
      this.log('simulador pronto', meta());
      this.broadcast(s, (v) => {
        v.onStatus({ state: 'ready' });
        v.onScreen(s.screen);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      let tail: string[] | undefined;
      try {
        tail = await this.backend.runnerTail(s.machine, s.udid);
      } catch {
        tail = undefined;
      }
      this.log('falha ao subir simulador: ' + message, meta());
      this.broadcast(s, (v) => v.onStatus({ state: 'error', message, tail }));
      await this.dispose(s, { stopRunner: false });
      throw err instanceof Error ? err : new Error(message);
    }
  }

  /** Throws when the session was disposed or its current tunnel closed on its own (start/connect fail fast). */
  private checkAlive(s: Session) {
    if (s.disposed) throw new Error(DISPOSED_ERROR);
    if (s.tunnelError) throw s.tunnelError;
  }

  /** Abre o túnel e espera o /status do WDA ficar pronto; some com o que criou se a sessão for descartada no meio. */
  private async connect(s: Session, readyTimeoutMs: number): Promise<void> {
    const tunnel = await this.backend.openTunnel(s.machine, s.ports);
    if (s.disposed) {
      tunnel.close();
      throw new Error(DISPOSED_ERROR);
    }
    s.tunnel = tunnel;
    s.tunnelError = null;
    tunnel.onClose((err) => {
      if (s.tunnel !== tunnel || s.disposed) return;
      s.tunnelError = err ?? new Error(CONNECTION_LOST_MESSAGE);
      // While the session is starting, `connect()`/`start()` see `tunnelError` and fail on their own
      // (the viewer gets the tunnel's message); a concurrent recovery would only race them. During a
      // recovery, `recover()` returns the one already running, whose `connect()` fails fast the same way.
      if (s.starting && !s.ready) return;
      void this.recover(s, s.tunnelError);
    });
    s.client = this.backend.createClient(`http://127.0.0.1:${tunnel.wdaPort}`);
    const deadline = Date.now() + readyTimeoutMs;
    for (;;) {
      // A dead tunnel will never answer: fail now instead of polling a closed local port until the deadline.
      this.checkAlive(s);
      let ready = false;
      try {
        ready = (await s.client.status()).ready;
      } catch {
        /* ainda subindo */
      }
      this.checkAlive(s);
      if (ready) return;
      if (Date.now() >= deadline) throw new Error('WDA não ficou pronto a tempo');
      await sleep(this.pollMs);
      this.checkAlive(s);
    }
  }

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

  /** Túnel ou stream caiu: reabre até RECOVER_ATTEMPTS vezes mantendo a sessão WDA. Reentrante-seguro. */
  private recover(s: Session, cause?: Error): Promise<void> {
    if (s.recovering) return s.recovering;
    if (s.disposed) return Promise.resolve();
    const p = this.doRecover(s, cause).finally(() => {
      if (s.recovering === p) s.recovering = null;
    });
    s.recovering = p;
    return p;
  }

  private async doRecover(s: Session, cause?: Error): Promise<void> {
    s.ready = false;
    const meta = { machineId: s.machine.id, udid: s.udid };
    this.log('túnel/stream caiu, tentando recuperar: ' + (cause?.message ?? ''), meta);
    this.broadcast(s, (v) => v.onStatus({ state: 'starting', message: 'Reconectando ao simulador…' }));
    const sessionId = s.client?.sessionId ?? null;
    // Why the last attempt failed — a runnerAlive rejection (e.g. "Agente desconectado" while an
    // agent reconnects) or the reopened tunnel dying ("Máquina sem canais livres") — so the final
    // message can say it instead of the generic "Conexão com o simulador perdida" (see
    // task-6-addendum: a deploy or a wifi hiccup must not kill the session on the first attempt).
    // `recoveryMessage` keeps anything not written for the user out of the viewer.
    let lastError: Error | undefined;
    for (let i = 1; i <= RECOVER_ATTEMPTS; i++) {
      if (s.disposed) return;
      // O runner pode ter morrido de vez na máquina (ex.: sessão tmux matada) — sem ele não adianta
      // reabrir túnel algum; desiste na hora em vez de gastar até recoverReadyTimeoutMs por tentativa.
      // Uma rejeição aqui é diferente: significa que a própria máquina está inalcançável agora (ssh
      // caiu, ou o agente está no meio de uma reconexão) — não é prova de que o runner morreu, então
      // tenta de novo em vez de descartar a sessão na primeira tentativa.
      let alive: boolean;
      try {
        alive = await this.backend.runnerAlive(s.machine, s.udid);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.log(`recuperação ${i}/${RECOVER_ATTEMPTS}: máquina inacessível (${lastError.message})`, meta);
        if (s.disposed) return;
        await sleep(RECOVER_DELAY_MS);
        if (s.disposed) return;
        continue;
      }
      // The machine answered: an earlier "unreachable" no longer explains anything.
      lastError = undefined;
      if (!alive) {
        if (s.disposed) return;
        let tail: string[] | undefined;
        try {
          tail = await this.backend.runnerTail(s.machine, s.udid);
        } catch {
          tail = undefined;
        }
        if (s.disposed) return;
        this.log('runner do WDA morreu durante a recuperação', meta);
        this.closeTunnel(s);
        this.broadcast(s, (v) => v.onStatus({ state: 'error', message: 'Runner do WDA encerrou na máquina', tail }));
        if (s.client) s.client.sessionId = sessionId;
        await this.dispose(s, { stopRunner: false });
        return;
      }
      if (s.disposed) return;
      try {
        this.closeMjpegStream(s);
        this.closeTunnel(s);
        await this.connect(s, this.recoverReadyTimeoutMs);
        if (s.disposed) {
          this.closeTunnel(s);
          return;
        }
        s.client!.sessionId = sessionId;
        if (s.activeViewers.size > 0) this.openStream(s);
        if (s.disposed) {
          this.closeMjpegStream(s);
          this.closeTunnel(s);
          return;
        }
        s.ready = true;
        this.broadcast(s, (v) => {
          v.onStatus({ state: 'ready' });
          v.onScreen(s.screen);
        });
        return;
      } catch (err) {
        if (s.disposed) {
          this.closeTunnel(s);
          return;
        }
        lastError = err instanceof Error ? err : new Error(String(err));
        this.log(`recuperação ${i}/${RECOVER_ATTEMPTS} falhou: ${lastError.message}`, meta);
        await sleep(RECOVER_DELAY_MS);
        if (s.disposed) {
          this.closeTunnel(s);
          return;
        }
      }
    }
    // Esgotou as tentativas: fecha o que sobrou (a última tentativa pode ter deixado um túnel aberto
    // sem nunca ter ficado pronto) e apaga a sessão remota de fato, restaurando o sessionId salvo.
    this.closeTunnel(s);
    const message = recoveryMessage(lastError);
    this.broadcast(s, (v) => v.onStatus({ state: 'error', message }));
    if (s.client) s.client.sessionId = sessionId;
    await this.dispose(s, { stopRunner: false });
  }

  private release(s: Session, viewer: Viewer) {
    this.detachViewer(s, viewer);
    if (s.viewers.size > 0 || s.disposed) return;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => {
      s.idleTimer = null;
      if (s.viewers.size === 0) void this.dispose(s, { stopRunner: true });
    }, this.idleMs);
  }

  private async dispose(s: Session, opts: { stopRunner: boolean }): Promise<void> {
    if (s.disposed) {
      if (s.disposing) await s.disposing;
      return;
    }
    s.disposed = true;
    s.ready = false;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    const p = this.doDispose(s, opts);
    s.disposing = p;
    await p;
  }

  /** Fecha tudo e só então tira a sessão do mapa (depois do stopRunner), para um acquire concorrente
   *  não achar o runner "vivo" nem duplicar o stopRunner. */
  private async doDispose(s: Session, opts: { stopRunner: boolean }): Promise<void> {
    this.closeMjpegStream(s);
    try {
      await s.client?.deleteSession();
    } catch {
      /* WDA pode já ter morrido */
    }
    this.closeTunnel(s);
    if (opts.stopRunner) {
      try {
        await this.backend.stopRunner(s.machine, s.udid);
      } catch {
        /* máquina offline */
      }
    }
    this.sessions.delete(s.key);
    this.log('sessão do simulador encerrada', { machineId: s.machine.id, udid: s.udid, stopRunner: opts.stopRunner });
  }

  async shutdownAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => this.dispose(s, { stopRunner: false })));
  }
}
