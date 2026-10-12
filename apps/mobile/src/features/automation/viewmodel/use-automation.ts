// The view-model of "Trabalho automático" (spec 2026-10-04): loads the project's block, keeps the edit and
// saves it. Turning it on, or raising the level to Deploy or Publicação, asks first (a confirmation with
// the web's copy); the server then answers 401 PIN_REQUIRED and the PIN sheet opens, one PIN entry for the
// save. Lowering the level or turning off saves at once. Local state, like the project AI screen.
import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@/i18n';
import { automationSetupActionId, type TAutomationSetup } from '@/services/api/contract';
import { ApiError } from '@/services/api/errors';
import type { Auth, MobileApi } from '@/services/api/types';
import type { SessionState } from '@/features/session/model/session.types';
import { AUTOMATION_MSG, autonomyConfirmText, deviceTimeZone, isChanged, needsConfirm, summaryHourOf } from '../model/automation';

export interface AutomationDeps {
  api: Pick<MobileApi, 'getAutomationSetup' | 'saveAutomationSetup'>;
  session: () => { auth(): Auth; handleApiError(err: unknown): boolean; requestPinProof: SessionState['requestPinProof'] };
}

export interface AutomationView {
  saved: TAutomationSetup | null;
  draft: TAutomationSetup | null;
  loading: boolean;
  loadError: string | null;
  saving: boolean;
  saveError: string | null;
  notice: string | null;
  /** The confirmation text the sheet shows, or null when none is open. */
  confirming: string | null;
  canSave: boolean;
  load(): Promise<void>;
  edit(change: (draft: TAutomationSetup) => TAutomationSetup): void;
  /** "Salvar": saves, or opens the confirmation first when the change turns it on or raises the level. */
  save(): Promise<void>;
  /** "Confirmar" on the sheet: saves; the PIN sheet follows when the server asks. */
  confirm(): Promise<void>;
  cancelConfirm(): void;
}

const failure = (e: unknown): string => (e instanceof ApiError ? e.message : t(AUTOMATION_MSG.network));

export function useAutomation(projectId: string, deps: AutomationDeps): AutomationView {
  const { api, session } = deps;
  const [saved, setSaved] = useState<TAutomationSetup | null>(null);
  const [draft, setDraft] = useState<TAutomationSetup | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, [projectId]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.getAutomationSetup(session().auth(), projectId);
      if (!alive.current) return;
      setSaved(res);
      setDraft(res);
    } catch (e) {
      if (!alive.current || session().handleApiError(e)) return;
      setLoadError(failure(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [api, session, projectId]);

  const edit = useCallback((change: (d: TAutomationSetup) => TAutomationSetup) => {
    setDraft((d) => (d === null ? d : change(d)));
    setNotice(null);
    setSaveError(null);
  }, []);

  const perform = useCallback(
    async (block: TAutomationSetup) => {
      setSaving(true);
      setSaveError(null);
      setNotice(null);
      const done = (res: TAutomationSetup) => {
        setSaved(res);
        setDraft(res);
        setNotice(t(AUTOMATION_MSG.saved));
      };
      // the daily summary runs on the person's own clock (spec D26): the zone travels with the hour (TER-974)
      const zone = summaryHourOf(block) !== null ? deviceTimeZone() : null;
      const send = (proof?: { challenge: string; pin_proof: string }) =>
        zone ? api.saveAutomationSetup(session().auth(), projectId, block, proof, zone) : proof ? api.saveAutomationSetup(session().auth(), projectId, block, proof) : api.saveAutomationSetup(session().auth(), projectId, block);
      try {
        try {
          done(await send());
        } catch (e) {
          if (!(e instanceof ApiError) || e.code !== 'PIN_REQUIRED') throw e;
          // The server is the judge of what needs the PIN: ask for it and save with the proof.
          await session().requestPinProof(
            automationSetupActionId(projectId),
            async (proof) => {
              const res = await send(proof);
              if (alive.current) done(res);
            },
            'automation_setup',
            t(AUTOMATION_MSG.pinTitle),
          );
        }
      } catch (e) {
        // The PIN sheet was closed (it says nothing), or the session relocked (it already said so).
        if (!alive.current || (e instanceof Error && e.message === 'CANCELLED') || session().handleApiError(e)) return;
        setSaveError(failure(e));
      } finally {
        if (alive.current) setSaving(false);
      }
    },
    [api, session, projectId],
  );

  const save = useCallback(async () => {
    if (saved === null || draft === null || !isChanged(saved, draft)) return;
    if (needsConfirm(saved, draft)) {
      setConfirming(autonomyConfirmText(draft.autonomy));
      return;
    }
    await perform(draft);
  }, [saved, draft, perform]);

  const confirm = useCallback(async () => {
    setConfirming(null);
    if (draft !== null) await perform(draft);
  }, [draft, perform]);

  const cancelConfirm = useCallback(() => setConfirming(null), []);

  return {
    saved,
    draft,
    loading,
    loadError,
    saving,
    saveError,
    notice,
    confirming,
    canSave: saved !== null && draft !== null && !saving && isChanged(saved, draft),
    load,
    edit,
    save,
    confirm,
    cancelConfirm,
  };
}
