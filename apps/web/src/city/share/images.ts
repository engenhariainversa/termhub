/**
 * Stills (spec 2026-09-23 §2.3): one composed frame on an offscreen canvas at the output size, as a
 * PNG. The WebGL scene can only be read right after it renders, so the still is drawn inside the
 * next frame callback — never by reading the scene's canvas later.
 */
import { FORMAT_SIZE, paintCapture, type CaptureFormat, type ShareInfo } from './compose';

/** What the share code needs from the scene: OfficeScene.onFrame. */
export interface FrameSource {
  onFrame(cb: (canvas: HTMLCanvasElement) => void): () => void;
}

export function captureStill(source: FrameSource, format: CaptureFormat, info: ShareInfo, timeoutMs = 2_000): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const size = FORMAT_SIZE[format];
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return reject(new Error('no 2d canvas'));
    let settled = false;
    let off: () => void = () => {};
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      off();
      reject(new Error('no frame from the scene'));
    }, timeoutMs);
    off = source.onFrame((scene) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // unsubscribe outside the render loop that is calling us
      queueMicrotask(() => off());
      try {
        paintCapture(ctx, format, info, scene);
      } catch (err) {
        // a failed draw is an answer too: the panel must not wait on "Preparando a imagem…" forever
        return reject(err instanceof Error ? err : new Error('the frame could not be drawn'));
      }
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('the canvas gave no image'))), 'image/png');
    });
  });
}

export function fileNameFor(nickname: string, kind: CaptureFormat, ext: 'png' | 'mp4' | 'webm'): string {
  return `termhub-cidade-${nickname}-${kind}.${ext}`;
}
