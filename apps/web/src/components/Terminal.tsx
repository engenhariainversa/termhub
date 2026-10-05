import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { TerminalConnection, type ConnectionState } from '../lib/terminal-connection';
import { wheelLines } from '../lib/wheel-lines';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { MAX_RECORDING_MS, VoiceRecorder, canRecordVoice, micErrorMessage, resumeTranscription, transcribeClip, type Clip, type TranscribePhase } from '../lib/voice-recorder';
import { voiceStore } from '../lib/voice-store';
import { i18n, tk, useTranslation } from '../i18n';

interface Props {
  tabId: string;
  active: boolean;
  /** true when this is the tab that should own keyboard focus right now (the focused cell/floating window) */
  focused?: boolean;
  onConnected?: () => void;
  onExit?: () => void;
}

const THEME = {
  background: '#0f1115',
  foreground: '#e6e8ee',
  cursor: '#e6e8ee',
  cursorAccent: '#0f1115',
  selectionBackground: 'rgba(79,140,255,0.35)',
  black: '#1e222b',
  red: '#f85149',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#6e7681',
  brightRed: '#ff7b72',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#f0f6fc',
};

/** pt-BR keys, shown with `t(STATE_LABEL[state])`. */
const STATE_LABEL: Record<ConnectionState, string> = {
  connecting: tk('Conectando…'),
  connected: tk('Conectado'),
  reconnecting: tk('Reconectando…'),
  offline: tk('Offline'),
  closed: tk('Sessão encerrada'),
};

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
/** Modificador que força a seleção do xterm quando o app está usando o mouse. */
const SELECT_MODIFIER = IS_MAC ? '⌥' : 'Shift';
const VOICE_SHORTCUT = IS_MAC ? '⌘⇧M' : 'Ctrl+Shift+M';

/** Voice input: off (server has no whisper / browser can't record), idle, recording a clip, sending it, waiting for the text. */
type VoiceState = 'off' | 'idle' | 'recording' | 'uploading' | 'transcribing';
/** A clip that has not been turned into text yet (upload failed, or the page was refreshed mid-way). */
interface PendingClip extends Clip {
  /** server job accepted before the refresh, if any */
  jobId?: string;
}
/** Below this size (~0.3 s of opus) there is nothing to transcribe. */
const MIN_CLIP_BYTES = 2048;
type NoticeTone = 'info' | 'ok' | 'danger';

/** Whether the server transcribes audio — asked once per page load, shared by every terminal. */
let voiceEnabled: Promise<boolean> | null = null;
function isVoiceEnabled(): Promise<boolean> {
  if (!canRecordVoice()) return Promise.resolve(false);
  voiceEnabled ??= api.transcriptions
    .config()
    .then((c) => c.enabled)
    .catch(() => false);
  return voiceEnabled;
}

/** Ctrl/Cmd+Shift+M starts or stops dictation in the focused terminal. */
function isVoiceShortcut(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && (e.key === 'M' || e.key === 'm');
}

function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function MicIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M12 17v4M8 21h8" />
    </svg>
  );
}

function formatBytes(n: number): string {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** Files carried by a paste or drop (screenshot on the clipboard, files copied in Finder, dragged files). */
function filesFromTransfer(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = Array.from(data.files ?? []);
  if (files.length) return files;
  const out: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue;
    const f = item.getAsFile();
    if (f) out.push(f);
  }
  return out;
}

function hasFiles(data: DataTransfer | null): boolean {
  return !!data && Array.from(data.types ?? []).includes('Files');
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Atalhos globais que o xterm NÃO deve capturar (deixa subir para o app). */
export function isAppShortcut(e: KeyboardEvent): boolean {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod || e.altKey) return false;
  if (e.metaKey && (e.key === 't' || e.key === 'w')) return true;
  if (e.metaKey && /^[1-9]$/.test(e.key)) return true;
  // ctrl+shift+t / ctrl+shift+w como alternativa quando o navegador captura cmd+t/cmd+w
  if (e.ctrlKey && e.shiftKey && (e.key === 'T' || e.key === 'W')) return true;
  return false;
}

export function TerminalView({ tabId, active, focused, onConnected, onExit }: Props) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const connRef = useRef<TerminalConnection | null>(null);
  const [state, setState] = useState<ConnectionState>('connecting');
  const [attempt, setAttempt] = useState(0);
  /** o app em foco ligou o mouse tracking (cliques/arrasto vão para ele) */
  const [mouseApp, setMouseApp] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef(0);
  /** aviso do upload de imagem colada / ditado: texto + tom */
  const [notice, setNotice] = useState<{ text: string; tone: NoticeTone } | null>(null);
  const noticeTimer = useRef(0);
  const showNotice = useCallback((text: string, tone: NoticeTone, ms?: number) => {
    window.clearTimeout(noticeTimer.current);
    setNotice({ text, tone });
    if (ms) noticeTimer.current = window.setTimeout(() => setNotice(null), ms);
  }, []);
  const [voice, setVoiceState] = useState<VoiceState>('off');
  /** mirrors `voice` for the closures (key handler, recorder callbacks) */
  const voiceRef = useRef<VoiceState>('off');
  const setVoice = useCallback((v: VoiceState) => {
    voiceRef.current = v;
    setVoiceState(v);
  }, []);
  const toggleVoiceRef = useRef<() => void>(() => {});
  /** seconds recorded so far (shown in the pill) */
  const [recorded, setRecorded] = useState(0);
  /** upload/transcription progress for the pill */
  const [phase, setPhase] = useState<TranscribePhase | null>(null);
  /** clip waiting for the user's decision after a failure or a refresh */
  const [pending, setPending] = useState<PendingClip | null>(null);
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const clockTimer = useRef(0);
  /** a file drag is hovering the terminal */
  const [dragging, setDragging] = useState(false);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;
  const activeRef = useRef(active);
  activeRef.current = active;
  // Typing into a terminal takes terminals:write (TER-576); without it the terminal is watch-only.
  // The server enforces it too (and says so in `ready`); `serverReadonly` mirrors that answer.
  const { can } = useAuth();
  const canWrite = can('terminals', 'write');
  const [serverReadonly, setServerReadonly] = useState(false);
  const readonly = !canWrite || serverReadonly;
  /** mirrors `readonly` for the closures of the terminal effect, which only re-runs per tab */
  const readonlyRef = useRef(readonly);
  readonlyRef.current = readonly;
  const canWriteRef = useRef(canWrite);
  canWriteRef.current = canWrite;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setServerReadonly(false); // a new tab: its own `ready` will tell

    const term = new XTerm({
      theme: THEME,
      fontFamily: '"JetBrains Mono", Menlo, Monaco, "SF Mono", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      // Apps que ligam mouse tracking (claude, vim, htop...) recebem o arrasto; ⌥ no Mac (Shift no resto) força a seleção do xterm.
      macOptionClickForcesSelection: true,
      disableStdin: readonlyRef.current,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      /* fallback para renderer DOM/canvas */
    }
    term.attachCustomKeyEventHandler((e) => {
      if (isVoiceShortcut(e)) {
        if (e.type === 'keydown' && !readonlyRef.current) toggleVoiceRef.current();
        return false;
      }
      return !isAppShortcut(e);
    });

    // Cópia automática: ao soltar o mouse com texto selecionado. Escuta no window porque o arrasto pode
    // terminar fora do terminal; só copia se a seleção mudou desde o último mouseup (evita recopiar uma
    // seleção antiga em cliques fora do terminal) e se esta é a tab ativa.
    let selectionDirty = false;
    const selSub = term.onSelectionChange(() => {
      selectionDirty = true;
    });
    const copySelection = () => {
      if (!activeRef.current || !selectionDirty) return;
      selectionDirty = false;
      const text = term.getSelection();
      if (!text) return;
      void copyToClipboard(text).then((ok) => {
        if (!ok) return;
        setCopied(true);
        window.clearTimeout(copiedTimer.current);
        copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
      });
    };
    window.addEventListener('mouseup', copySelection);

    // Cmd+V com imagem: envia para a máquina da tab e cola o caminho no terminal (o Claude Code lê o arquivo).
    // Uploads files (paste or drop) to the tab's machine one by one and pastes their paths into the prompt.
    let uploading = false;
    const attachFiles = async (files: File[]) => {
      if (uploading || files.length === 0 || readonlyRef.current) return;
      uploading = true;
      const total = files.reduce((n, f) => n + f.size, 0);
      const what = files.length === 1 ? files[0].name || i18n.t('arquivo') : i18n.t('{{count}} arquivos', { count: files.length });
      showNotice(i18n.t('Enviando {{what}}… {{size}}', { what, size: formatBytes(total) }), 'info');
      const paths: string[] = [];
      try {
        for (const f of files) {
          const r = await api.tabs.pasteFile(tabId, f, f.name || undefined);
          paths.push(r.path);
        }
        term.paste(`${paths.join(' ')} `);
        showNotice(i18n.t('{{count}} arquivos anexados', { count: files.length }), 'ok', 2500);
      } catch (err) {
        if (paths.length) term.paste(`${paths.join(' ')} `); // keep what did go through
        showNotice(err instanceof ApiError ? err.message : i18n.t('Falha ao enviar o arquivo'), 'danger', 5000);
      } finally {
        uploading = false;
      }
    };

    const onPaste = (e: ClipboardEvent) => {
      if (readonlyRef.current) return; // nothing to attach to: xterm's own paste is dropped with stdin off
      const files = filesFromTransfer(e.clipboardData);
      if (files.length === 0) return; // plain text: xterm pastes it
      e.preventDefault();
      e.stopPropagation();
      void attachFiles(files);
    };
    // capture: runs before xterm's own paste listener (on its inner textarea)
    el.addEventListener('paste', onPaste, true);

    // Drag and drop: highlight while a file drag hovers the terminal; drop uploads.
    let dragDepth = 0;
    const onDragEnter = (e: DragEvent) => {
      if (readonlyRef.current || !hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      dragDepth += 1;
      setDragging(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (readonlyRef.current || !hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      dragDepth = 0;
      setDragging(false);
      if (readonlyRef.current) return;
      const files = filesFromTransfer(e.dataTransfer);
      if (files.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      term.focus();
      void attachFiles(files);
    };
    el.addEventListener('dragenter', onDragEnter);
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('dragleave', onDragLeave);
    el.addEventListener('drop', onDrop);

    // Detecta quando o app liga/desliga o mouse tracking (DECSET/DECRST ?1000/?1002/?1003) para mostrar a dica.
    const syncMouseMode = () => setMouseApp(term.modes.mouseTrackingMode !== 'none');
    const onPrivateMode = (params: (number | number[])[]) => {
      if (params.some((p) => p === 1000 || p === 1002 || p === 1003)) queueMicrotask(syncMouseMode);
      return false; // deixa o xterm processar normalmente
    };
    const modeSubs = [
      term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, onPrivateMode),
      term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, onPrivateMode),
    ];
    const safeFit = () => {
      if (el.offsetWidth === 0 || el.offsetHeight === 0) return;
      try {
        fit.fit();
      } catch {
        /* terminal ainda sem renderer (ex.: container oculto) */
      }
    };
    safeFit();

    termRef.current = term;
    fitRef.current = fit;

    let lastError: string | null = null;
    const conn = new TerminalConnection(tabId, {
      onData: (data) => term.write(data),
      onState: (s, a) => {
        setState(s);
        setAttempt(a);
        if (s === 'connected') {
          // the failure notice is ours to clear; any other notice stays
          if (lastError) setNotice(null);
          lastError = null;
          onConnectedRef.current?.();
        }
        // gave up: the reason again, in case another notice replaced it meanwhile
        if (s === 'offline' && lastError) showNotice(lastError, 'danger');
      },
      onError: (message) => {
        // shown from the first failure and kept through the retries, not only once they give up
        lastError = message;
        showNotice(message, 'danger');
      },
      onExit: () => onExitRef.current?.(),
      onReadonly: (r) => setServerReadonly(r),
    });
    conn.setWritable(canWriteRef.current);
    connRef.current = conn;
    // the tab on screen goes ahead of the hidden ones in the handshake queue (TER-902)
    conn.setPriority(!!activeRef.current);
    conn.connect({ cols: term.cols, rows: term.rows });

    const dataSub = term.onData((d) => conn.send(d));
    const resizeSub = term.onResize(({ cols, rows }) => conn.sendResize(cols, rows));

    // Mouse wheel (TER-465): tmux keeps xterm.js in the alternate buffer with no scrollback, where xterm.js
    // turns the wheel into Up/Down — a shell's or Codex's prompt history. When the server can, the wheel
    // scrolls the tmux pane instead (copy-mode). An app that turned mouse tracking on (Claude, vim with
    // mouse) still gets the wheel from xterm.js, and so does an older server or agent (no `canScroll`).
    let wheelCarry = 0;
    let wheelPending = 0;
    let wheelRaf = 0;
    term.attachCustomWheelEventHandler((e) => {
      if (!conn.canScroll || conn.readonly || term.modes.mouseTrackingMode !== 'none' || term.buffer.active.type !== 'alternate') return true;
      e.preventDefault();
      const screen = el.querySelector<HTMLElement>('.xterm-screen');
      const cellHeight = screen && term.rows ? screen.clientHeight / term.rows : 0;
      const r = wheelLines(e, wheelCarry, { cellHeight, rows: term.rows });
      wheelCarry = r.carry;
      wheelPending += r.lines;
      // one message per animation frame, however many wheel events came in
      if (wheelPending !== 0 && !wheelRaf) {
        wheelRaf = requestAnimationFrame(() => {
          wheelRaf = 0;
          const lines = wheelPending;
          wheelPending = 0;
          conn.sendScroll(lines);
        });
      }
      return false;
    });

    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(safeFit);
    });
    ro.observe(el);

    const onOnline = () => conn.retryNow();
    window.addEventListener('online', onOnline);

    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('mouseup', copySelection);
      selSub.dispose();
      el.removeEventListener('paste', onPaste, true);
      el.removeEventListener('dragenter', onDragEnter);
      el.removeEventListener('dragover', onDragOver);
      el.removeEventListener('dragleave', onDragLeave);
      el.removeEventListener('drop', onDrop);
      window.clearTimeout(noticeTimer.current);
      for (const sub of modeSubs) sub.dispose();
      window.clearTimeout(copiedTimer.current);
      ro.disconnect();
      cancelAnimationFrame(raf);
      cancelAnimationFrame(wheelRaf);
      dataSub.dispose();
      resizeSub.dispose();
      conn.close();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      connRef.current = null;
    };
  }, [tabId, showNotice]);

  // Read-only follows the role (and the server's answer) without rebuilding the terminal.
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.disableStdin = !canWrite || serverReadonly;
    connRef.current?.setWritable(canWrite);
  }, [canWrite, serverReadonly, tabId]);

  // ── Voice input: record a clip, send it to the server for transcription, paste the text at the prompt ──
  useEffect(() => {
    let alive = true;
    void isVoiceEnabled().then((ok) => {
      if (alive && ok && voiceRef.current === 'off') setVoice('idle');
    });
    return () => {
      alive = false;
    };
  }, [setVoice]);

  const stopClock = () => {
    window.clearInterval(clockTimer.current);
    clockTimer.current = 0;
  };

  /** Pastes the text at the prompt, submits it with Enter and forgets the stored clip. */
  const deliver = useCallback(
    (text: string) => {
      const term = termRef.current;
      if (!term) return;
      if (text) {
        term.paste(text);
        // Enter goes as a separate write after the (possibly bracketed) paste so the app takes it as submit, not as pasted text
        window.setTimeout(() => connRef.current?.send('\r'), 80);
        showNotice(i18n.t('Texto ditado enviado'), 'ok', 2500);
      } else {
        showNotice(i18n.t('Nenhuma fala reconhecida'), 'info', 3000);
      }
      term.focus();
      void voiceStore.clear(tabId);
    },
    [showNotice, tabId],
  );

  /**
   * Uploads and waits for a clip (or resumes its job after a refresh). On failure the clip stays
   * in IndexedDB and is offered back as `pending`, so nothing recorded is lost.
   */
  const runTranscription = useCallback(
    async (clip: PendingClip) => {
      setPending(null);
      setVoice(clip.jobId ? 'transcribing' : 'uploading');
      setPhase(clip.jobId ? { phase: 'transcribing', eta: null, progress: 0 } : { phase: 'uploading', fraction: 0 });
      const onPhase = (p: TranscribePhase) => {
        setPhase(p);
        setVoice(p.phase);
      };
      try {
        let result = clip.jobId ? await resumeTranscription(clip.jobId, onPhase) : null;
        if (!result) {
          // no job yet, or the server forgot it (restart/deploy): send the audio (again)
          await voiceStore.update(tabId, { jobId: undefined });
          result = await transcribeClip(tabId, clip, onPhase);
        }
        deliver(result.text ?? '');
      } catch (err) {
        showNotice(err instanceof Error ? err.message : i18n.t('Falha ao transcrever o áudio'), 'danger', 6000);
        setPending({ audio: clip.audio, seconds: clip.seconds });
      } finally {
        setPhase(null);
        setVoice('idle');
      }
    },
    [deliver, setVoice, showNotice, tabId],
  );

  const stopVoice = useCallback(async () => {
    const rec = recorderRef.current;
    if (!rec || voiceRef.current !== 'recording') return;
    stopClock();
    setVoice('uploading');
    setPhase({ phase: 'uploading', fraction: 0 });
    recorderRef.current = null;
    const clip = await rec.stop();
    if (clip.audio.size < MIN_CLIP_BYTES) {
      showNotice(i18n.t('Gravação muito curta'), 'info', 2500);
      void voiceStore.clear(tabId);
      setVoice('idle');
      return;
    }
    await runTranscription(clip);
  }, [runTranscription, setVoice, showNotice, tabId]);

  const startVoice = useCallback(async () => {
    if (voiceRef.current !== 'idle') return;
    setPending(null);
    const rec = new VoiceRecorder(tabId, { onAutoStop: () => void stopVoice() });
    recorderRef.current = rec;
    voiceRef.current = 'recording'; // block a second start while the mic prompt is open
    try {
      await rec.start();
    } catch (err) {
      recorderRef.current = null;
      voiceRef.current = 'idle';
      showNotice(micErrorMessage(err), 'danger', 5000);
      return;
    }
    setVoice('recording');
    setRecorded(0);
    const startedAt = Date.now();
    stopClock();
    clockTimer.current = window.setInterval(() => setRecorded(Math.floor((Date.now() - startedAt) / 1000)), 500);
    showNotice(i18n.t('Gravando… fale e clique em Parar ({{shortcut}})', { shortcut: VOICE_SHORTCUT }), 'info');
  }, [setVoice, showNotice, stopVoice, tabId]);

  const cancelVoice = useCallback(() => {
    recorderRef.current?.cancel();
    recorderRef.current = null;
    stopClock();
    setVoice('idle');
    showNotice(i18n.t('Gravação descartada'), 'info', 2000);
    termRef.current?.focus();
  }, [setVoice, showNotice]);

  const discardPending = useCallback(() => {
    setPending(null);
    void voiceStore.clear(tabId);
    termRef.current?.focus();
  }, [tabId]);

  toggleVoiceRef.current = () => {
    if (voiceRef.current === 'idle') void startVoice();
    else if (voiceRef.current === 'recording') void stopVoice();
  };

  // Page opened with a clip left behind (refresh while recording/transcribing): resume its job, or offer it back.
  useEffect(() => {
    let alive = true;
    void voiceStore.load(tabId).then((stored) => {
      if (!alive || !stored) return;
      if (stored.audio.size < MIN_CLIP_BYTES) {
        void voiceStore.clear(tabId);
        return;
      }
      const clip: PendingClip = { audio: stored.audio, seconds: stored.clip.seconds, jobId: stored.clip.jobId };
      if (clip.jobId) void runTranscription(clip); // the upload already went through: just wait for the text
      else setPending(clip);
    });
    return () => {
      alive = false;
    };
    // runs once per tab: the recovery decision belongs to the mount, not to callback identity
  }, [tabId]);

  // Refresh/close while recording or transcribing: the browser asks first (the clip is in IndexedDB anyway).
  useEffect(() => {
    if (voice !== 'recording' && voice !== 'uploading' && voice !== 'transcribing') return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [voice]);

  // Unmount while recording (tab closed or the layout remounted it): free the mic but keep the audio
  // in IndexedDB, so the next mount of this tab offers it back.
  useEffect(
    () => () => {
      recorderRef.current?.cancel(true);
      recorderRef.current = null;
      stopClock();
    },
    [],
  );

  // Ao ativar a tab: reajusta tamanho (não mexe no foco do teclado — isso é o `focused` abaixo,
  // senão a última tab montada rouba o foco de quem está de fato na célula focada).
  useEffect(() => {
    connRef.current?.setPriority(!!active);
    if (!active) return;
    const id = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        /* container oculto */
      }
    });
    return () => cancelAnimationFrame(id);
  }, [active]);

  // Foco do teclado segue a célula focada (ou a janela flutuante), não a simples transição
  // active=false→true de toda tab montada.
  useEffect(() => {
    if (!focused) return;
    const id = requestAnimationFrame(() => termRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [focused]);

  const badge =
    state === 'connected'
      ? 'bg-ok/15 text-ok'
      : state === 'offline' || state === 'closed'
        ? 'bg-danger/15 text-danger'
        : 'bg-warn/15 text-warn';

  return (
    <div className="absolute inset-0 flex flex-col">
      <div ref={containerRef} className="relative min-h-0 flex-1 bg-bg" onClick={() => termRef.current?.focus()}>
        {dragging && !readonly && (
          <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-md border-2 border-dashed border-accent bg-accent/10 text-sm font-medium text-fg">
            {t('Solte para anexar ao terminal')}
          </div>
        )}
        {/* Dictation: floats over the terminal (bottom right, clear of the scrollbar); expands into a pill while busy. */}
        {voice !== 'off' && !readonly && (
          <div className="absolute bottom-3 right-5 z-10 flex items-center gap-2 text-[11px]" onMouseDown={(e) => e.preventDefault()}>
            {voice === 'idle' && pending && (
              <div className="flex h-8 items-center gap-2 rounded-full border border-warn/50 bg-bg-2/95 pl-3 pr-1 shadow-lg backdrop-blur">
                <span className="text-fg">{t('Gravação de {{duration}} não transcrita', { duration: formatClock(Math.round(pending.seconds)) })}</span>
                <button className="rounded-full bg-accent px-2.5 py-1 font-medium text-white hover:bg-accent-hover" onClick={() => void runTranscription(pending)}>
                  {t('Transcrever')}
                </button>
                <button className="rounded-full px-2 py-1 text-fg-muted hover:bg-bg-3 hover:text-fg" onClick={discardPending}>
                  {t('Descartar')}
                </button>
              </div>
            )}
            {voice === 'idle' && (
              <button
                className="flex h-8 w-8 items-center justify-center rounded-full border border-line bg-bg-2/90 text-fg-muted shadow-lg backdrop-blur hover:border-accent hover:bg-bg-3 hover:text-fg"
                title={t('Ditar: grava até {{minutes}} minutos e cola o texto no terminal ({{shortcut}})', { minutes: MAX_RECORDING_MS / 60000, shortcut: VOICE_SHORTCUT })}
                aria-label={t('Ditar')}
                onClick={() => void startVoice()}
              >
                <MicIcon size={14} />
              </button>
            )}
            {voice === 'recording' && (
              <div className="flex h-8 items-center gap-2 rounded-full border border-danger/40 bg-bg-2/95 pl-3 pr-1 shadow-lg backdrop-blur">
                <span className="h-2 w-2 animate-pulse rounded-full bg-danger" aria-hidden="true" />
                <span className="font-mono text-fg">
                  {formatClock(recorded)} / {formatClock(MAX_RECORDING_MS / 1000)}
                </span>
                <button className="rounded-full bg-accent px-2.5 py-1 font-medium text-white hover:bg-accent-hover" onClick={() => void stopVoice()}>
                  {t('Parar')}
                </button>
                <button className="rounded-full px-2 py-1 text-fg-muted hover:bg-bg-3 hover:text-fg" onClick={cancelVoice}>
                  {t('Cancelar')}
                </button>
              </div>
            )}
            {(voice === 'uploading' || voice === 'transcribing') && (
              <div className="relative flex h-8 items-center gap-2 overflow-hidden rounded-full border border-line bg-bg-2/95 px-3 text-fg-muted shadow-lg backdrop-blur">
                {/* progress fill behind the label: upload percentage, then the server's time estimate */}
                <span
                  className="absolute inset-y-0 left-0 bg-accent/20 transition-[width] duration-500 ease-linear"
                  style={{ width: `${Math.round((phase?.phase === 'uploading' ? phase.fraction : phase?.phase === 'transcribing' ? phase.progress : 0) * 100)}%` }}
                  aria-hidden="true"
                />
                <span className="relative h-2 w-2 animate-pulse rounded-full bg-accent" aria-hidden="true" />
                <span className="relative text-fg">
                  {phase?.phase === 'uploading'
                    ? t('Enviando áudio… {{percent}}%', { percent: Math.round(phase.fraction * 100) })
                    : phase?.phase === 'transcribing' && phase.eta !== null
                      ? phase.eta > 0
                        ? t('Transcrevendo… ~{{seconds}} s', { seconds: phase.eta })
                        : t('Transcrevendo… quase lá')
                      : t('Transcrevendo…')}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="flex h-6 shrink-0 items-center gap-2 border-t border-line bg-bg-2 px-2 text-[11px] text-fg-dim">
        <span className={`rounded px-1.5 py-px font-medium ${badge}`}>
          {t(STATE_LABEL[state])}
          {state === 'reconnecting' && attempt > 0 ? ` (${attempt})` : ''}
        </span>
        {readonly && (
          <span className="rounded bg-bg-3 px-1.5 py-px font-medium text-fg-muted" title="Você pode acompanhar este terminal, mas não digitar nele: seu papel não tem permissão de escrita em terminais.">
            Somente leitura
          </span>
        )}
        {(state === 'offline' || state === 'closed') && (
          <button className="text-accent hover:underline" onClick={() => connRef.current?.retryNow()}>
            {t('Reconectar')}
          </button>
        )}
        {notice ? (
          <span className={notice.tone === 'ok' ? 'text-ok' : notice.tone === 'danger' ? 'text-danger' : 'text-fg-muted'}>{notice.text}</span>
        ) : copied ? (
          <span className="text-ok">{t('Copiado')}</span>
        ) : mouseApp ? (
          <span title={t('O programa em execução está usando o mouse. Segure {{key}} ao arrastar para selecionar texto; a seleção é copiada ao soltar.', { key: SELECT_MODIFIER })}>
            {t('app usa o mouse · {{key}} + arrastar seleciona', { key: SELECT_MODIFIER })}
          </span>
        ) : null}
        {/* i18n-ignore */}
        <span className="ml-auto font-mono">tmux</span>
      </div>
    </div>
  );
}
