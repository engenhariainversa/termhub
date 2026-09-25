/**
 * The share compositor (spec 2026-09-23 §2.2): one frame of a story (1080×1920) or a post
 * (1920×1080) — a header, the live scene and a footer with the link and the beta invitation. The
 * layout is pure (rectangles and strings, no DOM), so it is tested as numbers; `drawFrame` only
 * paints what the layout decided. Part of the public bundle: it imports only the office model and
 * the public types.
 */
import type { CityModel } from '../../office/model';
import type { PublicCity } from '../../lib/types';

export type ShareFormat = 'story' | 'post';
/** What a still or a video can be: a composed story or post, or `screen` — the camera's view, 16:9, nothing added. */
export type CaptureFormat = ShareFormat | 'screen';

export const FORMAT_SIZE: Record<CaptureFormat, { width: number; height: number }> = {
  story: { width: 1080, height: 1920 },
  post: { width: 1920, height: 1080 },
  screen: { width: 1920, height: 1080 },
};

export const SCREEN_ASPECT = 16 / 9;

/**
 * The part of a `width`×`height` view a 16:9 capture keeps: the largest centred 16:9 box, so the
 * frame is filled with exactly what is on screen and only the overhang on one axis is cut. Also
 * where the page draws its red "recording" frame, in CSS pixels.
 */
export function screenCrop(width: number, height: number, aspect = SCREEN_ASPECT): Rect {
  if (width <= 0 || height <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  const w = Math.min(width, height * aspect);
  const h = w / aspect;
  return { x: (width - w) / 2, y: (height - h) / 2, w, h };
}

export interface ShareInfo {
  ownerName: string;
  working: number;
  waiting: number;
  /** printed as is: the short link when there is one, else the long city link — without the scheme */
  shortLink: string;
}

export interface Rect { x: number; y: number; w: number; h: number }

export interface TextBlock {
  text: string;
  /** `align: 'center'` = the centre of the line; otherwise its left edge */
  x: number;
  /** the baseline */
  y: number;
  size: number;
  weight: 400 | 600 | 700;
  tone: 'fg' | 'muted' | 'accent';
  align: 'left' | 'center';
  maxWidth: number;
}

export interface ShareLayout {
  format: ShareFormat;
  width: number;
  height: number;
  scene: Rect;
  mark: TextBlock;
  title: TextBlock;
  live: TextBlock;
  link: TextBlock;
  invite: TextBlock;
}

/** The city page's tokens (tailwind.config.js) and the brand's accent gradient. */
const COLORS = { bg: '#0f1115', line: '#2a2f3a', fg: '#e6e8ee', muted: '#9aa1b1', accentFrom: '#5b63d3', accentTo: '#7c87f7' };
const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/**
 * Average glyph width of FONT as a fraction of its size, on the generous side: the layout cannot
 * measure text (no DOM), so it budgets characters with this, and `fillText`'s own maxWidth squeezes
 * whatever a real font still overruns.
 */
export const GLYPH = 0.56;

export function ellipsize(text: string, maxChars: number): string {
  const chars = [...text];
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join('').trimEnd()}…`;
}

const budget = (size: number, maxWidth: number) => Math.max(1, Math.floor(maxWidth / (size * GLYPH)));

/** Plain text: ellipsised to its budget. */
function line(text: string, at: Omit<TextBlock, 'text'>): TextBlock {
  return { ...at, text: ellipsize(text, budget(at.size, at.maxWidth)) };
}

/** A link: the type shrinks (down to `min`) before a single character is cut — a cut link does not work. */
function linkLine(text: string, at: Omit<TextBlock, 'text'>, min: number): TextBlock {
  let size = at.size;
  while (size > min && [...text].length > budget(size, at.maxWidth)) size -= 2;
  return line(text, { ...at, size });
}

export function liveLine(working: number, waiting: number): string {
  const first = working === 0 ? 'Nenhum agente trabalhando agora' : `${working} ${working === 1 ? 'agente trabalhando' : 'agentes trabalhando'} agora`;
  return waiting > 0 ? `${first} · ${waiting} esperando você` : first;
}

export function displayLink(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

/** What the page draws right now: robots drawn typing (every working robot), and raised hands. */
export function countsOf(model: CityModel): { working: number; waiting: number } {
  let working = 0;
  for (const building of model.buildings) for (const desk of building.desks) if (desk.pose === 'type') working += 1;
  return { working, waiting: model.needsYou };
}

export function shareInfoFor(city: PublicCity, model: CityModel, longUrl: string): ShareInfo {
  return { ownerName: city.owner_name, ...countsOf(model), shortLink: displayLink(city.short_url ?? longUrl) };
}

export function layoutFor(format: ShareFormat, info: ShareInfo): ShareLayout {
  const { width, height } = FORMAT_SIZE[format];
  const title = `Cidade de ${info.ownerName}`;
  const live = liveLine(info.working, info.waiting);
  const invite = 'Participe do beta grátis';

  if (format === 'story') {
    // header 300 · scene 70% (1344) · footer 276
    const pad = 72;
    const inner = width - pad * 2;
    const headerH = 300;
    const scene: Rect = { x: 0, y: headerH, w: width, h: Math.round(height * 0.7) };
    const footer = scene.y + scene.h;
    return {
      format, width, height, scene,
      mark: line('termhub', { x: pad, y: 104, size: 44, weight: 700, tone: 'accent', align: 'left', maxWidth: inner }),
      title: line(title, { x: pad, y: 190, size: 64, weight: 700, tone: 'fg', align: 'left', maxWidth: inner }),
      live: line(live, { x: pad, y: 258, size: 32, weight: 400, tone: 'muted', align: 'left', maxWidth: inner }),
      link: linkLine(info.shortLink, { x: width / 2, y: footer + 128, size: 76, weight: 700, tone: 'accent', align: 'center', maxWidth: inner }, 32),
      invite: line(invite, { x: width / 2, y: footer + 212, size: 42, weight: 600, tone: 'fg', align: 'center', maxWidth: inner }),
    };
  }

  // post: the scene on the left (62%), a text column on the right
  const scene: Rect = { x: 0, y: 0, w: Math.round(width * 0.62), h: height };
  const pad = 48;
  const colX = scene.w + pad;
  const colW = width - colX - pad;
  return {
    format, width, height, scene,
    mark: line('termhub', { x: colX, y: 150, size: 40, weight: 700, tone: 'accent', align: 'left', maxWidth: colW }),
    title: line(title, { x: colX, y: 250, size: 48, weight: 700, tone: 'fg', align: 'left', maxWidth: colW }),
    live: line(live, { x: colX, y: 320, size: 24, weight: 400, tone: 'muted', align: 'left', maxWidth: colW }),
    link: linkLine(info.shortLink, { x: colX, y: 800, size: 56, weight: 700, tone: 'accent', align: 'left', maxWidth: colW }, 22),
    invite: line(invite, { x: colX, y: 880, size: 36, weight: 600, tone: 'fg', align: 'left', maxWidth: colW }),
  };
}

/** Paints one frame of any capture: the scene alone for `screen`, the composed layout otherwise. */
export function paintCapture(ctx: CanvasRenderingContext2D, format: CaptureFormat, info: ShareInfo, scene: CanvasImageSource & { width: number; height: number }): void {
  if (format !== 'screen') return drawFrame(ctx, layoutFor(format, info), scene);
  const { width, height } = FORMAT_SIZE.screen;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, width, height);
  const c = screenCrop(scene.width, scene.height);
  if (c.w > 0) ctx.drawImage(scene, c.x, c.y, c.w, c.h, 0, 0, width, height);
  ctx.restore();
}

/** Paints one frame. `scene` is the office canvas as it was just rendered (OfficeScene.onFrame). */
export function drawFrame(ctx: CanvasRenderingContext2D, layout: ShareLayout, scene: CanvasImageSource & { width: number; height: number }): void {
  ctx.save();
  ctx.imageSmoothingEnabled = false; // pixel art stays pixel art
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, layout.width, layout.height);

  // the scene, whole: scaled to fit inside its box and centred, never cropped — a cover-crop cut whole
  // buildings off a wide view. The bars around it are the frame's background, painted above.
  const r = layout.scene;
  if (scene.width > 0 && scene.height > 0) {
    const k = Math.min(r.w / scene.width, r.h / scene.height);
    const dw = Math.round(scene.width * k);
    const dh = Math.round(scene.height * k);
    const dx = Math.round(r.x + (r.w - dw) / 2);
    const dy = Math.round(r.y + (r.h - dh) / 2);
    ctx.drawImage(scene, 0, 0, scene.width, scene.height, dx, dy, dw, dh);
  }

  // hairlines between the bands, in the page's `line` colour
  ctx.fillStyle = COLORS.line;
  if (layout.format === 'story') {
    ctx.fillRect(0, r.y - 2, layout.width, 2);
    ctx.fillRect(0, r.y + r.h, layout.width, 2);
  } else {
    ctx.fillRect(r.x + r.w, 0, 2, layout.height);
  }

  for (const b of [layout.mark, layout.title, layout.live, layout.link, layout.invite]) {
    ctx.font = `${b.weight} ${b.size}px ${FONT}`;
    ctx.textAlign = b.align;
    ctx.textBaseline = 'alphabetic';
    if (b.tone === 'accent') {
      const x0 = b.align === 'center' ? b.x - b.maxWidth / 2 : b.x;
      const gradient = ctx.createLinearGradient(x0, 0, x0 + b.maxWidth, 0);
      gradient.addColorStop(0, COLORS.accentFrom);
      gradient.addColorStop(1, COLORS.accentTo);
      ctx.fillStyle = gradient;
    } else {
      ctx.fillStyle = b.tone === 'fg' ? COLORS.fg : COLORS.muted;
    }
    ctx.fillText(b.text, b.x, b.y, b.maxWidth);
  }
  ctx.restore();
}
