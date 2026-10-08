import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from '../i18n';
import { refreshAiLoginStatus } from '../lib/ai-login-status';
import { api, ApiError } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { formatTime } from '../lib/format';
import type { AiLoginStart, AiLoginStuckTab, AiProvider } from '../lib/types';
import { Modal } from './Modal';

/** The CLI behind each provider, as the person knows it (the warnings say "o login do Codex", not "do ChatGPT"). */
export const AI_CLI_LABEL: Record<AiProvider, string> = { claude: 'Claude', chatgpt: 'Codex', gemini: 'Gemini', antigravity: 'Antigravity' };

/** What to run by hand where the modal cannot do it (Gemini, Antigravity, SSH or local machines). Commands, not copy. */
const MANUAL_LOGIN_COMMAND: Record<AiProvider, string> = { claude: 'claude auth login', chatgpt: 'codex login', gemini: 'gemini', antigravity: 'agy' };

export interface AiLoginTarget {
  account_id: string;
  label: string;
  provider: AiProvider;
  machine_name: string | null;
  /** false: the modal only explains how to log in by hand */
  supported: boolean;
}

type Phase =
  | { kind: 'manual' }
  | { kind: 'starting' }
  | { kind: 'ready'; flow: AiLoginStart; notice: string | null }
  | { kind: 'verifying'; flow: AiLoginStart }
  | { kind: 'success'; stuck: AiLoginStuckTab[] }
  /** `message`: what went wrong, in the person's words; `detail`: the CLI's own output, behind a toggle */
  | { kind: 'error'; message: string; detail: string | null };

type Resume = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; count: number } | { kind: 'error'; message: string };

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);
/** A MACHINE_FAILED answer carries what the CLI printed: shown as a detail, never as the error itself. */
const cliOutput = (err: unknown): string | null => (err instanceof ApiError && err.code === 'MACHINE_FAILED' ? err.message : null);

/**
 * "Refazer login" of an AI account (TER-1047): the server runs the CLI's login in a hidden session on the
 * machine; here the person opens the provider's page and, for Claude, pastes the code it shows (Codex
 * only needs "Já autorizei"). The pasted code lives only in the input's state and is cleared on submit.
 * The CLI may also finish on its own, through the machine's own browser (TER-1054): the start then answers
 * logged in, or, after the link showed, "Já entrei pelo navegador da máquina" checks without a code.
 * Closing before the end cancels the flow on the machine and re-reads the login state.
 */
export function AiLoginDialog({ account, onClose, onLoggedIn }: { account: AiLoginTarget; onClose: () => void; onLoggedIn?: () => void }) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>(account.supported ? { kind: 'starting' } : { kind: 'manual' });
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  const [resume, setResume] = useState<Resume>({ kind: 'idle' });
  /** the flow still open on the machine: cancelled when the dialog goes away before it ends */
  const active = useRef<string | null>(null);
  const mounted = useRef(true);
  /** bumped by every start and by unmounting: an answer to an older start is cancelled, not shown */
  const generation = useRef(0);
  const id = account.account_id;

  const cancelActive = useCallback(() => {
    const loginId = active.current;
    active.current = null;
    // The server asks the machine again once the flow is cancelled: a login finished elsewhere clears the warning.
    if (loginId) void api.aiAccounts.cancelLogin(id, loginId).then(refreshAiLoginStatus, () => undefined);
  }, [id]);

  const loggedIn = useCallback(
    (stuck: AiLoginStuckTab[]) => {
      active.current = null;
      setPhase({ kind: 'success', stuck });
      void refreshAiLoginStatus();
      onLoggedIn?.();
    },
    [onLoggedIn],
  );

  const start = useCallback(async () => {
    cancelActive();
    const mine = ++generation.current;
    setPhase({ kind: 'starting' });
    setCode('');
    try {
      const flow = await api.aiAccounts.startLogin(id);
      if (mine !== generation.current) {
        // closed (or started again) while the machine was still opening it
        void api.aiAccounts.cancelLogin(id, flow.login_id).catch(() => undefined);
        return;
      }
      if (flow.logged_in) {
        // the CLI finished on its own, in the machine's browser: nothing left to open
        loggedIn(flow.stuck_tabs);
        return;
      }
      active.current = flow.login_id;
      setPhase({ kind: 'ready', flow, notice: null });
    } catch (err) {
      if (mine !== generation.current) return;
      const detail = cliOutput(err);
      setPhase({ kind: 'error', message: detail ? t('Não deu para abrir o login na máquina') : errorText(err, t('Erro ao abrir o login')), detail });
    }
  }, [cancelActive, id, loggedIn, t]);

  useEffect(() => {
    mounted.current = true;
    if (account.supported) void start();
    return () => {
      mounted.current = false;
      generation.current++;
      cancelActive();
    };
    // one flow per opening of the dialog (`start` and `account` are fixed for it)
  }, []);

  const close = () => {
    cancelActive();
    onClose();
  };

  /** `withoutCode`: a Claude login the person finished in the machine's own browser, so there is no code to send. */
  const submit = async (flow: AiLoginStart, e?: FormEvent, withoutCode = false) => {
    e?.preventDefault();
    const sent = flow.needs_code && !withoutCode ? code.trim() : null;
    if (flow.needs_code && !withoutCode && !sent) return;
    setCode('');
    setPhase({ kind: 'verifying', flow });
    try {
      const r = await api.aiAccounts.submitLogin(id, flow.login_id, sent);
      if (!mounted.current) return;
      if (r.ok) {
        loggedIn(r.stuck_tabs);
      } else if (!flow.needs_code) {
        // Codex keeps polling on the machine: the person may just not have finished on the page yet
        setPhase({ kind: 'ready', flow, notice: r.message ?? t('O login ainda não foi confirmado') });
      } else {
        // Claude's flow ends with a wrong or expired code
        active.current = null;
        setPhase({ kind: 'error', message: t('O login não foi confirmado'), detail: r.message });
      }
    } catch (err) {
      if (!mounted.current) return;
      if (err instanceof ApiError && err.status === 404) active.current = null;
      const detail = cliOutput(err);
      setPhase({ kind: 'error', message: detail ? t('O login não foi confirmado') : errorText(err, t('Erro ao confirmar o login')), detail });
    }
  };

  const resumeTabs = async (tabs: AiLoginStuckTab[]) => {
    setResume({ kind: 'busy' });
    try {
      const r = await api.aiAccounts.resumeAfterLogin(id, tabs.map((x) => x.id));
      if (mounted.current) setResume({ kind: 'done', count: r.resumed.length });
    } catch (err) {
      if (mounted.current) setResume({ kind: 'error', message: errorText(err, t('Erro ao retomar as abas')) });
    }
  };

  const copyCode = async (value: string) => {
    if (await copyText(value)) {
      setCopied(true);
      window.setTimeout(() => mounted.current && setCopied(false), 1500);
    }
  };

  const machine = account.machine_name ?? t('Máquina desconhecida');

  return (
    <Modal title={t('Refazer login')} open onClose={close} dismissible={phase.kind !== 'verifying'}>
      <p className="mb-4 text-xs text-fg-muted">{t('{{provider}} · {{account}} em {{machine}}', { provider: AI_CLI_LABEL[account.provider], account: account.label, machine })}</p>

      {phase.kind === 'manual' && (
        <div className="space-y-2 text-sm">
          <p>{t('Abra um terminal nessa máquina e rode o login da CLI:')}</p>
          <code className="block rounded border border-line bg-bg px-2 py-1.5 font-mono text-xs">{MANUAL_LOGIN_COMMAND[account.provider]}</code>
          <div className="flex justify-end pt-2">
            <button type="button" className="btn-ghost" onClick={close}>
              {t('Fechar')}
            </button>
          </div>
        </div>
      )}

      {(phase.kind === 'starting' || phase.kind === 'verifying') && (
        <p role="status" className="flex items-center gap-2 text-sm text-fg-muted">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-fg-dim border-t-transparent" aria-hidden />
          {phase.kind === 'starting' ? t('Abrindo o login na máquina…') : t('Confirmando o login…')}
        </p>
      )}

      {phase.kind === 'ready' && (
        <div className="space-y-4 text-sm">
          <div>
            <a href={phase.flow.url ?? undefined} target="_blank" rel="noopener noreferrer" className="btn-primary inline-block">
              {t('Abrir página de login')}
            </a>
            <p className="mt-1.5 text-xs text-fg-dim">{t('O link expira às {{time}}', { time: formatTime(phase.flow.expires_at) })}</p>
          </div>

          {!phase.flow.needs_code && phase.flow.user_code && (
            <div>
              <p className="text-xs text-fg-muted">{t('Digite este código na página')}</p>
              <div className="mt-1 flex items-center gap-2">
                <code className="select-all rounded border border-line bg-bg px-3 py-1.5 font-mono text-2xl tracking-widest" data-testid="ai-login-device-code">
                  {phase.flow.user_code}
                </code>
                <button type="button" className="btn-ghost text-xs" onClick={() => void copyCode(phase.flow.user_code!)}>
                  {copied ? t('Copiado') : t('Copiar')}
                </button>
              </div>
            </div>
          )}

          {phase.notice && <p className="text-xs text-warn">{phase.notice}</p>}

          {phase.flow.needs_code ? (
            <form className="space-y-2" onSubmit={(e) => void submit(phase.flow, e)}>
              <label className="label" htmlFor="ai-login-code">
                {t('Cole o código aqui')}
              </label>
              <input
                id="ai-login-code"
                className="input font-mono"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <div className="flex justify-end gap-2">
                <button type="button" className="btn-ghost" onClick={close}>
                  {t('Cancelar')}
                </button>
                <button type="submit" className="btn-primary" disabled={!code.trim()}>
                  {t('Enviar código')}
                </button>
              </div>
              <p className="text-xs text-fg-dim">
                {t('A página abriu na própria máquina e o login terminou lá?')}{' '}
                <button type="button" className="underline hover:text-fg" onClick={() => void submit(phase.flow, undefined, true)}>
                  {t('Já entrei pelo navegador da máquina')}
                </button>
              </p>
            </form>
          ) : (
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={close}>
                {t('Cancelar')}
              </button>
              <button type="button" className="btn-primary" onClick={() => void submit(phase.flow)}>
                {phase.notice ? t('Verificar de novo') : t('Já autorizei')}
              </button>
            </div>
          )}
        </div>
      )}

      {phase.kind === 'success' && (
        <div className="space-y-3 text-sm">
          <p className="text-ok">{t('Login refeito')}</p>
          {phase.stuck.length > 0 && resume.kind !== 'done' && (
            <div className="rounded border border-line bg-bg p-3">
              <p>{t('Retomar {{count}} abas?', { count: phase.stuck.length })}</p>
              <ul className="mt-1 list-disc pl-5 text-xs text-fg-muted">
                {phase.stuck.map((tab) => (
                  <li key={tab.id}>{tab.name}</li>
                ))}
              </ul>
              {resume.kind === 'error' && <p className="mt-2 text-xs text-danger">{resume.message}</p>}
              <div className="mt-3 flex justify-end gap-2">
                <button type="button" className="btn-ghost" onClick={close}>
                  {t('Agora não')}
                </button>
                <button type="button" className="btn-primary" disabled={resume.kind === 'busy'} onClick={() => void resumeTabs(phase.stuck)}>
                  {t('Retomar')}
                </button>
              </div>
            </div>
          )}
          {resume.kind === 'done' && <p className="text-fg-muted">{t('{{count}} abas retomadas', { count: resume.count })}</p>}
          {(phase.stuck.length === 0 || resume.kind === 'done') && (
            <div className="flex justify-end">
              <button type="button" className="btn-primary" onClick={close}>
                {t('Fechar')}
              </button>
            </div>
          )}
        </div>
      )}

      {phase.kind === 'error' && (
        <div className="space-y-3 text-sm">
          <p role="alert" className="text-danger">
            {phase.message}
          </p>
          {phase.detail && (
            <details className="text-xs text-fg-muted">
              <summary className="cursor-pointer select-none">{t('Saída da CLI')}</summary>
              <pre className="mt-1 whitespace-pre-wrap break-words rounded border border-line bg-bg px-2 py-1.5 font-mono">{phase.detail}</pre>
            </details>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={close}>
              {t('Fechar')}
            </button>
            <button type="button" className="btn-primary" onClick={() => void start()}>
              {t('Tentar de novo')}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
