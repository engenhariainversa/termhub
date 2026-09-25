import { describe, expect, it, vi } from 'vitest';
import type { CityModel, DeskModel } from '../../office/model';
import type { PublicCity } from '../../lib/types';
import { countsOf, displayLink, drawFrame, ellipsize, FORMAT_SIZE, GLYPH, layoutFor, liveLine, screenCrop, shareInfoFor, type ShareInfo, type ShareLayout, type TextBlock } from './compose';

const info = (over: Partial<ShareInfo> = {}): ShareInfo => ({ ownerName: 'Pedro', working: 3, waiting: 1, shortLink: '77a.it/pedro', ...over });
const blocks = (l: ShareLayout): TextBlock[] => [l.mark, l.title, l.live, l.link, l.invite];
const estimated = (b: TextBlock) => [...b.text].length * b.size * GLYPH;

describe('layoutFor', () => {
  for (const format of ['story', 'post'] as const) {
    it(`keeps every ${format} rectangle and line inside the canvas`, () => {
      const l = layoutFor(format, info());
      expect({ width: l.width, height: l.height }).toEqual(FORMAT_SIZE[format]);
      expect(l.scene.x).toBeGreaterThanOrEqual(0);
      expect(l.scene.y).toBeGreaterThanOrEqual(0);
      expect(l.scene.x + l.scene.w).toBeLessThanOrEqual(l.width);
      expect(l.scene.y + l.scene.h).toBeLessThanOrEqual(l.height);
      for (const b of blocks(l)) {
        const left = b.align === 'center' ? b.x - b.maxWidth / 2 : b.x;
        expect(left).toBeGreaterThanOrEqual(0);
        expect(left + b.maxWidth).toBeLessThanOrEqual(l.width);
        expect(b.y - b.size).toBeGreaterThanOrEqual(0);
        expect(b.y).toBeLessThanOrEqual(l.height);
        expect(estimated(b)).toBeLessThanOrEqual(b.maxWidth + 0.001);
        // no text over the scene
        const overlapsScene = b.x >= l.scene.x && b.x <= l.scene.x + l.scene.w && b.y - b.size < l.scene.y + l.scene.h && b.y > l.scene.y;
        expect(overlapsScene).toBe(false);
      }
    });
  }

  it('gives the scene about 70% of a story and 62% of a post', () => {
    expect(layoutFor('story', info()).scene.h / 1920).toBeCloseTo(0.7, 1);
    expect(layoutFor('post', info()).scene.w / 1920).toBeCloseTo(0.62, 2);
  });

  it('ellipsises a long owner name', () => {
    const l = layoutFor('story', info({ ownerName: 'Pedro de Alcântara Francisco Antônio João Carlos Xavier de Paula' }));
    expect(l.title.text.startsWith('Cidade de Pedro')).toBe(true);
    expect(l.title.text.endsWith('…')).toBe(true);
    expect(estimated(l.title)).toBeLessThanOrEqual(l.title.maxWidth);
  });

  it('says who is waiting only when somebody is', () => {
    expect(layoutFor('story', info({ working: 3, waiting: 1 })).live.text).toBe('3 agentes trabalhando agora · 1 esperando você');
    expect(layoutFor('story', info({ working: 3, waiting: 0 })).live.text).toBe('3 agentes trabalhando agora');
  });

  // Review Focus 6: a link on an image is useless if it is cut, so it shrinks instead
  it('shrinks a long link instead of cutting it, in both formats', () => {
    const long = `termhub.dev/city/@${'a'.repeat(30)}`;
    for (const format of ['story', 'post'] as const) {
      const short = layoutFor(format, info());
      const l = layoutFor(format, info({ shortLink: long }));
      expect(l.link.text).toBe(long);
      expect(l.link.size).toBeLessThan(short.link.size);
      expect(estimated(l.link)).toBeLessThanOrEqual(l.link.maxWidth + 0.001);
    }
  });

  it('carries the invitation', () => {
    expect(layoutFor('post', info()).invite.text).toBe('Participe do beta grátis');
  });
});

describe('the words', () => {
  it('counts in pt-BR', () => {
    expect(liveLine(1, 0)).toBe('1 agente trabalhando agora');
    expect(liveLine(0, 2)).toBe('Nenhum agente trabalhando agora · 2 esperando você');
  });
  it('ellipsises by characters, never past the budget', () => {
    expect(ellipsize('abcdef', 10)).toBe('abcdef');
    expect(ellipsize('abcdef', 4)).toBe('abc…');
  });
  it('shows a link without its scheme', () => {
    expect(displayLink('https://77a.it/pedro')).toBe('77a.it/pedro');
    expect(displayLink('https://termhub.dev/city/@pedro/')).toBe('termhub.dev/city/@pedro');
  });
});

describe('shareInfoFor', () => {
  const desk = (id: string, pose: DeskModel['pose']) => ({ id, pose }) as DeskModel;
  const model = { needsYou: 2, buildings: [{ id: 'b1', desks: [desk('a', 'type'), desk('b', 'type'), desk('c', 'raise'), desk('d', 'sleep')] }] } as unknown as CityModel;
  const city: PublicCity = { nickname: 'pedro', owner_name: 'Pedro', short_url: null, buildings: [] };

  it('counts robots drawn typing, and the raised hands the model already counts', () => {
    expect(countsOf(model)).toEqual({ working: 2, waiting: 2 });
  });

  it('prints the short link when there is one, else the long one', () => {
    expect(shareInfoFor({ ...city, short_url: 'https://77a.it/pedro' }, model, 'https://termhub.dev/city/@pedro').shortLink).toBe('77a.it/pedro');
    expect(shareInfoFor(city, model, 'https://termhub.dev/city/@pedro').shortLink).toBe('termhub.dev/city/@pedro');
  });
});

describe('drawFrame', () => {
  function fakeCtx() {
    return {
      save: vi.fn(), restore: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn(), fillText: vi.fn(),
      createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
      imageSmoothingEnabled: true, fillStyle: '' as unknown, font: '', textAlign: 'left', textBaseline: 'alphabetic',
    };
  }

  it('paints the whole scene pixel-sharp, fitted inside its box, and every line of text', () => {
    const ctx = fakeCtx();
    const l = layoutFor('story', info());
    // a wide scene canvas in a tall box: never cropped (a cut would drop whole buildings), letterboxed and centred
    drawFrame(ctx as unknown as CanvasRenderingContext2D, l, { width: 2000, height: 1000 } as HTMLCanvasElement);
    expect(ctx.imageSmoothingEnabled).toBe(false);
    const [, sx, sy, sw, sh, dx, dy, dw, dh] = ctx.drawImage.mock.calls[0] as number[];
    expect([sx, sy, sw, sh]).toEqual([0, 0, 2000, 1000]);
    expect(dw).toBeCloseTo(l.scene.w, 0);
    expect(dh).toBeCloseTo(l.scene.w / 2, 0);
    expect(dx).toBeCloseTo(l.scene.x, 0);
    expect(dy).toBeCloseTo(l.scene.y + (l.scene.h - dh) / 2, 0);
    // the bars are the frame's background, painted before the scene
    expect(ctx.fillRect.mock.calls[0]).toEqual([0, 0, l.width, l.height]);
    const texts = ctx.fillText.mock.calls.map((c) => c[0]);
    expect(texts).toEqual(expect.arrayContaining(['termhub', 'Cidade de Pedro', '77a.it/pedro', 'Participe do beta grátis']));
  });

  it('pillarboxes a tall scene in the post’s wide box, inside the box', () => {
    const ctx = fakeCtx();
    const l = layoutFor('post', info());
    drawFrame(ctx as unknown as CanvasRenderingContext2D, l, { width: 500, height: 1000 } as HTMLCanvasElement);
    const [, sx, sy, sw, sh, dx, dy, dw, dh] = ctx.drawImage.mock.calls[0] as number[];
    expect([sx, sy, sw, sh]).toEqual([0, 0, 500, 1000]);
    expect(dh).toBeCloseTo(l.scene.h, 0);
    expect(dw).toBeCloseTo(l.scene.h / 2, 0);
    expect(dx).toBeGreaterThanOrEqual(l.scene.x);
    expect(dx + dw).toBeLessThanOrEqual(l.scene.x + l.scene.w);
    expect(dx).toBeCloseTo(l.scene.x + (l.scene.w - dw) / 2, 0);
    expect(dy).toBe(l.scene.y);
  });

  it('draws no scene from an empty canvas instead of dividing by zero', () => {
    const ctx = fakeCtx();
    drawFrame(ctx as unknown as CanvasRenderingContext2D, layoutFor('post', info()), { width: 0, height: 0 } as HTMLCanvasElement);
    expect(ctx.drawImage).not.toHaveBeenCalled();
    expect(ctx.fillText).toHaveBeenCalled();
  });
});

describe('screenCrop', () => {
  it('keeps the largest centred 16:9 box of the view', () => {
    // wider than 16:9: the sides go
    expect(screenCrop(2000, 900)).toEqual({ x: 200, y: 0, w: 1600, h: 900 });
    // a phone held upright: the top and bottom go
    expect(screenCrop(390, 700)).toEqual({ x: 0, y: (700 - 390 / (16 / 9)) / 2, w: 390, h: 390 / (16 / 9) });
    expect(screenCrop(1920, 1080)).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    expect(screenCrop(0, 500)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});
