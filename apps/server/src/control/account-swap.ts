import type { FastifyBaseLogger } from 'fastify';
import type { Repositories } from '../db/repositories/index.js';
import type { Tab } from '../db/repositories/types.js';

/**
 * Moves a tab's Claude to another account of the same machine after a usage limit (spec 2026-09-26
 * account swap). Stub for now: monitor/ingest.ts calls this on every `rate_limit` StopFailure, but
 * the actual swap (picking an account, `claude --resume` under it, linking the transcript) lands in
 * Tasks 5/6.
 */
export function autoSwapOnLimit(_repos: Repositories, _log: FastifyBaseLogger, _tab: Tab): void {}
