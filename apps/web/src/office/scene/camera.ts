/** The camera: pure view math, plus the class that binds wheel, drag and pinch to it. No PixiJS here. */
export interface View {
  x: number;
  y: number;
  scale: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Whether two framings ask for the same view: a box a rebuild left where it was must not re-frame. */
export function sameBox(a: Box, b: Box): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

export const MIN_SCALE = 0.15;
export const MAX_SCALE = 4;
const clamp = (s: number, max = MAX_SCALE) => Math.min(max, Math.max(MIN_SCALE, Number.isFinite(s) ? s : 1));

/** The view that centres `box` on the screen with `margin` pixels around it. */
export function frame(box: Box, screen: { width: number; height: number }, margin = 40, maxScale = 2.5): View {
  const availW = Math.max(1, screen.width - margin * 2);
  const availH = Math.max(1, screen.height - margin * 2);
  const scale = clamp(box.w > 0 && box.h > 0 ? Math.min(availW / box.w, availH / box.h) : 1, maxScale);
  return { scale, x: screen.width / 2 - (box.x + box.w / 2) * scale, y: screen.height / 2 - (box.y + box.h / 2) * scale };
}

/** Zooms by `factor` keeping the world point under screen point (cx, cy) fixed. */
export function zoomAt(view: View, cx: number, cy: number, factor: number): View {
  const scale = clamp(view.scale * factor);
  const k = scale / view.scale;
  return { scale, x: cx - (cx - view.x) * k, y: cy - (cy - view.y) * k };
}

export function ease(current: View, target: View, k: number): View {
  return { x: current.x + (target.x - current.x) * k, y: current.y + (target.y - current.y) * k, scale: current.scale + (target.scale - current.scale) * k };
}

export function settled(a: View, b: View): boolean {
  return Math.abs(a.x - b.x) < 0.1 && Math.abs(a.y - b.y) < 0.1 && Math.abs(a.scale - b.scale) < 0.001;
}

export class Camera {
  target: View = { x: 0, y: 0, scale: 1 };
  current: View = { x: 0, y: 0, scale: 1 };
  /** pixels dragged since the last pointer down: a click is a press that moved less than 5 */
  dragged = 0;
  /** called when the person zooms or pans by hand (the page uses it to notice "zoomed out of the room") */
  onUserMove: (() => void) | null = null;
  /** while recording a video: wheel and drag are ignored, so the picture does not shake */
  locked = false;
  private snapNext = true;
  private cleanup: Array<() => void> = [];

  constructor(private readonly canvas: HTMLCanvasElement) {
    // every finger (or the mouse) on the canvas: one drags, two pinch and pan together
    const pointers = new Map<number, { x: number; y: number }>();
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (this.locked) return;
      const r = canvas.getBoundingClientRect();
      this.target = zoomAt(this.target, e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
      this.onUserMove?.();
    };
    const onDown = (e: PointerEvent) => {
      if (pointers.size === 0) this.dragged = 0;
      // a locked camera starts no drag at all (a tap on a room still counts as a click)
      if (!this.locked) pointers.set(e.pointerId ?? 0, { x: e.clientX, y: e.clientY });
    };
    const onMove = (e: PointerEvent) => {
      const id = e.pointerId ?? 0;
      const prev = pointers.get(id);
      if (!prev) return;
      // locked mid-drag: the press ends here, so unlocking later does not make the picture jump
      if (this.locked) {
        pointers.clear();
        return;
      }
      const next = { x: e.clientX, y: e.clientY };
      const other = [...pointers].find(([k]) => k !== id)?.[1];
      pointers.set(id, next);
      if (other) {
        // a pinch: zoom by how far the fingers spread, around their midpoint, and pan with it
        const r = canvas.getBoundingClientRect();
        const before = Math.hypot(prev.x - other.x, prev.y - other.y);
        const after = Math.hypot(next.x - other.x, next.y - other.y);
        // zoom around where the midpoint was, then carry the picture to where it is now, so what
        // was under the fingers stays under them
        const mid = { x: (prev.x + other.x) / 2 - r.left, y: (prev.y + other.y) / 2 - r.top };
        const zoomed = before > 0 ? zoomAt(this.target, mid.x, mid.y, after / before) : this.target;
        this.target = { ...zoomed, x: zoomed.x + (next.x - prev.x) / 2, y: zoomed.y + (next.y - prev.y) / 2 };
        // two fingers are never a tap
        this.dragged += 5 + Math.abs(after - before);
        this.onUserMove?.();
        return;
      }
      const dx = next.x - prev.x;
      const dy = next.y - prev.y;
      this.dragged += Math.abs(dx) + Math.abs(dy);
      this.target = { ...this.target, x: this.target.x + dx, y: this.target.y + dy };
      if (this.dragged >= 5) this.onUserMove?.();
    };
    const onUp = (e: PointerEvent) => pointers.delete(e.pointerId ?? 0);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    this.cleanup.push(() => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    });
  }

  frameBox(box: Box, snap = false): void {
    this.target = frame(box, { width: this.canvas.clientWidth, height: this.canvas.clientHeight });
    if (snap) this.snapNext = true;
  }

  /** Advances one frame and returns the view to apply to the world container. */
  tick(): View {
    this.current = this.snapNext ? this.target : ease(this.current, this.target, 0.18);
    this.snapNext = false;
    return this.current;
  }

  destroy(): void {
    this.cleanup.forEach((fn) => fn());
  }
}
