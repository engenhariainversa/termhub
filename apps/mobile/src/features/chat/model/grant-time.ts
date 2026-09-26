// Verbatim from apps/web/src/components/chat/grant-time.ts
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** "até 14:32", or "até amanhã, 09:05" — a grant lasts at most 24 h, so those are the only two days. */
export function untilLabel(expiresAt: string, now = new Date()): string {
  const end = new Date(expiresAt);
  return end.toDateString() === now.toDateString() ? `até ${hhmm(end)}` : `até amanhã, ${hhmm(end)}`;
}

/** The server is the judge (it re-checks on every call); this only hides a strip that has run out. */
export const isGrantActive = (g: { expires_at: string }, now = new Date()) => Date.parse(g.expires_at) > now.getTime();

/**
 * The grants still in force, by the card that created them (chat redesign spec §4.2 "Stable rows"):
 * built once per `grants` change and re-checked by the screen's slow tick, so no row ever calls
 * `isGrantActive` during render. A grant with no source card cannot sit on a card and is left out.
 */
export function activeGrantIndex<G extends { source_action_id: string | null; expires_at: string }>(grants: G[], now = new Date()): Map<string, G> {
  const index = new Map<string, G>();
  for (const g of grants) {
    if (g.source_action_id !== null && isGrantActive(g, now)) index.set(g.source_action_id, g);
  }
  return index;
}
