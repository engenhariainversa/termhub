// The settings store (design spec §7): just `device` (`GET devices/self`) — biometrics, the
// host and the theme each already live in their own store (session, chat, theme); Ajustes reads
// those directly, this one only fills what nothing else holds. A factory over injected services,
// same shape as the other feature stores; `useSettingsStore.ts` builds the app's one instance.
import { create } from 'zustand';
import { sessionEnded } from '@/features/shared/signals';
import { i18n, t } from '@/i18n';
import type { TDeviceSelf } from '@/services/api/contract';
import { TERMHUB_URL } from '@/services/api/config';
import { ApiError } from '@/services/api/errors';
import type { Auth, MobileApi } from '@/services/api/types';
import { serverLabel } from '../model/server-label';

export interface SessionApi {
  auth(): Auth;
  handleApiError(err: unknown): boolean;
}

export interface SettingsDeps {
  api: MobileApi;
  session: () => SessionApi;
  /** The server's base URL; defaults to `TERMHUB_URL`. */
  baseUrl?: string;
}

export interface SettingsState {
  /** The api singleton's own mode (design spec §2): `Ajustes`'s "Versão" section reads this,
   * not the global `api` module, so a screen test can inject a mock instance and see it. */
  mode: 'mock' | 'http';
  /** "Servidor: mock" or "Servidor: <host of TERMHUB_URL>", from `mode` above. */
  server: string;
  device: TDeviceSelf | null;
  loadingDevice: boolean;
  error: string | null;
  loadDevice(): Promise<void>;
  /** "Enviar notificação de teste" (TER-913): in flight, then what happened. */
  pushTest: { sending: boolean; note: string | null; error: string | null };
  sendTestPush(): Promise<void>;
  /** "Avisar quando uma aba terminar" (TER-925), per account; `null` until loaded. */
  tabFinished: boolean | null;
  pushSettingsError: string | null;
  loadPushSettings(): Promise<void>;
  setTabFinished(on: boolean): Promise<void>;
}

/** Time to close the app before the test push is sent. */
export const PUSH_TEST_DELAY_SECONDS = 10;

const networkMsg = () => t('Não foi possível falar com o servidor. Tente de novo.');

export function createSettingsStore(deps: SettingsDeps) {
  const { api, session } = deps;
  const server = () => serverLabel(api.mode, deps.baseUrl ?? TERMHUB_URL);
  let generation = 0;

  const store = create<SettingsState>()((set) => ({
    mode: api.mode,
    server: server(),
    device: null,
    loadingDevice: false,
    error: null,
    pushTest: { sending: false, note: null, error: null },
    tabFinished: null,
    pushSettingsError: null,

    async loadPushSettings() {
      const gen = generation;
      try {
        const { tab_finished } = await api.pushSettings(session().auth());
        if (gen === generation) set({ tabFinished: tab_finished, pushSettingsError: null });
      } catch (e) {
        if (gen !== generation || session().handleApiError(e)) return;
        set({ pushSettingsError: e instanceof ApiError ? e.message : networkMsg() });
      }
    },

    async setTabFinished(on) {
      const before = store.getState().tabFinished;
      set({ tabFinished: on, pushSettingsError: null });
      try {
        const { tab_finished } = await api.setPushSettings(session().auth(), { tab_finished: on });
        set({ tabFinished: tab_finished });
      } catch (e) {
        set({ tabFinished: before });
        if (session().handleApiError(e)) return;
        set({ pushSettingsError: e instanceof ApiError ? e.message : networkMsg() });
      }
    },

    async loadDevice() {
      const gen = generation;
      set({ loadingDevice: true, error: null });
      try {
        const device = await api.deviceSelf(session().auth());
        if (gen !== generation) return;
        set({ device, loadingDevice: false });
      } catch (e) {
        if (gen !== generation) return;
        if (session().handleApiError(e)) return;
        set({ loadingDevice: false, error: e instanceof ApiError ? e.message : networkMsg() });
      }
    },

    async sendTestPush() {
      set({ pushTest: { sending: true, note: null, error: null } });
      try {
        await api.pushTest(session().auth(), { kind: 'confirmation', delay_seconds: PUSH_TEST_DELAY_SECONDS });
        set({ pushTest: { sending: false, note: t('Enviada. Ela chega em {{seconds}} s.', { seconds: PUSH_TEST_DELAY_SECONDS }), error: null } });
      } catch (e) {
        if (session().handleApiError(e)) return set({ pushTest: { sending: false, note: null, error: null } });
        set({ pushTest: { sending: false, note: null, error: e instanceof ApiError ? e.message : networkMsg() } });
      }
    },
  }));

  sessionEnded.subscribe(() => {
    generation++;
    store.setState({ device: null, loadingDevice: false, error: null, pushTest: { sending: false, note: null, error: null }, tabFinished: null, pushSettingsError: null });
  });

  // The label is copy ("Servidor: …"): it follows a language change.
  i18n.on('languageChanged', () => store.setState({ server: server() }));

  return store;
}
