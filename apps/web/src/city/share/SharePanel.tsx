import { useEffect, useRef, useState } from 'react';
import type { CityModel } from '../../office/model';
import type { PublicCity } from '../../lib/types';
import { shareInfoFor, type CaptureFormat } from './compose';
import { CopyLinkButton } from './CopyLinkButton';
import { canShareFile, downloadFile, shareOrDownload } from './deliver';
import { captureStill, fileNameFor, type FrameSource } from './images';
import { baseType, canRecordVideo, extensionFor, instagramReady, recordStory, RecordingCancelled, STORY_VIDEO_MS, type Recording } from './record';

/** What the panel needs from the scene: its frames, and a camera it can hold still. OfficeScene is one. */
export interface ShareScene extends FrameSource {
  lockCamera(locked: boolean): void;
}

type Phase =
  | { kind: 'menu' }
  | { kind: 'busy' }
  | { kind: 'recording'; elapsedMs: number }
  /** `warn`: a video Instagram may refuse (not H.264 + AAC in an MP4) */
  | { kind: 'done'; file: File; preview: string; video: boolean; warn: boolean }
  | { kind: 'stopped'; reason: 'hidden' | 'failed'; video: boolean };

const OPTION = 'w-full rounded-md border border-line bg-bg-3 px-3 py-2 text-left text-sm text-fg hover:bg-bg-4 disabled:cursor-not-allowed disabled:opacity-50';
const ACTION = 'rounded-md border border-line px-3 py-1.5 text-sm text-fg hover:bg-bg-3';
const PRIMARY = 'rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-white hover:bg-accent-hover';

/**
 * Compartilhar (spec 2026-09-23 §2.6): a story image, a post image, a 10-second story video with
 * sound, and the link — all made here, in the visitor's browser, from the scene the page draws.
 */
export function SharePanel({ scene, city, model, cityUrl, copyUrl, onClose }: { scene: ShareScene; city: PublicCity; model: CityModel; cityUrl: string; copyUrl: string; onClose(): void }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'menu' });
  const [videoOk] = useState(canRecordVideo);
  const recording = useRef<Recording | null>(null);
  /** the running recording was stopped because the page was hidden, not by the person */
  const stoppedByHide = useRef(false);
  // the counts and the sounds follow the city while it records, not the city when the button was pressed
  const modelRef = useRef(model);
  useEffect(() => {
    modelRef.current = model;
  }, [model]);
  const info = () => shareInfoFor(city, modelRef.current, cityUrl);

  const dialog = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Esc closes the panel and goes no further: the city's own Esc (walk the camera up, change the
  // address) listens on window, so this listens there too, in the capture phase that runs first
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Esc in a field elsewhere on the page (the beta form) belongs to that field
      const t = e.target as HTMLElement | null;
      const editing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (editing && !dialog.current?.contains(t)) return;
      e.stopPropagation();
      e.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    if (phase.kind !== 'done') return;
    const url = phase.preview;
    return () => URL.revokeObjectURL(url);
  }, [phase]);

  // a hidden tab stops drawing frames, so the video would freeze: stop and say so
  useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden || !recording.current) return;
      stoppedByHide.current = true;
      recording.current.cancel();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // closing the panel mid-recording stops it (and so unlocks the camera); an image still on its way
  // afterwards is dropped, so no preview URL is made that nothing would ever revoke
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      recording.current?.cancel();
    };
  }, []);

  const finish = (blob: Blob, name: string, video: boolean, warn: boolean) => {
    if (!mounted.current) return;
    // the bare type: Chrome's share sheet refuses 'video/mp4;codecs=…' where it takes 'video/mp4'
    const file = new File([blob], name, { type: baseType(blob.type) });
    setPhase({ kind: 'done', file, preview: URL.createObjectURL(file), video, warn });
  };

  const still = async (format: CaptureFormat) => {
    setPhase({ kind: 'busy' });
    try {
      finish(await captureStill(scene, format, info()), fileNameFor(city.nickname, format, 'png'), false, false);
    } catch {
      setPhase({ kind: 'stopped', reason: 'failed', video: false });
    }
  };

  const video = async () => {
    stoppedByHide.current = false;
    setPhase({ kind: 'recording', elapsedMs: 0 });
    scene.lockCamera(true);
    try {
      // inside the try: a recording that throws while starting must still unlock the camera
      const rec = recordStory({ source: scene, info, model: () => modelRef.current, durationMs: STORY_VIDEO_MS, onProgress: (elapsedMs) => setPhase({ kind: 'recording', elapsedMs }) });
      recording.current = rec;
      const { blob, mimeType } = await rec.done;
      finish(blob, fileNameFor(city.nickname, 'story', extensionFor(mimeType)), true, !instagramReady(mimeType));
    } catch (err) {
      if (stoppedByHide.current) setPhase({ kind: 'stopped', reason: 'hidden', video: true });
      else if (err instanceof RecordingCancelled) setPhase({ kind: 'menu' });
      else setPhase({ kind: 'stopped', reason: 'failed', video: true });
    } finally {
      recording.current = null;
      scene.lockCamera(false);
    }
  };

  // the focus moves into the panel when it opens, and stays in it when a phase takes away the button
  // that had it (every phase swaps its buttons): otherwise it would fall back to the page's body
  useEffect(() => {
    const box = dialog.current;
    if (box && !box.contains(document.activeElement)) box.focus();
  }, [phase.kind]);

  const seconds = phase.kind === 'recording' ? Math.floor(phase.elapsedMs / 1000) : 0;
  const total = STORY_VIDEO_MS / 1000;
  const status = phase.kind === 'busy' ? 'Preparando a imagem…' : phase.kind === 'recording' ? `Gravando… ${seconds} s` : '';

  return (
    <div ref={dialog} tabIndex={-1} role="dialog" aria-label="Compartilhar a cidade" className="space-y-3 rounded-b-xl border border-line bg-bg-2 p-4 shadow-xl outline-none sm:rounded-lg">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-fg">Compartilhar</h2>
        <button type="button" aria-label="Fechar" className="rounded px-2 text-fg-muted hover:text-fg" onClick={onClose}>
          ×
        </button>
      </div>

      {phase.kind === 'menu' && (
        <div className="grid gap-2">
          <button type="button" className={OPTION} onClick={() => void still('story')}>
            Story (imagem)
          </button>
          <button type="button" className={OPTION} onClick={() => void still('post')}>
            Post (imagem)
          </button>
          <button type="button" className={OPTION} onClick={() => void still('screen')}>
            Tela 16:9 (imagem)
          </button>
          <button type="button" className={OPTION} disabled={!videoOk} onClick={() => void video()}>
            Vídeo para story (10 s, com som)
          </button>
          {!videoOk && <p className="text-xs text-fg-dim">Seu navegador não grava vídeo; as imagens continuam disponíveis.</p>}
          <CopyLinkButton url={copyUrl} className={OPTION} />
        </div>
      )}

      {/* always in the page, so a screen reader hears each change of it */}
      <p role="status" aria-live="polite" className={status ? `text-sm ${phase.kind === 'recording' ? 'text-fg' : 'text-fg-muted'}` : 'sr-only'}>
        {status}
      </p>

      {phase.kind === 'recording' && (
        <div className="space-y-2">
          <div role="progressbar" aria-label="Progresso da gravação" aria-valuemin={0} aria-valuemax={total} aria-valuenow={seconds} className="h-1.5 overflow-hidden rounded bg-bg-4">
            <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.min(100, (phase.elapsedMs / STORY_VIDEO_MS) * 100)}%` }} />
          </div>
          <p className="text-xs text-fg-dim">A cidade continua ao vivo enquanto grava.</p>
          <button type="button" className={ACTION} onClick={() => recording.current?.cancel()}>
            Cancelar
          </button>
        </div>
      )}

      {phase.kind === 'done' && (
        <div className="space-y-2">
          {phase.video ? (
            <video src={phase.preview} controls playsInline className="max-h-72 w-full rounded bg-black" />
          ) : (
            <img src={phase.preview} alt="Prévia da imagem" className="max-h-72 w-full rounded object-contain" />
          )}
          {phase.warn && <p className="text-xs text-warn">O Instagram pode não aceitar WebM. No celular, use o Safari ou o Chrome.</p>}
          <div className="flex flex-wrap gap-2">
            {canShareFile(phase.file) && (
              <button type="button" className={PRIMARY} onClick={() => void shareOrDownload(phase.file)}>
                Compartilhar
              </button>
            )}
            <button type="button" className={ACTION} onClick={() => downloadFile(phase.file, phase.file.name)}>
              Baixar
            </button>
            {phase.video ? (
              <button type="button" className={ACTION} onClick={() => void video()}>
                Gravar de novo
              </button>
            ) : (
              <button type="button" className={ACTION} onClick={() => setPhase({ kind: 'menu' })}>
                Voltar
              </button>
            )}
          </div>
        </div>
      )}

      {phase.kind === 'stopped' && (
        <div className="space-y-2">
          <p className="text-sm text-fg-muted">
            {phase.reason === 'hidden' ? 'A gravação parou porque a página saiu da tela: o navegador pausa a cidade em segundo plano.' : 'Não foi possível gerar o arquivo.'}
          </p>
          {phase.reason === 'hidden' || phase.video ? (
            <button type="button" className={ACTION} onClick={() => void video()}>
              Gravar de novo
            </button>
          ) : (
            <button type="button" className={ACTION} onClick={() => setPhase({ kind: 'menu' })}>
              Voltar
            </button>
          )}
        </div>
      )}
    </div>
  );
}
