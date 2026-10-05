import { WebSocketServer, WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import type { Repositories } from '../db/repositories/index.js';
import type { Tab } from '../db/repositories/types.js';
import { rejectUpgrade, type createUpgradeRouter } from '../ws/router.js';
import { Scoped } from '../auth/scope.js';
import { dragActions, tapActions } from './actions.js';
import { specialKeyToWda } from './keys.js';
import { simGateMessage } from './sim-gate.js';
import type { SessionHandle, SimulatorSessionManager, Viewer } from './session-manager.js';
import { WdaError } from './wda-client.js';
import { clientMessageSchema } from './ws-messages.js';

interface Deps {
  repos: Repositories;
  manager: SimulatorSessionManager;
  log: FastifyBaseLogger;
}

const MAX_BUFFERED = 1024 * 1024;
const BUTTON_NAME: Record<string, string> = { home: 'home', lock: 'lock', volumeUp: 'volumeUp', volumeDown: 'volumeDown' };

export function registerSimulatorWs(router: ReturnType<typeof createUpgradeRouter>, deps: Deps) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const log = deps.log.child({ mod: 'sim-ws' });
  const byTab = new Map<string, Set<WebSocket>>();

  router.add(/^\/ws\/sim\/([a-z0-9]+)\/?$/, async ({ req, socket, head, params, scope, canWrite }) => {
    // ownership: a tab outside the caller's scope is a 404, like a missing one
    const found = await new Scoped(deps.repos, scope).tab(params[0]).catch(() => null);
    if (!found || found.tab.kind !== 'simulator') return rejectUpgrade(socket, 404, 'Not Found');
    const { tab, machine } = found;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      const set = byTab.get(tab.id) ?? new Set<WebSocket>();
      set.add(ws);
      byTab.set(tab.id, set);
      ws.once('close', () => {
        set.delete(ws);
        if (set.size === 0) byTab.delete(tab.id);
      });
      void handleConnection(ws, tab, machine, !canWrite, deps, log);
    });
  });

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

  return {
    wss,
    /** Fecha as conexões abertas da tab (ex.: trocou de aparelho); os clientes reconectam. */
    closeTab(tabId: string) {
      for (const ws of byTab.get(tabId) ?? []) ws.close(4100, 'tab changed');
    },
  };
}

/** What a read-only viewer (no terminals:write, TER-576) may still send: its own stream controls. */
const VIEWER_MESSAGES = new Set(['ping', 'pause', 'resume', 'settings']);

async function handleConnection(
  ws: WebSocket,
  tab: Tab,
  machine: Parameters<SimulatorSessionManager['acquire']>[0],
  readonly: boolean,
  deps: Deps,
  log: FastifyBaseLogger,
) {
  const w = ws as WebSocket & { isAlive?: boolean };
  w.isAlive = true;
  ws.on('pong', () => (w.isAlive = true));
  const send = (msg: object) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  // A read-only viewer is told so before anything else, so the page can disable its controls; the
  // server drops tap, drag, keys, key, button and rotate from it either way. A writer gets nothing.
  if (readonly) send({ type: 'readonly' });

  if (!tab.simulator_udid) {
    send({ type: 'status', state: 'no_device' });
    ws.on('message', (raw, isBinary) => {
      if (!isBinary && String(raw) === '{"type":"ping"}') send({ type: 'pong' });
    });
    return;
  }
  const udid = tab.simulator_udid;

  const gate = simGateMessage(machine);
  if (gate) {
    log.info({ tabId: tab.id, machineId: machine.id }, 'simulador indisponível na máquina');
    send({ type: 'status', state: 'error', message: gate });
    ws.on('message', (raw, isBinary) => {
      if (!isBinary && String(raw) === '{"type":"ping"}') send({ type: 'pong' });
    });
    return;
  }

  // Controle de fluxo: guarda só o último frame; envia quando o buffer do socket tem espaço.
  let paused = false;
  let pending: Buffer | null = null;
  const flush = () => {
    if (!pending || paused || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED) return;
    ws.send(pending, { binary: true });
    pending = null;
  };
  const flushTimer = setInterval(flush, 100);

  const viewer: Viewer = {
    onFrame(frame) {
      pending = frame;
      flush();
    },
    onStatus(s) {
      send({ type: 'status', ...s });
    },
    onScreen(s) {
      send({ type: 'screen', ...s });
    },
  };

  // Registrados ANTES do await: se o socket fechar enquanto `acquire` ainda está em voo, o
  // viewer não pode ficar pendurado no refcount da sessão nem o timer de flush rodando pra sempre.
  let handle: SessionHandle | null = null;
  let closed = false;
  // pause/resume podem chegar do browser antes do `acquire` resolver; guarda a intenção aqui e
  // aplica no handle assim que ele existir (senão o `handle?.setPaused` abaixo é um no-op silencioso
  // e o viewer fica "ativo" — com o stream aberto — mesmo tendo pedido pause).
  let wantPaused = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(flushTimer);
    handle?.release();
    handle = null;
    log.info({ tabId: tab.id }, 'simulador desconectado');
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);

  const toast = (message: string) => send({ type: 'toast', message });
  const run = (p: Promise<unknown>) =>
    p.catch((err) => toast(err instanceof WdaError ? `WDA: ${err.message}` : err instanceof Error ? err.message : 'Comando falhou'));

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const r = clientMessageSchema.safeParse(parsed);
    if (!r.success) return;
    const m = r.data;
    if (readonly && !VIEWER_MESSAGES.has(m.type)) return;
    if (m.type === 'pause') {
      wantPaused = true;
      paused = true;
      handle?.setPaused(true);
      return;
    }
    if (m.type === 'resume') {
      wantPaused = false;
      paused = false;
      handle?.setPaused(false);
      flush();
      return;
    }
    if (!handle) return;
    const h = handle;
    try {
      const { client } = h;
      switch (m.type) {
        case 'ping':
          send({ type: 'pong' });
          return;
        case 'tap':
          void run(client.actions(tapActions(m)));
          return;
        case 'drag':
          void run(client.actions(dragActions(m.points)));
          return;
        case 'keys':
          void run(client.keys([...m.text]));
          return;
        case 'key': {
          const code = specialKeyToWda(m.name);
          if (code) void run(client.keys([code]));
          return;
        }
        case 'button':
          void run(client.pressButton(BUTTON_NAME[m.name]));
          return;
        case 'rotate':
          void run(client.setOrientation(m.orientation).then(() => h.refreshScreen()));
          return;
        case 'settings':
          void run(h.setSettings(m.scale, m.quality));
          return;
      }
    } catch (err) {
      // Seguro barato: uma exceção síncrona aqui (ex.: montar as W3C actions) derrubaria o
      // processo, já que é um listener de evento do `ws` — nunca deixa escapar, vira toast.
      toast(err instanceof WdaError ? `WDA: ${err.message}` : err instanceof Error ? err.message : 'Comando falhou');
    }
  });

  try {
    handle = await deps.manager.acquire(machine, udid, viewer);
  } catch (err) {
    clearInterval(flushTimer);
    log.warn({ tabId: tab.id, machineId: machine.id, udid, err: err instanceof Error ? err.message : err }, 'simulador não subiu');
    // status 'error' já foi enviado pelo manager
    return;
  }
  if (closed) {
    // o socket fechou enquanto esperávamos o acquire: libera o viewer na hora, não espera
    // outro evento que já não vai mais disparar.
    handle.release();
    handle = null;
    return;
  }
  // aplica agora qualquer pause/resume que chegou enquanto o acquire estava em voo (acima os
  // `handle?.setPaused` foram no-op porque `handle` ainda era null).
  handle.setPaused(wantPaused);
  paused = wantPaused;
  log.info({ tabId: tab.id, machineId: machine.id, udid }, 'simulador conectado');
}
