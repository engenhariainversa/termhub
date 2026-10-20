// Tells the server whether termhub is in focus on this phone (TER-642): the countdown of an automatic
// answer only runs while some screen of the person's is, and the server pauses it otherwise. One report
// on every change, a heartbeat while in focus, and "not in focus" when the app leaves the foreground.
// A factory over injected services like the feature stores; `view/focus-reporter.ts` builds the app's
// one instance (the view layer reads `AppState`, a viewmodel never imports `react-native`).
import { appBackgrounded, appForegrounded, sessionEnded, sessionStarted } from '@/features/shared/signals';
import { FOCUS_BEAT_SECONDS } from '@/services/api/contract';
import type { Auth, MobileApi } from '@/services/api/types';

export interface FocusReporterDeps {
  api: Pick<MobileApi, 'reportChatFocus'>;
  /** The session store: `auth()` throws while there is no session to report for (locked, signed out). */
  session: () => { auth(): Auth };
  /** This app launch's own id, `chatFocusBody.client_id`. */
  clientId: string;
  /** Whether the app is in the foreground right now. */
  active: () => boolean;
  beatMs?: number;
}

export function createFocusReporter(deps: FocusReporterDeps) {
  const beatMs = deps.beatMs ?? FOCUS_BEAT_SECONDS * 1000;
  let timer: ReturnType<typeof setInterval> | null = null;
  /** What the server was last told; null before the first report and after the session went away. */
  let reported: boolean | null = null;

  const auth = (): Auth | null => {
    try {
      return deps.session().auth();
    } catch {
      return null;
    }
  };

  const stopBeat = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  /** False without a session. A lost report costs nothing: the next beat repeats it, and the server
   *  lets a silent screen lapse. */
  const send = (focused: boolean): boolean => {
    const a = auth();
    if (!a) {
      reported = null;
      return false;
    }
    reported = focused;
    void Promise.resolve()
      .then(() => deps.api.reportChatFocus(a, deps.clientId, focused))
      .catch(() => undefined);
    return true;
  };

  const set = (focused: boolean): void => {
    if (!focused) {
      stopBeat();
      // Nothing to take back when the server was never told this screen was in focus.
      if (reported === true) send(false);
      return;
    }
    if (reported === true && timer) return;
    stopBeat();
    // No session: nothing beats until `sessionStarted` asks again. The same when it locks mid-way.
    if (!send(true)) return;
    timer = setInterval(() => {
      if (!send(true)) stopBeat();
    }, beatMs);
  };

  const unsubscribe = [
    appForegrounded.subscribe(() => set(true)),
    appBackgrounded.subscribe(() => set(false)),
    sessionStarted.subscribe(() => set(deps.active())),
    sessionEnded.subscribe(() => {
      stopBeat();
      reported = null;
    }),
  ];
  set(deps.active());

  return {
    /** For tests: drops the subscriptions and the heartbeat. */
    stop(): void {
      stopBeat();
      unsubscribe.forEach((off) => off());
    },
  };
}
