// Shrinks an image before upload (spec §3, "Image size for the model"): the model's per-image budget is
// 5 MB of base64, and a phone photo is 4000 px wide for no reason the concierge could use. The pure
// size math is testable; the canvas part is only ever exercised in a browser.

export const MAX_IMAGE_SIDE = 1568;
export const JPEG_QUALITY = 0.85;

/** The size that fits `max` on the long side without changing the aspect. Never upscales. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max) return { width, height };
  const scale = max / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** JPEG, PNG and WebP are re-encoded; a GIF keeps its animation and is never touched. */
export function isDownscalable(mime: string): boolean {
  return mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/webp';
}

export function jpegName(name: string): string {
  return `${name.replace(/\.[a-z0-9]+$/i, '')}.jpg`;
}

/**
 * The file itself when it is not a bitmap this module handles, when it already fits, or when anything
 * in the browser's decode/encode path fails — an upload must never be lost to a downscale.
 */
export async function downscaleImage(file: File, max = MAX_IMAGE_SIDE): Promise<File> {
  if (!isDownscalable(file.type) || typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return file;
  }
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, max);
    if (width === bitmap.width && height === bitmap.height) return file;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    // JPEG has no alpha: a transparent PNG would otherwise come out black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    if (!blob) return file;
    return new File([blob], jpegName(file.name), { type: 'image/jpeg' });
  } catch {
    return file;
  } finally {
    bitmap.close();
  }
}
