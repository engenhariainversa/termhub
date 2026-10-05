import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { SimulatorConnection, type SimState } from '../lib/simulator-connection';
import type { Screen, Simulator, Tab } from '../lib/types';
import { isAppShortcut } from './Terminal';
import { DropdownMenu, type MenuItem } from './DropdownMenu';

interface Props {
  tab: Tab;
  machineId: string;
  active: boolean;
  /** true when this is the tab that should own keyboard focus right now (the focused cell/floating window) */
  focused?: boolean;
  floating?: boolean;
  onDetach?: (aspect: number) => void;
  onDock?: () => void;
  onTabChange: (tab: Tab) => void;
  onConnected?: () => void;
}

const STATE_LABEL: Record<SimState, string> = {
  connecting: 'Conectando…',
  booting: 'Ligando o simulador…',
  starting: 'Subindo o WebDriverAgent…',
  ready: 'Conectado',
  no_device: 'Escolha um simulador',
  error: 'Erro',
  offline: 'Offline',
  closed: 'Encerrado',
};

const QUALITY = {
  lan: { scale: 50, quality: 50, label: 'LAN' },
  remote: { scale: 25, quality: 30, label: 'Remoto' },
} as const;
type QualityKey = keyof typeof QUALITY;

const SPECIAL_KEYS = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown']);
const TAP_MAX_MS = 200;
const TAP_MAX_PX = 6;
const KEY_BATCH_MS = 50;

/** Seletor de aparelho (usado no estado vazio e na barra). */
function DevicePicker({ machineId, value, onPick }: { machineId: string; value: string | null; onPick: (udid: string) => void }) {
  const [list, setList] = useState<Simulator[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.machines
      .simulators(machineId)
      .then((r) => !cancelled && setList(r.simulators))
      .catch((e) => !cancelled && setError(e instanceof ApiError ? e.message : 'Erro ao listar simuladores'));
    return () => {
      cancelled = true;
    };
  }, [machineId]);
  if (error) return <span className="text-xs text-danger">{error}</span>;
  return (
    <select className="input h-7 max-w-[260px] py-0 text-xs" value={value ?? ''} onChange={(e) => e.target.value && onPick(e.target.value)} disabled={!list}>
      <option value="">{list ? 'Escolha um simulador…' : 'Carregando…'}</option>
      {list?.map((s) => (
        <option key={s.udid} value={s.udid}>
          {s.name} · {s.runtime}
          {s.state === 'Booted' ? ' · ligado' : ''}
        </option>
      ))}
    </select>
  );
}

// `onDock` stays in `Props` for the caller's API (the floating window's own title bar handles
// docking now), but this component no longer renders a docking control, so it's not destructured.
export function SimulatorView({ tab, machineId, active, focused, floating, onDetach, onTabChange, onConnected }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const connRef = useRef<SimulatorConnection | null>(null);
  const screenRef = useRef<Screen | null>(null);
  const [state, setState] = useState<SimState>('connecting');
  const [message, setMessage] = useState<string | undefined>();
  const [tail, setTail] = useState<string[] | undefined>();
  const [screen, setScreen] = useState<Screen | null>(null);
  const [fps, setFps] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [quality, setQuality] = useState<QualityKey>('lan');
  const frameCount = useRef(0);
  const frameSeqRef = useRef(0);
  const paintedSeqRef = useRef(0);
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;
  // Estado desejado de pausa/qualidade: usados como fonte da verdade para reenviar
  // assim que a conexão fica pronta (o `send` é um no-op enquanto o socket não está OPEN).
  const pausedRef = useRef(!(active && document.visibilityState === 'visible'));
  const qualityRef = useRef<QualityKey>('lan');
  // Tapping, typing and the device buttons take terminals:write (TER-576); without it the stream is watch-only.
  // The server drops those messages too; the connection does not even send them.
  const { can } = useAuth();
  const canWrite = can('terminals', 'write');
  const canWriteRef = useRef(canWrite);
  canWriteRef.current = canWrite;

  // Conexão: uma por tab+udid.
  useEffect(() => {
    if (!tab.simulator_udid) {
      setState('no_device');
      return;
    }
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const conn = new SimulatorConnection(tab.id, {
      onFrame: (blob) => {
        frameCount.current += 1;
        const seq = ++frameSeqRef.current;
        void createImageBitmap(blob)
          .then((bmp) => {
            try {
              if (canvas && ctx && seq > paintedSeqRef.current) {
                if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
                  canvas.width = bmp.width;
                  canvas.height = bmp.height;
                }
                ctx.drawImage(bmp, 0, 0);
                paintedSeqRef.current = seq;
              }
            } finally {
              bmp.close();
            }
          })
          .catch(() => {});
      },
      onStatus: (s, m, t) => {
        setState(s);
        setMessage(m);
        setTail(t);
        // Reenvia o estado desejado de pausa a cada status: garante que pause/resume
        // não se perca se tiver sido mandado enquanto o socket ainda estava CONNECTING.
        connRef.current?.send({ type: pausedRef.current ? 'pause' : 'resume' });
        if (s === 'ready') {
          connRef.current?.send({ type: 'settings', scale: QUALITY[qualityRef.current].scale, quality: QUALITY[qualityRef.current].quality });
          onConnectedRef.current?.();
        }
      },
      onScreen: (s) => {
        screenRef.current = s;
        setScreen(s);
      },
      onToast: (m) => setToast(m),
    });
    conn.setWritable(canWriteRef.current);
    connRef.current = conn;
    conn.connect();
    const fpsTimer = setInterval(() => {
      setFps(frameCount.current);
      frameCount.current = 0;
    }, 1000);
    return () => {
      clearInterval(fpsTimer);
      conn.close();
      connRef.current = null;
    };
  }, [tab.id, tab.simulator_udid]);

  useEffect(() => {
    connRef.current?.setWritable(canWrite);
  }, [canWrite]);

  // Aba escondida → pausa o stream. Atualiza o ref (fonte da verdade) e tenta mandar
  // na hora; se o socket ainda não estiver OPEN, o onStatus acima reenvia ao conectar.
  useEffect(() => {
    const update = () => {
      pausedRef.current = !(active && document.visibilityState === 'visible');
      connRef.current?.send({ type: pausedRef.current ? 'pause' : 'resume' });
    };
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, [active]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // Keyboard focus follows the focused cell (or the floating window), not just mounting/activating.
  useEffect(() => {
    if (!focused) return;
    const id = requestAnimationFrame(() => canvasRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [focused]);

  const send = useCallback((msg: Parameters<SimulatorConnection['send']>[0]) => connRef.current?.send(msg), []);

  // Canvas px → pontos lógicos, clampados aos limites da tela (evita swipes de borda
  // terminando fora do dispositivo, o que a WDA rejeita).
  const toPoint = (e: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    const scr = screenRef.current;
    if (!canvas || !scr) return null;
    const r = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(scr.width, ((e.clientX - r.left) / r.width) * scr.width));
    const y = Math.max(0, Math.min(scr.height, ((e.clientY - r.top) / r.height) * scr.height));
    return { x, y };
  };

  // Mouse: tap curto ou drag amostrado.
  const gesture = useRef<{ points: { x: number; y: number; t: number }[]; last: number } | null>(null);
  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || !canWrite) return;
    canvasRef.current?.focus();
    const p = toPoint(e);
    if (!p) return;
    gesture.current = { points: [{ ...p, t: performance.now() }], last: performance.now() };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    const g = gesture.current;
    if (!g) return;
    const now = performance.now();
    if (now - g.last < 16) return;
    const p = toPoint(e);
    if (!p) return;
    g.points.push({ ...p, t: now });
    g.last = now;
  };
  const onMouseUp = (e: React.MouseEvent) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    const p = toPoint(e);
    if (p) g.points.push({ ...p, t: performance.now() });
    const first = g.points[0];
    const last = g.points[g.points.length - 1];
    const dist = Math.hypot(last.x - first.x, last.y - first.y);
    if (last.t - first.t < TAP_MAX_MS && dist < TAP_MAX_PX) send({ type: 'tap', x: first.x, y: first.y });
    else send({ type: 'drag', points: g.points });
  };
  // Roda do mouse: acumula deltaY (clampado) e manda no máximo um `drag` a cada ~100 ms,
  // em vez de um por evento (trackpad dispara dezenas por segundo, com momentum). Listener
  // nativo não-passivo porque o onWheel do React é passivo (preventDefault vira no-op).
  const wheelAccum = useRef(0);
  const wheelPoint = useRef<{ x: number; y: number } | null>(null);
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const flush = () => {
      wheelTimer.current = null;
      const p = wheelPoint.current;
      const dy = wheelAccum.current;
      wheelAccum.current = 0;
      if (!p || dy === 0) return;
      const t = performance.now();
      send({ type: 'drag', points: [{ x: p.x, y: p.y, t }, { x: p.x, y: p.y + dy / 2, t: t + 40 }, { x: p.x, y: p.y + dy, t: t + 80 }] });
    };
    const handler = (e: WheelEvent) => {
      if (!canWriteRef.current) return;
      e.preventDefault();
      const p = toPoint(e);
      if (!p) return;
      wheelPoint.current = p;
      wheelAccum.current = Math.max(-400, Math.min(400, wheelAccum.current - e.deltaY));
      if (!wheelTimer.current) wheelTimer.current = setTimeout(flush, 100);
    };
    canvas.addEventListener('wheel', handler, { passive: false });
    return () => {
      canvas.removeEventListener('wheel', handler);
      if (wheelTimer.current) {
        clearTimeout(wheelTimer.current);
        wheelTimer.current = null;
      }
    };
  }, [tab.id, tab.simulator_udid, send]);

  // Teclado: caracteres em lote, especiais na hora.
  const keyBatch = useRef('');
  const keyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushKeys = useCallback(() => {
    keyTimer.current = null;
    if (keyBatch.current) send({ type: 'keys', text: keyBatch.current });
    keyBatch.current = '';
  }, [send]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!canWrite) return;
    if (isAppShortcut(e.nativeEvent)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (SPECIAL_KEYS.has(e.key)) {
      e.preventDefault();
      flushKeys();
      send({ type: 'key', name: e.key });
      return;
    }
    if (e.key.length === 1) {
      e.preventDefault();
      keyBatch.current += e.key;
      if (!keyTimer.current) keyTimer.current = setTimeout(flushKeys, KEY_BATCH_MS);
    }
  };

  const pickDevice = async (udid: string) => {
    try {
      const { tab: updated } = await api.tabs.update(tab.id, { simulator_udid: udid });
      onTabChange(updated);
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : 'Erro ao trocar de simulador');
    }
  };

  const changeQuality = (q: QualityKey) => {
    setQuality(q);
    qualityRef.current = q;
    send({ type: 'settings', scale: QUALITY[q].scale, quality: QUALITY[q].quality });
  };

  const ready = state === 'ready';
  const portrait = !screen || screen.orientation === 'portrait';
  const aspect = screen ? `${screen.width} / ${screen.height}` : portrait ? '9 / 19.5' : '19.5 / 9';

  const menuItems: MenuItem[] = [
    { kind: 'item', label: 'Home', disabled: !ready || !canWrite, onSelect: () => send({ type: 'button', name: 'home' }) },
    { kind: 'item', label: 'Bloquear', disabled: !ready || !canWrite, onSelect: () => send({ type: 'button', name: 'lock' }) },
    { kind: 'item', label: 'Girar', disabled: !ready || !canWrite, onSelect: () => send({ type: 'rotate', orientation: portrait ? 'landscape' : 'portrait' }) },
    { kind: 'item', label: 'Screenshot', href: api.tabs.screenshotUrl(tab.id), download: true, disabled: !ready, onSelect: () => {} },
    { kind: 'separator' },
    { kind: 'heading', label: 'Qualidade' },
    { kind: 'radio', label: QUALITY.lan.label, checked: quality === 'lan', onSelect: () => changeQuality('lan') },
    { kind: 'radio', label: QUALITY.remote.label, checked: quality === 'remote', onSelect: () => changeQuality('remote') },
    ...(floating
      ? []
      : ([
          { kind: 'separator' },
          { kind: 'item', label: 'Destacar', onSelect: () => onDetach?.(screen ? screen.width / screen.height : 9 / 19.5) },
        ] satisfies MenuItem[])),
  ];

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 overflow-visible border-b border-line bg-bg-2 px-2 text-xs">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          {tab.simulator_udid && <DevicePicker machineId={machineId} value={tab.simulator_udid} onPick={(u) => void pickDevice(u)} />}
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${ready ? 'bg-ok' : state === 'error' || state === 'offline' ? 'bg-danger' : 'bg-warn'}`} />
          <span className="min-w-0 truncate text-fg-muted">{STATE_LABEL[state]}</span>
          {ready && <span className="shrink-0 whitespace-nowrap text-fg-dim">{fps} fps</span>}
          {!canWrite && (
            <span className="shrink-0 whitespace-nowrap rounded bg-bg-3 px-1.5 py-px text-[11px] font-medium text-fg-muted" title="Você pode acompanhar este simulador, mas não tocar nem digitar nele: seu papel não tem permissão de escrita em terminais.">
              Somente leitura
            </span>
          )}
        </div>
        <span className="flex shrink-0 items-center gap-1">
          {(state === 'error' || state === 'offline' || state === 'closed') && (
            <button className="btn-primary px-2 py-0.5" onClick={() => connRef.current?.retryNow()}>
              Reconectar
            </button>
          )}
          <DropdownMenu title="Ações" items={menuItems} />
        </span>
      </div>
      {toast && <div className="border-b border-warn/30 bg-warn/10 px-3 py-1 text-xs text-warn">{toast}</div>}
      <div ref={wrapRef} className="relative flex min-h-0 flex-1 items-center justify-center bg-black p-3">
        {!tab.simulator_udid ? (
          <div className="flex flex-col items-center gap-2 text-sm text-fg-muted">
            <p>Esta aba ainda não tem um simulador.</p>
            <DevicePicker machineId={machineId} value={null} onPick={(u) => void pickDevice(u)} />
          </div>
        ) : (
          <>
            <canvas
              ref={canvasRef}
              tabIndex={0}
              className="max-h-full max-w-full rounded-lg outline-none ring-accent focus:ring-1"
              style={{ aspectRatio: aspect, height: portrait ? '100%' : undefined, width: portrait ? undefined : '100%' }}
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
              onMouseLeave={onMouseUp}
              onKeyDown={onKeyDown}
              onContextMenu={(e) => e.preventDefault()}
            />
            {!ready && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 text-sm text-fg-muted">
                <p>{state === 'error' && message === 'Agente desconectado' ? 'Agente desconectado' : STATE_LABEL[state]}</p>
                {message && message !== 'Agente desconectado' && <p className="text-xs text-danger">{message}</p>}
                {tail && tail.length > 0 && (
                  <pre className="max-h-48 max-w-[90%] overflow-auto rounded bg-bg-2 p-2 text-[10px] text-fg-dim">{tail.join('\n')}</pre>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
