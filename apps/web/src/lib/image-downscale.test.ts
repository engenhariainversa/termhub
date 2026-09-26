import { describe, expect, it } from 'vitest';
import { fitWithin, isDownscalable, jpegName, MAX_IMAGE_SIDE } from './image-downscale';

describe('fitWithin', () => {
  it('scales the long side down to the max and keeps the aspect', () => {
    // The spec's own example: a 4:3 photo lands at 1568×1176.
    expect(fitWithin(4000, 3000, MAX_IMAGE_SIDE)).toEqual({ width: 1568, height: 1176 });
    expect(fitWithin(3000, 4000, MAX_IMAGE_SIDE)).toEqual({ width: 1176, height: 1568 });
  });

  it('never upscales', () => {
    expect(fitWithin(800, 600, MAX_IMAGE_SIDE)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(1568, 10, MAX_IMAGE_SIDE)).toEqual({ width: 1568, height: 10 });
  });

  it('rounds to whole pixels and never below one', () => {
    expect(fitWithin(10000, 3, 1568)).toEqual({ width: 1568, height: 1 });
  });
});

describe('isDownscalable', () => {
  it('re-encodes jpeg, png and webp, and leaves a gif (animation) alone', () => {
    expect(isDownscalable('image/jpeg')).toBe(true);
    expect(isDownscalable('image/png')).toBe(true);
    expect(isDownscalable('image/webp')).toBe(true);
    expect(isDownscalable('image/gif')).toBe(false);
    expect(isDownscalable('application/pdf')).toBe(false);
  });
});

describe('jpegName', () => {
  it('swaps the extension for .jpg', () => {
    expect(jpegName('foto.PNG')).toBe('foto.jpg');
    expect(jpegName('sem-extensao')).toBe('sem-extensao.jpg');
  });
});
