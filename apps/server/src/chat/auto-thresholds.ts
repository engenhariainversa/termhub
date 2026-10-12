import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import type { AutoSample } from '../db/repositories/chat-auto.js';
import type { Repositories } from '../db/repositories/index.js';
import { memoryCode } from './embeddings.js';

/** The two similarity bands of an automatic answer (TER-642): from `high` it is sent at once; from `low`
 *  it is suggested and, with "Responder sozinho" on, sent when the countdown runs out; below `low`
 *  nothing is suggested. Always `low <= high`. */
export interface AutoThresholds {
  high: number;
  low: number;
}

/** A person's last calibration, as stored in `users.chat_auto_calibration`. */
export interface AutoCalibration extends AutoThresholds {
  samples: number;
  computed_at: string;
}

/** What `GET /memory` says about a person's thresholds: the ones in force, where they come from
 *  (`manual`: pinned by hand; `calibrated`: from their own answers; `default`: too little history yet),
 *  the defaults, the last calibration and how many answers calibration needs. */
export interface AutoThresholdsView extends AutoThresholds {
  source: 'manual' | 'calibrated' | 'default';
  defaults: AutoThresholds;
  samples: number;
  min_samples: number;
  calibrated_at: string | null;
}

export type AutoBand = 'high' | 'mid';

/** How many of a person's own observations calibration needs before it moves anything. */
export const CALIBRATION_MIN_SAMPLES = 30;
/** The newest observations calibration reads: old habits age out. */
export const CALIBRATION_WINDOW = 300;
/** How many observations a slice of scores needs before it counts as evidence. */
export const SLICE_MIN_SAMPLES = 15;
/** Of the answers sent at once, at least this share must be what the person would have answered. */
export const HIGH_PRECISION = 0.97;
/** Of the answers suggested with a countdown, at least this share. */
export const LOW_PRECISION = 0.85;
/** Calibration never moves a threshold outside these bounds; a person may pin anything in 0.5–1. */
export const HIGH_BOUNDS = { min: 0.9, max: 0.99 } as const;
export const LOW_BOUNDS = { min: 0.7 } as const;
const STEP = 0.01;

const round2 = (n: number): number => Math.round(n * 100) / 100;

export const defaultThresholds = (): AutoThresholds => ({ high: config.autoAnswerHigh, low: config.autoAnswerLow });

/** Which band a score falls in, or null below `low` (nothing is suggested). */
export function bandOf(score: number, t: AutoThresholds): AutoBand | null {
  if (!Number.isFinite(score)) return null;
  return score >= t.high ? 'high' : score >= t.low ? 'mid' : null;
}

type Scored = Pick<AutoSample, 'score' | 'matched'>;

/** The observations scoring in `[from, to)`, and how many of them agreed with the person. */
function slice(samples: Scored[], from: number, to: number): { n: number; precision: number } {
  const inside = samples.filter((s) => s.score >= from - 1e-9 && s.score < to - 1e-9);
  return { n: inside.length, precision: inside.length ? inside.filter((s) => s.matched).length / inside.length : 0 };
}

/**
 * Moves one threshold from its default by the person's own record. It goes **up** when the scores from
 * the default to `ceiling` did not agree often enough (`target`): to the lowest higher value from which
 * they do — or to `ceiling` when none does. Otherwise it goes **down**, one step at a time, for as long
 * as the scores between the candidate and the default agree often enough, stopping at the first slice
 * that does not; a slice with too few observations proves nothing either way, and one that brings no
 * observation the step above did not already have proves nothing new: neither lowers the threshold nor
 * stops the walk. So only scores actually observed below the threshold move it down, and never past
 * the lowest of them: a pile of verbatim repeats at 1.0 says nothing about 0.9.
 */
function walk(samples: Scored[], start: number, floor: number, ceiling: number, target: number): number {
  const above = slice(samples, start, ceiling + STEP);
  if (above.n >= SLICE_MIN_SAMPLES && above.precision < target) {
    for (let t = round2(start + STEP); t < ceiling - 1e-9; t = round2(t + STEP)) {
      const s = slice(samples, t, ceiling + STEP);
      if (s.n < SLICE_MIN_SAMPLES || s.precision >= target) return t;
    }
    return ceiling;
  }
  let best = start;
  let seen = 0;
  for (let t = round2(start - STEP); t >= floor - 1e-9; t = round2(t - STEP)) {
    const s = slice(samples, t, start);
    if (s.n < SLICE_MIN_SAMPLES || s.n === seen) continue;
    if (s.precision < target) break;
    seen = s.n;
    best = t;
  }
  return best;
}

/**
 * A person's thresholds from their own observations (TER-642) — each one a precedent's score next to
 * whether it agreed with what the person did. Null with fewer than `CALIBRATION_MIN_SAMPLES`: the
 * defaults stay. Never reads anyone else's rows: the caller passes one user's samples. `high` stays in
 * `HIGH_BOUNDS`; `low` between `LOW_BOUNDS.min` and `high`.
 */
export function calibrate(samples: Scored[], defaults: AutoThresholds = defaultThresholds()): AutoThresholds | null {
  if (samples.length < CALIBRATION_MIN_SAMPLES) return null;
  const startHigh = Math.min(Math.max(round2(defaults.high), HIGH_BOUNDS.min), HIGH_BOUNDS.max);
  const high = walk(samples, startHigh, HIGH_BOUNDS.min, HIGH_BOUNDS.max, HIGH_PRECISION);
  const startLow = Math.min(Math.max(round2(defaults.low), LOW_BOUNDS.min), high);
  // The suggested band ends where the sent-at-once one starts: its evidence is the scores below `high`.
  const low = startLow >= high ? high : Math.min(walk(samples, startLow, LOW_BOUNDS.min, round2(high - STEP), LOW_PRECISION), high);
  return { high, low };
}

interface StoredThresholds {
  high: number | null;
  low: number | null;
  calibration: AutoCalibration | null;
}

/** The thresholds in force for one person: pinned by hand, else calibrated (with enough history), else
 *  the defaults. A stored pair that is not two numbers in order reads as absent. */
export function resolveThresholds(stored: StoredThresholds, defaults: AutoThresholds = defaultThresholds()): AutoThresholdsView {
  const valid = (t: { high: unknown; low: unknown } | null): t is AutoThresholds =>
    !!t && typeof t.high === 'number' && typeof t.low === 'number' && Number.isFinite(t.high) && Number.isFinite(t.low) && t.low <= t.high && t.low >= 0 && t.high <= 1;
  const cal = stored.calibration;
  const base = { defaults, samples: cal?.samples ?? 0, min_samples: CALIBRATION_MIN_SAMPLES, calibrated_at: cal?.computed_at ?? null };
  const manual = { high: stored.high, low: stored.low };
  if (valid(manual)) return { high: manual.high, low: manual.low, source: 'manual', ...base };
  if (cal && valid(cal) && cal.samples >= CALIBRATION_MIN_SAMPLES) return { high: cal.high, low: cal.low, source: 'calibrated', ...base };
  return { ...defaults, source: 'default', ...base };
}

/** One person's thresholds in force, read now. A user that is gone gets the defaults. */
export async function thresholdsFor(repos: Pick<Repositories, 'users'>, userId: string): Promise<AutoThresholdsView> {
  return resolveThresholds(await repos.users.chatAutoThresholds(userId));
}

/** How many people one sweep recalibrates at most; the rest wait for the next. */
const CALIBRATE_BATCH = 50;

/**
 * The periodic recalibration (TER-642): every person with an observation newer than their last
 * calibration gets theirs recomputed from their own newest `CALIBRATION_WINDOW` observations, and
 * stored — also for someone who pinned thresholds by hand, so going back to automatic is immediate.
 * With too little history the count alone is stored (the defaults stay in force). Resolves how many
 * people were recalibrated. Logs counts and codes only.
 */
export async function recalibrate(repos: Pick<Repositories, 'users' | 'chatAuto'>, log: Pick<FastifyBaseLogger, 'info' | 'warn'>, now = new Date()): Promise<number> {
  const userIds = await repos.chatAuto.usersToCalibrate(CALIBRATE_BATCH);
  let done = 0;
  for (const userId of userIds) {
    try {
      const samples = await repos.chatAuto.recentSamples(userId, CALIBRATION_WINDOW);
      const defaults = defaultThresholds();
      const t = calibrate(samples, defaults) ?? defaults;
      await repos.users.setChatAutoCalibration(userId, { ...t, samples: samples.length, computed_at: now.toISOString() });
      done++;
    } catch (err) {
      log.warn({ userId, code: memoryCode(err) }, 'auto answer calibration failed');
    }
  }
  if (done > 0) log.info({ users: done }, 'auto answer thresholds calibrated');
  return done;
}
