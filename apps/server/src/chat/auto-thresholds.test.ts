import { describe, expect, it, vi } from 'vitest';
import { bandOf, calibrate, CALIBRATION_MIN_SAMPLES, recalibrate, resolveThresholds, thresholdsFor } from './auto-thresholds.js';

const DEFAULTS = { high: 0.95, low: 0.85 };
/** `n` observations at `score`, the first `right` of them agreeing with the person. */
const at = (score: number, n: number, right = n) => Array.from({ length: n }, (_v, i) => ({ score, matched: i < right }));

describe('bandOf', () => {
  it('sends at once from high, counts down from low, and suggests nothing below', () => {
    expect(bandOf(1, DEFAULTS)).toBe('high');
    expect(bandOf(0.95, DEFAULTS)).toBe('high');
    expect(bandOf(0.9499, DEFAULTS)).toBe('mid');
    expect(bandOf(0.85, DEFAULTS)).toBe('mid');
    expect(bandOf(0.8499, DEFAULTS)).toBeNull();
    expect(bandOf(Number.NaN, DEFAULTS)).toBeNull();
  });

  it('with both thresholds equal there is no countdown band', () => {
    expect(bandOf(0.9, { high: 0.9, low: 0.9 })).toBe('high');
    expect(bandOf(0.89, { high: 0.9, low: 0.9 })).toBeNull();
  });
});

describe('calibrate', () => {
  it('too little history: null, the defaults stay', () => {
    expect(calibrate(at(1, CALIBRATION_MIN_SAMPLES - 1), DEFAULTS)).toBeNull();
  });

  it('verbatim repeats alone move nothing: they say nothing about the scores below them', () => {
    expect(calibrate(at(1, 200), DEFAULTS)).toEqual(DEFAULTS);
  });

  it('lowers the high threshold only as far as the scores right under it kept agreeing', () => {
    // 0.92–0.94 always right, 0.91 often wrong: high comes down to 0.92 and stops there
    const samples = [...at(1, 30), ...at(0.94, 15), ...at(0.93, 15), ...at(0.92, 15), ...at(0.91, 15, 9), ...at(0.9, 15)];
    expect(calibrate(samples, DEFAULTS)?.high).toBe(0.92);
  });

  it('never lowers the high threshold past its floor, however right the person proved it', () => {
    const samples = [...at(0.94, 40), ...at(0.9, 40), ...at(0.86, 40), ...at(0.8, 40)];
    expect(calibrate(samples, DEFAULTS)?.high).toBe(0.9);
  });

  it('raises the high threshold when answers sent at once would have been wrong too often', () => {
    // at 0.95–0.96 the precedent was wrong one time in five; from 0.97 up it never was
    const samples = [...at(0.95, 10, 8), ...at(0.96, 10, 8), ...at(0.97, 10), ...at(0.99, 20)];
    expect(calibrate(samples, DEFAULTS)?.high).toBe(0.97);
  });

  it('with nowhere safe to send at once, high goes to its ceiling', () => {
    expect(calibrate([...at(0.96, 20, 12), ...at(0.99, 20, 12)], DEFAULTS)?.high).toBe(0.99);
  });

  it('lowers the low threshold while suggestions under it would have been right often enough', () => {
    // 0.80–0.84 right nine times in ten (enough for a suggestion), 0.79 a coin toss
    const samples = [...at(1, 20), ...at(0.84, 10, 9), ...at(0.82, 10, 9), ...at(0.8, 10, 9), ...at(0.79, 20, 10)];
    expect(calibrate(samples, DEFAULTS)).toEqual({ high: 0.95, low: 0.8 });
  });

  it('raises the low threshold when the countdown band was wrong too often, up to high at most', () => {
    const noisy = [...at(1, 20), ...at(0.86, 20, 8), ...at(0.9, 20, 19), ...at(0.93, 10)];
    expect(calibrate(noisy, DEFAULTS)).toEqual({ high: 0.95, low: 0.87 });
    const hopeless = [...at(1, 20), ...at(0.86, 20, 8), ...at(0.9, 20, 8), ...at(0.94, 20, 8)];
    const t = calibrate(hopeless, DEFAULTS)!;
    expect(t.low).toBeLessThanOrEqual(t.high);
    expect(t.low).toBeGreaterThanOrEqual(0.94);
  });

  it('a slice with too few observations neither moves a threshold nor stops the walk', () => {
    // one wrong answer at 0.94 proves nothing by itself; with 0.93 well observed, the two together pass
    const samples = [...at(1, 30), ...at(0.94, 1, 0), ...at(0.93, 40)];
    expect(calibrate(samples, DEFAULTS)?.high).toBe(0.93);
    // …but enough wrong ones right under the threshold keep it where it is, whatever lies further down
    expect(calibrate([...at(1, 30), ...at(0.94, 3, 0), ...at(0.93, 30), ...at(0.92, 30)], DEFAULTS)?.high).toBe(0.95);
  });

  it('never goes below the lowest score actually observed', () => {
    // everything seen under 0.95 was at 0.93 and right: 0.93 it is, not the 0.90 floor
    expect(calibrate([...at(1, 30), ...at(0.93, 40)], DEFAULTS)?.high).toBe(0.93);
  });

  it('low never ends above high', () => {
    for (const samples of [at(0.9, 60), [...at(0.99, 30, 10), ...at(0.86, 30)], [...at(0.96, 30, 20), ...at(0.9, 30, 5)]]) {
      const t = calibrate(samples, DEFAULTS)!;
      expect(t.low).toBeLessThanOrEqual(t.high);
    }
  });
});

describe('resolveThresholds', () => {
  const calibration = { high: 0.93, low: 0.8, samples: 42, computed_at: '2026-10-10T00:00:00.000Z' };

  it('pinned by hand wins, then a calibration with enough history, then the defaults', () => {
    expect(resolveThresholds({ high: 0.99, low: 0.9, calibration }, DEFAULTS)).toMatchObject({ high: 0.99, low: 0.9, source: 'manual', samples: 42, calibrated_at: calibration.computed_at });
    expect(resolveThresholds({ high: null, low: null, calibration }, DEFAULTS)).toMatchObject({ high: 0.93, low: 0.8, source: 'calibrated' });
    expect(resolveThresholds({ high: null, low: null, calibration: { ...calibration, samples: 10 } }, DEFAULTS)).toMatchObject({ ...DEFAULTS, source: 'default', samples: 10 });
    expect(resolveThresholds({ high: null, low: null, calibration: null }, DEFAULTS)).toEqual({ ...DEFAULTS, source: 'default', defaults: DEFAULTS, samples: 0, min_samples: CALIBRATION_MIN_SAMPLES, calibrated_at: null });
  });

  it('a stored pair that is half there or out of order reads as absent', () => {
    expect(resolveThresholds({ high: 0.9, low: null, calibration: null }, DEFAULTS).source).toBe('default');
    expect(resolveThresholds({ high: 0.8, low: 0.9, calibration: null }, DEFAULTS).source).toBe('default');
    expect(resolveThresholds({ high: null, low: null, calibration: { ...calibration, low: 0.99 } }, DEFAULTS).source).toBe('default');
  });

  it('thresholdsFor reads one person: a missing user gets the defaults', async () => {
    const chatAutoThresholds = vi.fn(async () => ({ high: null, low: null, calibration: null }));
    expect(await thresholdsFor({ users: { chatAutoThresholds } } as never, 'u9')).toMatchObject({ source: 'default' });
    expect(chatAutoThresholds).toHaveBeenCalledWith('u9');
  });
});

describe('recalibrate', () => {
  const now = new Date('2026-10-11T12:00:00.000Z');
  const fake = (samplesOf: Record<string, { score: number; matched: boolean }[]>) => ({
    chatAuto: { usersToCalibrate: vi.fn(async () => Object.keys(samplesOf)), recentSamples: vi.fn(async (userId: string) => samplesOf[userId] ?? []) },
    users: { setChatAutoCalibration: vi.fn(async () => {}) },
  });

  it("recalibrates each person from their own samples only, and stores the count with the result", async () => {
    const repos = fake({ u1: [...at(1, 30), ...at(0.94, 15), ...at(0.93, 15)], u2: at(1, 5) });
    const log = { info: vi.fn(), warn: vi.fn() };
    expect(await recalibrate(repos as never, log, now)).toBe(2);
    expect(repos.chatAuto.recentSamples).toHaveBeenCalledWith('u1', 300);
    expect(repos.chatAuto.recentSamples).toHaveBeenCalledWith('u2', 300);
    expect(repos.users.setChatAutoCalibration).toHaveBeenCalledWith('u1', { high: 0.93, low: 0.85, samples: 60, computed_at: now.toISOString() });
    // too little history: the defaults, with the count, so the screen can say how far along they are
    expect(repos.users.setChatAutoCalibration).toHaveBeenCalledWith('u2', { high: 0.95, low: 0.85, samples: 5, computed_at: now.toISOString() });
    expect(log.info).toHaveBeenCalledWith({ users: 2 }, 'auto answer thresholds calibrated');
  });

  it('one person failing does not stop the rest; nobody to calibrate logs nothing', async () => {
    const repos = fake({ u1: at(1, 40), u2: at(1, 40) });
    repos.chatAuto.recentSamples.mockRejectedValueOnce(Object.assign(new Error('db'), { code: 'P1001' }));
    const log = { info: vi.fn(), warn: vi.fn() };
    expect(await recalibrate(repos as never, log, now)).toBe(1);
    expect(log.warn).toHaveBeenCalledWith({ userId: 'u1', code: expect.any(String) }, 'auto answer calibration failed');
    const idle = fake({});
    const quiet = { info: vi.fn(), warn: vi.fn() };
    expect(await recalibrate(idle as never, quiet, now)).toBe(0);
    expect(quiet.info).not.toHaveBeenCalled();
  });
});
