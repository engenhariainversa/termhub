/**
 * Whether a question card of a tab under automatic work needs its own push (agentic board D25, review I2).
 * The card's push is held back only when automatic work positively took the card over: an answer
 * scheduled or sent, the chat woken for it, or an escalation recorded (which is pushed itself). In every
 * other case — automation left it, failed, threw, or never answered within HOLD_MAX_MS — the card is pushed
 * as any other. Per process, like the buses: the card, its automation and its push live in one process.
 */

/** Past this long without a verdict, the card is pushed (a wake that hangs, a crashed handler). */
export const HOLD_MAX_MS = 60_000;

interface Hold {
  promise: Promise<boolean>;
  resolve: (owned: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

const holds = new Map<string, Hold>();

/**
 * Called before the card is published, when automatic work will look at it: the push service then waits
 * for `settleQuestion` instead of pushing at once.
 */
export function expectVerdict(questionId: string, maxMs = HOLD_MAX_MS): void {
  if (holds.has(questionId)) return;
  let resolve!: (owned: boolean) => void;
  const promise = new Promise<boolean>((r) => (resolve = r));
  const timer = setTimeout(() => settleQuestion(questionId, false), maxMs);
  timer.unref?.();
  holds.set(questionId, { promise, resolve, timer });
}

/** Automatic work's verdict on the card: `owned` true when it took the card over (no card push needed). */
export function settleQuestion(questionId: string, owned: boolean): void {
  const hold = holds.get(questionId);
  if (!hold) return;
  clearTimeout(hold.timer);
  hold.resolve(owned);
  // kept until the push service reads it, but never forever
  setTimeout(() => holds.delete(questionId), 5_000).unref?.();
}

/**
 * For the push service: null when nothing holds the card (push it now); otherwise a promise of whether
 * automatic work took it over. Reading it releases the hold.
 */
export function heldQuestion(questionId: string): Promise<boolean> | null {
  const hold = holds.get(questionId);
  if (!hold) return null;
  return hold.promise.finally(() => holds.delete(questionId));
}

/** Tests. */
export function resetQuestionHolds(): void {
  for (const h of holds.values()) clearTimeout(h.timer);
  holds.clear();
}
