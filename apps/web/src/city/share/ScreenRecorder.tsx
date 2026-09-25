import { useCallback, useEffect, useRef, useState } from 'react';
import type { CityModel } from '../../office/model';
import { screenCrop, type ShareInfo } from './compose';
import { canShareFile, downloadFile, shareOrDownload } from './deliver';
import { fileNameFor, type FrameSource } from './images';
import { baseType, canRecordVideo, extensionFor, instagramReady, recordVideo, RecordingCancelled, SCREEN_VIDEO_MAX_MS, type Recording } from './record';

type State =
  | { kind: 'idle' }
  | { kind: 'recording'; elapsedMs: number }
  | { kind: 'done'; file: File; preview: string; warn: boolean }
  | { kind: 'failed' };

/**
 * The page's "Gravar" button: records the camera's view, 16:9, with the city's sound, from the press
 * until "Parar" (or SCREEN_VIDEO_MAX_MS). The camera stays free — what is recorded is what the
 * visitor does with it — and a hidden tab stops the recording and keeps what was made so far.
 */
export function useScreenRecorder(opts: { scene: () => FrameSource | null; nickname: string; info: () => ShareInfo; model: () => CityModel }) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const recording = useRef<Recording | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const supported = useState(canRecordVideo)[0];

  const start = useCallback(async () => {
    const { nickname, info, model } = optsRef.current;
    const scene = optsRef.current.scene();
    if (!scene || recording.current) return;
    setState({ kind: 'recording', elapsedMs: 0 });
    try {
      const rec = recordVideo({ source: scene, info, model, format: 'screen', durationMs: SCREEN_VIDEO_MAX_MS, onProgress: (elapsedMs) => setState({ kind: 'recording', elapsedMs }) });
      recording.current = rec;
      const { blob, mimeType } = await rec.done;
      const file = new File([blob], fileNameFor(nickname, 'screen', extensionFor(mimeType)), { type: baseType(mimeType) });
      setState({ kind: 'done', file, preview: URL.createObjectURL(file), warn: !instagramReady(mimeType) });
    } catch (err) {
      setState(err instanceof RecordingCancelled ? { kind: 'idle' } : { kind: 'failed' });
    } finally {
      recording.current = null;
    }
  }, []);

  const stop = useCallback(() => recording.current?.finish(), []);
  const dismiss = useCallback(() => setState({ kind: 'idle' }), []);

  useEffect(() => {
    if (state.kind !== 'done') return;
    const url = state.preview;
    return () => URL.revokeObjectURL(url);
  }, [state]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) recording.current?.finish();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      recording.current?.cancel();
    };
  }, []);

  return { state, supported, start, stop, dismiss };
}

export const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** The red frame over the scene while it records: the 16:9 part of the view that goes into the video. */
export function RecordingFrame({ host }: { host: HTMLElement }) {
  const [size, setSize] = useState({ width: host.clientWidth, height: host.clientHeight });
  useEffect(() => {
    const observer = new ResizeObserver(() => setSize({ width: host.clientWidth, height: host.clientHeight }));
    observer.observe(host);
    return () => observer.disconnect();
  }, [host]);
  const r = screenCrop(size.width, size.height);
  return (
    <div aria-hidden="true" className="pointer-events-none absolute z-10 rounded-sm border-2 border-danger shadow-[0_0_0_1px_rgba(248,81,73,0.35)]" style={{ left: r.x, top: r.y, width: r.w, height: r.h }}>
      <span className="absolute left-2 top-2 flex items-center gap-1.5 rounded bg-danger/90 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
        rec
      </span>
    </div>
  );
}

/** What a finished screen recording offers: watch it, share or download it, or let it go. */
export function RecordingResult({ file, preview, warn, onClose }: { file: File; preview: string; warn: boolean; onClose(): void }) {
  return (
    <div role="dialog" aria-label="Gravação da tela" className="space-y-2 rounded-b-xl border border-line bg-bg-2 p-4 shadow-xl sm:rounded-lg">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-fg">Gravação</h2>
        <button type="button" aria-label="Fechar" className="rounded px-2 text-fg-muted hover:text-fg" onClick={onClose}>
          ×
        </button>
      </div>
      <video src={preview} controls playsInline className="w-full rounded bg-black" />
      {warn && <p className="text-xs text-warn">O Instagram pode não aceitar WebM. No celular, use o Safari ou o Chrome.</p>}
      <div className="flex flex-wrap gap-2">
        {canShareFile(file) && (
          <button type="button" className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-white hover:bg-accent-hover" onClick={() => void shareOrDownload(file)}>
            Compartilhar
          </button>
        )}
        <button type="button" className="rounded-md border border-line px-3 py-1.5 text-sm text-fg hover:bg-bg-3" onClick={() => downloadFile(file, file.name)}>
          Baixar
        </button>
        <button type="button" className="rounded-md border border-line px-3 py-1.5 text-sm text-fg hover:bg-bg-3" onClick={onClose}>
          Descartar
        </button>
      </div>
    </div>
  );
}
