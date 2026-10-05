import { WebSocketServer, WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { SCROLL_MAX_LINES } from '@termhub/machine-ops';
import type { Repositories } from '../db/repositories/index.js';
import type { Machine, Project, Tab } from '../db/repositories/types.js';
import { rejectUpgrade, type createUpgradeRouter } from '../ws/router.js';
import { Scoped } from '../auth/scope.js';
import { AgentOfflineError, agents } from '../agent/registry.js';
import { AgentRpcError } from '../agent/connection.js';
import { versionAtLeast } from '../agent/errors.js';
import { RESTART_CLOSE } from '../ws/drain.js';
import { createPtySession, type PtySession } from './pty-session.js';
import { TERMINAL_SCROLL_MIN_AGENT_VERSION, scrollSession } from './session-ops.js';
import { pickLocale, t, type Locale } from '../i18n/index.js';

/** What the person sees when the terminal could not start: what to do when we know the cause. */
function openErrorMessage(err: unknown, locale: Locale): string {
  if (err instanceof AgentRpcError) {
    if (err.rpcError.code === 'no_tmux') return t(locale, 'tmux não encontrado nesta máquina. Instale o tmux e tente de novo.');
    // the agent's generic failure is almost always node-pty's spawn-helper, which doctor repairs
    if (err.rpcError.code === 'internal') return t(locale, 'Esta máquina não conseguiu abrir o terminal. Rode termhub-agent doctor nela.');
  }
  return t(locale, 'Falha ao iniciar terminal');
}

const controlSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('resize'), cols: z.number().int().min(2).max(500), rows: z.number().int().min(2).max(200) }),
  z.object({ type: z.literal('ping') }),
  /** A mouse-wheel scroll (TER-465): < 0 up, > 0 down. */
  z.object({ type: z.literal('scroll'), lines: z.number().int().min(-SCROLL_MAX_LINES).max(SCROLL_MAX_LINES).refine((n) => n !== 0) }),
]);

/** Whether the tab's machine can take a wheel scroll: ssh/local always, an agent from 0.12.0 on. */
function canScroll(machine: Machine): boolean {
  if (machine.type !== 'agent') return true;
  const version = agents.info(machine.id)?.agent_version;
  return !!version && versionAtLeast(version, TERMINAL_SCROLL_MIN_AGENT_VERSION);
}

interface Deps {
  repos: Repositories;
  log: FastifyBaseLogger;
}

export function registerTerminalWs(router: ReturnType<typeof createUpgradeRouter>, deps: Deps): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const log = deps.log.child({ mod: 'ws' });

  router.add(/^\/ws\/tabs\/([a-z0-9]+)\/?$/, async ({ req, socket, head, url, params, scope }) => {
    const tabId = params[0];
    // ownership: a tab outside the caller's scope is a 404, like a missing one
    const found = await new Scoped(deps.repos, scope).tab(tabId).catch(() => null);
    if (!found || found.tab.kind !== 'terminal') return rejectUpgrade(socket, 404, 'Not Found');
    const { tab, project, machine, cwd } = found;
    const locale = pickLocale(scope.user.locale, req.headers['accept-language']);

    const cols = Number(url.searchParams.get('cols')) || 80;
    const rows = Number(url.searchParams.get('rows')) || 24;

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      void handleConnection(ws, { tab, project, machine, cwd, cols, rows, locale }, deps, log);
    });
  });

  // Heartbeat: derruba conexões mortas (sem ping do cliente) a cada 30s.
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      const w = ws as WebSocket & { isAlive?: boolean };
      if (w.isAlive === false) {
        w.terminate();
        continue;
      }
      w.isAlive = false;
      w.ping();
    }
  }, 30_000);
  wss.on('close', () => clearInterval(interval));

  return wss;
}

async function handleConnection(
  ws: WebSocket,
  ctx: { tab: Tab; project: Project; machine: Machine; cwd: string; cols: number; rows: number; locale: Locale },
  deps: Deps,
  log: FastifyBaseLogger,
) {
  const w = ws as WebSocket & { isAlive?: boolean };
  w.isAlive = true;
  ws.on('pong', () => (w.isAlive = true));

  const send = (msg: object) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  // createPtySession() can take a while for an agent machine (up to the agent's own open
  // timeout) — register close/error listeners *before* the await so a client that disconnects
  // mid-open isn't lost: without this, the 'close' event fires with no listener attached and,
  // once the await resolves, the just-opened session is never killed (leaks a channel toward
  // the agent's MAX_CHANNELS instead of being torn down).
  let clientGone = false;
  const onEarlyDisconnect = () => {
    clientGone = true;
  };
  ws.once('close', onEarlyDisconnect);
  ws.once('error', onEarlyDisconnect);

  // An agent that is moving between instances (a deploy) gets a few seconds to arrive instead of an error.
  await agents.awaitAgent(ctx.machine);
  if (clientGone) {
    ws.off('close', onEarlyDisconnect);
    ws.off('error', onEarlyDisconnect);
    return;
  }

  let session: PtySession;
  try {
    session = await createPtySession(
      ctx.machine,
      ctx.cwd,
      ctx.tab,
      { cols: ctx.cols, rows: ctx.rows },
      {
        onData: (data) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.from(data, 'utf8'), { binary: true });
        },
        onExit: (code) => {
          send({ type: 'exit', code });
          ws.close(1000, 'pty exit');
        },
        onLost: () => {
          // The machine's connection dropped, the tmux session did not: the browser reconnects right away.
          log.info({ tabId: ctx.tab.id, machineId: ctx.machine.id }, 'agent connection lost');
          ws.close(RESTART_CLOSE, 'agent reconnecting');
        },
      },
    );
  } catch (err) {
    ws.off('close', onEarlyDisconnect);
    ws.off('error', onEarlyDisconnect);
    if (clientGone) return; // the client is already gone — no one to notify
    if (err instanceof AgentOfflineError) {
      log.info({ tabId: ctx.tab.id, machineId: ctx.machine.id }, 'agente desconectado');
      send({ type: 'error', message: t(ctx.locale, 'Agente desconectado') });
      ws.close(1011, 'agent offline');
      return;
    }
    log.error({ err, tabId: ctx.tab.id }, 'falha ao iniciar pty');
    send({ type: 'error', message: openErrorMessage(err, ctx.locale) });
    ws.close(1011, 'pty spawn failed');
    return;
  }

  ws.off('close', onEarlyDisconnect);
  ws.off('error', onEarlyDisconnect);
  if (clientGone) {
    // The browser socket closed while the PTY was still opening: kill the just-opened
    // session instead of leaking it.
    session.kill();
    return;
  }

  // Nunca logamos conteúdo do terminal: só metadados.
  log.info({ tabId: ctx.tab.id, machineId: ctx.machine.id, pid: session.pid }, 'terminal conectado');
  void deps.repos.projects.touchTerminal(ctx.project.id).catch(() => {});
  const scroll = canScroll(ctx.machine);
  send({ type: 'ready', scroll });

  // ── Mouse wheel (TER-465) ──
  // Every tmux call of this connection runs in order on one chain, so a scroll and the "leave copy-mode"
  // before a key never cross. While one scroll is on its way, later deltas add up into the next call.
  // After a scroll the pane may sit in copy-mode, where tmux would eat the keys: the first key typed
  // afterwards waits for `scrollSession(…, 0)` (leave copy-mode), and every key behind it waits in order.
  const tmuxSession = ctx.tab.tmux_session as string;
  let chain: Promise<void> = Promise.resolve();
  let pendingLines = 0;
  let flushQueued = false;
  let scrolled = false;
  let held: Buffer[] | null = null;
  const tmuxScroll = async (lines: number) => {
    try {
      await scrollSession(ctx.machine, tmuxSession, lines);
    } catch (err) {
      // metadata only: never the pane's content
      log.warn({ tabId: ctx.tab.id, machineId: ctx.machine.id, lines, code: (err as { code?: unknown } | null)?.code }, 'scroll falhou');
    }
  };
  const onScroll = (lines: number) => {
    pendingLines = Math.max(-SCROLL_MAX_LINES, Math.min(SCROLL_MAX_LINES, pendingLines + lines));
    scrolled = true;
    if (flushQueued) return;
    flushQueued = true;
    chain = chain.then(async () => {
      flushQueued = false;
      const n = pendingLines;
      pendingLines = 0;
      if (n !== 0) await tmuxScroll(n);
    });
  };
  const onInput = (data: Buffer) => {
    if (held) {
      held.push(data);
      return;
    }
    if (!scrolled) {
      session.write(data);
      return;
    }
    // typing cancels the scrolls still waiting, and takes the pane back to the bottom first
    scrolled = false;
    pendingLines = 0;
    held = [data];
    chain = chain.then(async () => {
      await tmuxScroll(0);
      const keys = held ?? [];
      held = null;
      for (const k of keys) session.write(k);
    });
  };

  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      onInput(raw as Buffer);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const msg = controlSchema.safeParse(parsed);
    if (!msg.success) return;
    if (msg.data.type === 'resize') session.resize(msg.data);
    else if (msg.data.type === 'ping') send({ type: 'pong' });
    else if (msg.data.type === 'scroll' && scroll) onScroll(msg.data.lines);
  });

  ws.on('close', () => {
    session.kill();
    log.info({ tabId: ctx.tab.id }, 'terminal desconectado');
  });
  ws.on('error', () => session.kill());
}
