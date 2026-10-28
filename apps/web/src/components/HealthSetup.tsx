import { tk, useTranslation } from '../i18n';
import type { HealthSignal, ProjectHealthSetup } from '../lib/types';

/** pt-BR keys, in the order the Setup lists them; `light`: also runs without automatic work. */
const SIGNALS: { key: HealthSignal; label: string; light?: boolean }[] = [
  { key: 'pr_ready', label: tk('PR verde sem merge') },
  { key: 'base_red', label: tk('Branch base vermelha ou sem terminar') },
  { key: 'queue_stalled', label: tk('Fila do automático sem iniciar cards') },
  { key: 'card_orphan', label: tk('Card em andamento sem aba nem execução') },
  { key: 'run_blocked', label: tk('Execução bloqueada sem resposta') },
  { key: 'delivery_failed', label: tk('Deploy ou release com falha') },
  { key: 'agent_outdated', label: tk('Agente abaixo do mínimo') },
  { key: 'tab_stuck', label: tk('Aba "trabalhando" sem nenhum evento'), light: true },
  { key: 'tab_waiting', label: tk('Aba esperando resposta (pergunta, permissão, confiança, login)'), light: true },
  { key: 'machine_offline', label: tk('Máquina offline com trabalho do projeto'), light: true },
];

/**
 * TER-1121: the project's health watcher in the Setup. Each sign has a switch and the minutes it waits before it
 * counts; quiet hours and push levels are the person's own notice settings, not repeated here.
 */
export function HealthSetup({ value, onChange }: { value: ProjectHealthSetup; onChange: (next: ProjectHealthSetup) => void }) {
  const { t } = useTranslation();
  const signal = (key: HealthSignal, patch: Partial<ProjectHealthSetup['signals'][HealthSignal]>) => onChange({ ...value, signals: { ...value.signals, [key]: { ...value.signals[key], ...patch } } });
  return (
    <section className="rounded-lg border border-line bg-bg-2 p-4">
      <h3 className="text-sm font-semibold">{t('Saúde do projeto')}</h3>
      <p className="mb-3 text-xs text-fg-dim">
        {t('O termhub percebe sozinho quando o trabalho para e avisa: um push quando só você pode destravar e o concierge do projeto acordado para resolver o resto. Abas e máquinas valem em todo projeto; o resto, só com o automático ligado. Horário de silêncio e níveis de push seguem os seus avisos do concierge.')}
      </p>
      <label className="flex items-center gap-2 text-sm text-fg-muted">
        <input type="checkbox" checked={value.enabled} onChange={(e) => onChange({ ...value, enabled: e.target.checked })} className="accent-accent" />
        {t('Vigiar a saúde do projeto')}
      </label>
      {value.enabled && (
        <ul className="mt-3 divide-y divide-line">
          {SIGNALS.map(({ key, label, light }) => (
            <li key={key} className="flex flex-wrap items-center gap-3 py-2">
              <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                <input type="checkbox" checked={value.signals[key].enabled} onChange={(e) => signal(key, { enabled: e.target.checked })} className="accent-accent" />
                <span>{t(label)}</span>
                {!light && <span className="text-xs text-fg-dim">{t('(com o automático)')}</span>}
              </label>
              <label className="flex items-center gap-1 text-xs text-fg-dim">
                {t('depois de')}
                <input
                  type="number"
                  min={5}
                  max={10080}
                  className="input w-20"
                  value={value.signals[key].minutes}
                  disabled={!value.signals[key].enabled}
                  onChange={(e) => signal(key, { minutes: Math.max(5, Math.min(10080, Math.round(Number(e.target.value) || 5))) })}
                />
                {t('min')}
              </label>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
