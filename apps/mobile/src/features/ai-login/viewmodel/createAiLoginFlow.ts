// One "Refazer login" flow (TER-1047, spec 2026-10-08 §2–3): one store per open modal, for one account.
//
//   starting → open (the page to open; Claude: paste the code, Codex: "Já autorizei") → verifying
//            → done (then "Retomar N abas?") | failed ("Tentar de novo" starts over)
//
// A Codex "Já autorizei" that is not ok yet goes back to `open` with the reason, so the person can try
// again; a Claude code that is not ok ends the flow on the server, so it is `failed`. `close()` (the modal
// goes) cancels a flow that has not ended, and every late answer is dropped once closed. The code is never
// kept in the store: the screen's input owns it until it is sent.
import { create } from 'zustand';
import type { AiLoginStartResponse, AiLoginStuckTab } from '@/services/api/contract';
import { ApiError } from '@/services/api/errors';
import type { Auth, MobileApi } from '@/services/api/types';
import { AI_LOGIN_MSG } from '../model/ai-login';

export interface AiLoginFlowDeps {
  api: Pick<MobileApi, 'startAiLogin' | 'submitAiLogin' | 'cancelAiLogin' | 'resumeAiLoginTabs'>;
  session: () => { auth(): Auth; handleApiError(err: unknown): boolean };
  accountId: string;
  /** The login ended well: the status store drops the account's banner. */
  onLoggedIn?(accountId: string): void;
}

export type AiLoginPhase = 'idle' | 'starting' | 'open' | 'verifying' | 'done' | 'failed';

/** After a login that ended well: whether to type `continue` into the tabs stuck on the login error. */
export type ResumeState = 'none' | 'ask' | 'resuming' | 'resumed' | 'skipped';

export interface AiLoginFlowState {
  phase: AiLoginPhase;
  /** The flow the server started: the page to open, Codex's device code. Null outside a flow. */
  login: AiLoginStartResponse | null;
  /** Why the last step failed (the server's own sentence when it gave one). */
  error: string | null;
  stuckTabs: AiLoginStuckTab[];
  resume: ResumeState;
  resumed: number;
  resumeError: string | null;

  /** Starts (or starts over) the flow on the machine. */
  start(): Promise<void>;
  /** Claude: the pasted code; Codex: `null`. */
  submit(code: string | null): Promise<void>;
  resumeTabs(): Promise<void>;
  skipResume(): void;
  /** The modal goes: a flow that has not ended is cancelled on the server. Idempotent. */
  close(): void;
}

const failure = (e: unknown): string => (e instanceof ApiError ? e.message : AI_LOGIN_MSG.network);

export function createAiLoginFlow(deps: AiLoginFlowDeps) {
  const { api, session, accountId } = deps;
  let closed = false;
  // Bumped by every `start()` and by `close()`: an answer for an older attempt never lands.
  let attempt = 0;

  const cancelOnServer = (loginId: string) => {
    try {
      void api.cancelAiLogin(session().auth(), accountId, loginId).catch(() => undefined);
    } catch {
      // locked: the server's 15 minutes end it anyway
    }
  };

  const store = create<AiLoginFlowState>()((set, get) => ({
    phase: 'idle',
    login: null,
    error: null,
    stuckTabs: [],
    resume: 'none',
    resumed: 0,
    resumeError: null,

    async start() {
      if (closed) return;
      const previous = get().login;
      if (previous && (get().phase === 'open' || get().phase === 'verifying')) cancelOnServer(previous.login_id);
      const mine = ++attempt;
      set({ phase: 'starting', login: null, error: null, stuckTabs: [], resume: 'none', resumed: 0, resumeError: null });
      try {
        const login = await api.startAiLogin(session().auth(), accountId);
        if (closed || mine !== attempt) {
          // The modal went (or started over) while the machine was opening this one.
          cancelOnServer(login.login_id);
          return;
        }
        set({ phase: 'open', login });
      } catch (e) {
        if (closed || mine !== attempt || session().handleApiError(e)) return;
        set({ phase: 'failed', error: failure(e) });
      }
    },

    async submit(code) {
      const { login, phase } = get();
      if (closed || !login || phase !== 'open') return;
      const sent = login.needs_code ? (code ?? '').trim() : null;
      if (login.needs_code && !sent) return;
      const mine = attempt;
      set({ phase: 'verifying', error: null });
      try {
        const res = await api.submitAiLogin(session().auth(), accountId, login.login_id, sent);
        if (closed || mine !== attempt) return;
        if (res.ok) {
          set({ phase: 'done', login: null, stuckTabs: res.stuck_tabs, resume: res.stuck_tabs.length > 0 ? 'ask' : 'none' });
          deps.onLoggedIn?.(accountId);
        } else if (login.needs_code) {
          // Claude: the session on the machine is gone; only a new start helps.
          set({ phase: 'failed', login: null, error: res.message ?? AI_LOGIN_MSG.failed });
        } else {
          // Codex: still polling on the machine; "Já autorizei" again once the page says so.
          set({ phase: 'open', error: res.message ?? AI_LOGIN_MSG.failed });
        }
      } catch (e) {
        if (closed || mine !== attempt || session().handleApiError(e)) return;
        // The flow may have expired or ended on the server: start over.
        set({ phase: 'failed', login: null, error: failure(e) });
      }
    },

    async resumeTabs() {
      const { stuckTabs, resume } = get();
      if (closed || resume !== 'ask') return;
      set({ resume: 'resuming', resumeError: null });
      try {
        const res = await api.resumeAiLoginTabs(session().auth(), accountId, stuckTabs.map((tab) => tab.id));
        if (closed) return;
        set({ resume: 'resumed', resumed: res.resumed.length });
      } catch (e) {
        if (closed || session().handleApiError(e)) return;
        set({ resume: 'ask', resumeError: failure(e) });
      }
    },

    skipResume() {
      if (get().resume === 'ask') set({ resume: 'skipped' });
    },

    close() {
      if (closed) return;
      closed = true;
      attempt++;
      const { login, phase } = get();
      if (login && (phase === 'open' || phase === 'verifying')) cancelOnServer(login.login_id);
    },
  }));

  return store;
}

export type AiLoginFlowStore = ReturnType<typeof createAiLoginFlow>;
