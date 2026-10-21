/**
 * TER-1101: the answers the concierge writes on its own — a turn started by `ChatService.wake` (a watch, a
 * reminder, a subagent's report, a tab's card). The generic "Resposta pronta" push skips them: such an answer
 * reaches the phone only through `notify`, with the level the concierge chose. In memory: the run and its
 * `run_finished` live in the process that started it.
 */
const woken = new Set<string>();
const MAX = 10_000;

export function markWokenAnswer(messageId: string): void {
  if (woken.size >= MAX) woken.clear();
  woken.add(messageId);
}

/** Whether the answer was a wake's; forgets it (one `run_finished` per answer). */
export function isWokenAnswer(messageId: string): boolean {
  return woken.delete(messageId);
}
