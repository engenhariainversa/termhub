import { useEffect, useState } from 'react';
import { tk, useTranslation } from '../i18n';
import { api } from '../lib/api';
import { askBrowserNotify, browserNotifyState, type BrowserNotifyState } from '../lib/concierge-notice';
import type { ConciergePushSettings } from '../lib/types';

const GROUP_CHOICES = [0, 2, 5, 10, 15, 30, 60];
const LEVELS: { key: 'needs_you' | 'done'; label: string; hint: string }[] = [
  { key: 'needs_you', label: tk('Precisa de você'), hint: tk('Uma pergunta, uma aprovação ou um erro que bloqueia.') },
  { key: 'done', label: tk('Concluído'), hint: tk('Aconteceu o que você pediu para acompanhar: build pronto, PR mesclado, versão publicada.') },
];
const BROWSER_STATE: Record<BrowserNotifyState, string> = {
  granted: tk('Ativas neste navegador.'),
  denied: tk('Bloqueadas neste navegador: libere nas permissões do site.'),
  default: tk('Ainda não ativadas neste navegador.'),
  unsupported: tk('Este navegador não mostra notificações.'),
};

const browserZone = (): string | undefined => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
};

/**
 * Configurações → Avisos (TER-1101): when the concierge writes on its own, which of its notices reach the
 * phone and this browser, quiet hours on the person's clock and the grouping of notices that come close
 * together. "Só para saber" never notifies. Every change is saved at once.
 */
export function ConciergeNoticesView() {
  const { t } = useTranslation();
  const [rules, setRules] = useState<ConciergePushSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [browser, setBrowser] = useState<BrowserNotifyState>(() => browserNotifyState());

  useEffect(() => {
    api.auth
      .conciergePush()
      .then((r) => setRules(r.concierge))
      .catch(() => setError(t('Não foi possível carregar os avisos.')));
  }, [t]);

  const save = (next: ConciergePushSettings) => {
    const before = rules;
    setRules(next);
    setError(null);
    api.auth
      .setConciergePush(next, browserZone())
      .then((r) => setRules(r.concierge))
      .catch(() => {
        setRules(before);
        setError(t('Não foi possível salvar. Tente de novo.'));
      });
  };

  if (!rules) return <p className="text-sm text-fg-muted">{error ?? t('Carregando…')}</p>;
  const quiet = rules.quiet_start !== null;
  return (
    <div className="space-y-4">
      <p className="text-sm text-fg-muted">
        {t('Quando o concierge escreve sozinho (um acompanhamento, um lembrete, um resumo), ele avisa no celular e neste navegador conforme o nível. "Só para saber" fica só no chat.')}
      </p>
      <section aria-label={t('Níveis')} className="space-y-3 rounded-lg border border-line bg-bg-2 p-4">
        {LEVELS.map((l) => (
          <label key={l.key} className="flex items-start gap-3">
            <input type="checkbox" className="mt-1" checked={rules[l.key]} onChange={(e) => save({ ...rules, [l.key]: e.target.checked })} />
            <span>
              <span className="block text-sm font-medium">{t(l.label)}</span>
              <span className="block text-xs text-fg-muted">{t(l.hint)}</span>
            </span>
          </label>
        ))}
      </section>
      <section aria-label={t('Horário de silêncio')} className="space-y-3 rounded-lg border border-line bg-bg-2 p-4">
        <label className="flex items-center gap-3">
          <input type="checkbox" checked={quiet} onChange={(e) => save({ ...rules, quiet_start: e.target.checked ? '22:00' : null, quiet_end: e.target.checked ? '07:00' : null })} />
          <span className="text-sm font-medium">{t('Horário de silêncio')}</span>
        </label>
        {quiet && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>{t('De')}</span>
            <input type="time" aria-label={t('Início do silêncio')} className="input w-auto" value={rules.quiet_start ?? ''} onChange={(e) => e.target.value && save({ ...rules, quiet_start: e.target.value })} />
            <span>{t('até')}</span>
            <input type="time" aria-label={t('Fim do silêncio')} className="input w-auto" value={rules.quiet_end ?? ''} onChange={(e) => e.target.value && save({ ...rules, quiet_end: e.target.value })} />
          </div>
        )}
        <p className="text-xs text-fg-muted">{t('No seu fuso. O que chegar nesse horário vai num aviso só quando ele acabar.')}</p>
      </section>
      <section aria-label={t('Agrupamento')} className="space-y-2 rounded-lg border border-line bg-bg-2 p-4">
        <label className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">{t('Juntar avisos em')}</span>
          <select className="input w-auto" value={rules.group_minutes} onChange={(e) => save({ ...rules, group_minutes: Number(e.target.value) })}>
            {GROUP_CHOICES.map((m) => (
              <option key={m} value={m}>
                {m === 0 ? t('Não juntar') : t('{{count}} min', { count: m })}
              </option>
            ))}
          </select>
        </label>
        <p className="text-xs text-fg-muted">{t('Depois de um aviso, o que vier nesse intervalo sai junto num só. "Precisa de você" não espera.')}</p>
      </section>
      <section aria-label={t('Notificações do navegador')} className="space-y-2 rounded-lg border border-line bg-bg-2 p-4">
        <h3 className="text-sm font-medium">{t('Notificações do navegador')}</h3>
        <p className="text-xs text-fg-muted">{t(BROWSER_STATE[browser])}</p>
        {browser === 'default' && (
          <button type="button" className="btn-ghost" onClick={() => void askBrowserNotify().then(setBrowser)}>
            {t('Ativar neste navegador')}
          </button>
        )}
      </section>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
