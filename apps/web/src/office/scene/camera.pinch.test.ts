// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Camera } from './camera';

const cameras: Camera[] = [];
afterEach(() => {
  cameras.splice(0).forEach((c) => c.destroy());
  document.body.innerHTML = '';
});

/** jsdom has no PointerEvent: a MouseEvent carrying a pointerId stands in for a finger. */
const finger = (type: string, id: number, x: number, y: number) => {
  const e = new MouseEvent(type, { clientX: x, clientY: y });
  Object.defineProperty(e, 'pointerId', { value: id });
  return e;
};

describe('Camera pinch', () => {
  it('zooms in when two fingers spread, around their midpoint, and never counts as a tap', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const cam = new Camera(canvas);
    cameras.push(cam);
    canvas.dispatchEvent(finger('pointerdown', 1, 100, 100));
    canvas.dispatchEvent(finger('pointerdown', 2, 200, 100));
    // finger 2 moves out: the distance goes from 100 to 200
    window.dispatchEvent(finger('pointermove', 2, 300, 100));
    expect(cam.target.scale).toBeCloseTo(2, 5);
    expect(cam.dragged).toBeGreaterThanOrEqual(5);
    // the world point that was under the old midpoint (150) sits under the new one (200)
    expect((200 - cam.target.x) / cam.target.scale).toBeCloseTo((150 - 0) / 1, 5);
  });

  it('drags with one finger after the other lifts', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const cam = new Camera(canvas);
    cameras.push(cam);
    canvas.dispatchEvent(finger('pointerdown', 1, 100, 100));
    canvas.dispatchEvent(finger('pointerdown', 2, 200, 100));
    window.dispatchEvent(finger('pointerup', 2, 200, 100));
    const before = { ...cam.target };
    window.dispatchEvent(finger('pointermove', 1, 130, 110));
    expect(cam.target).toEqual({ ...before, x: before.x + 30, y: before.y + 10 });
  });
});
