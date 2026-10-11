// The pure routing decision behind `usePhaseRedirect` (design spec §8). No `expo-router` or
// `react-native` import, so it is a plain model module: testable on its own and safe under the
// `logic` Jest project, same as every other file in `model/`.
import type { Phase } from './session.types';

/** The blocking screen of a pending account deletion (`app/account-deletion.tsx`). */
const ACCOUNT_DELETION_SEGMENT = 'account-deletion';

/** The acceptance screen of the Terms of Use and Privacy Policy (`app/legal-acceptance.tsx`, TER-742). */
const LEGAL_ACCEPTANCE_SEGMENT = 'legal-acceptance';

/** Each phase's own screen. */
const HOME: Record<Phase, string> = {
  new: '/',
  waiting: '/enrol/waiting',
  pin_setup: '/enrol/create-pin',
  locked: '/unlock',
  unlocked: '/(tabs)',
};

/** The first segments of the screens that belong to another phase (or to a pending deletion or
 * legal acceptance). */
const NOT_UNLOCKED = new Set(['enrol', 'unlock', ACCOUNT_DELETION_SEGMENT, LEGAL_ACCEPTANCE_SEGMENT]);

/** Whether `segments` (from `useSegments()`) already sit inside `phase`'s own group. `unlocked`
 * owns every screen but the other phases' ones: the tabs, the conversation (`app/chat/[id].tsx`),
 * a session (`app/session/[tabId].tsx`), the file preview and the rest. An allow-list here bounced
 * each screen it forgot back to `/(tabs)` on its first render (TER-1002). */
function onPhaseHome(phase: Phase, segments: string[]): boolean {
  switch (phase) {
    case 'new':
      return segments.length === 0;
    case 'waiting':
      return segments[0] === 'enrol' && segments[1] === 'waiting';
    case 'pin_setup':
      return segments[0] === 'enrol' && segments[1] === 'create-pin';
    case 'locked':
      return segments[0] === 'unlock';
    case 'unlocked':
      // The root `index` (segments `[]`) is Início, the `new` phase's screen.
      return segments[0] !== undefined && !NOT_UNLOCKED.has(segments[0]);
  }
}

export interface RedirectDecision {
  /** Where to `router.replace` to, or `null` when the current route already matches `phase`. */
  target: string | null;
  /** Whether the hook may clear `pendingRoute` on this pass. */
  shouldClear: boolean;
}

const normalise = (path: string) => `/${path.split('/').filter(Boolean).join('/')}`;

/**
 * `null`/`false` when the current route already matches `phase`. A set `pendingRoute` while
 * `unlocked` (a deep link caught while locked, P§9) always wins over the phase's own home — but
 * it is only *cleared* once the route shows it was actually reached: clearing in the same pass
 * that issues the `replace` would let a stale route (still the old one, one render behind) fall
 * through to `HOME.unlocked` and override the deep link with a second redirect.
 *
 * "Reached" compares the full `pathname` (`usePathname()`, e.g. `/chat/c1`), not `segments`:
 * expo-router's segments hold the file names (`['chat', '[id]']`), so they cannot tell one
 * conversation from another — `/chat/c2` must not count as arriving at `/chat/c1`.
 *
 * `deletionPending` (TER-720) sends an unlocked session to `/account-deletion` ahead of everything;
 * `legalPending` (TER-742) sends it to `/legal-acceptance` right after that.
 */
export function redirectFor(
  phase: Phase,
  segments: string[],
  pendingRoute: string | null,
  pathname: string,
  deletionPending = false,
  legalPending = false,
): RedirectDecision {
  // A pending account deletion (TER-720) takes over the unlocked app: only its blocking screen is
  // reachable, and a deep link waits (not cleared) until the person cancels. Once cancelled, the
  // screen is no unlocked home, so the checks below send it back to the tabs.
  if (phase === 'unlocked' && deletionPending) {
    return segments[0] === ACCOUNT_DELETION_SEGMENT ? { target: null, shouldClear: false } : { target: `/${ACCOUNT_DELETION_SEGMENT}`, shouldClear: false };
  }
  // A Terms / Privacy Policy version in force not accepted yet (TER-742): same hold, second in line
  // (a pending deletion keeps the account from being used at all, so it goes first). Once accepted,
  // a waiting deep link is followed, or the screen goes back to the tabs.
  if (phase === 'unlocked' && legalPending) {
    return segments[0] === LEGAL_ACCEPTANCE_SEGMENT ? { target: null, shouldClear: false } : { target: `/${LEGAL_ACCEPTANCE_SEGMENT}`, shouldClear: false };
  }
  if (phase === 'unlocked' && pendingRoute) {
    const arrived = normalise(pathname) === normalise(pendingRoute);
    return arrived ? { target: null, shouldClear: true } : { target: pendingRoute, shouldClear: false };
  }
  if (onPhaseHome(phase, segments)) return { target: null, shouldClear: false };
  return { target: HOME[phase], shouldClear: false };
}
