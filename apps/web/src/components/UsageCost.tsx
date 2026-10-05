import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { formatCost, formatTokens, hasTokens } from '../lib/automation-usage';
import type { AutomationUsageLine, Task } from '../lib/types';
import { useTranslation } from '../i18n';

/** "US$ 1,23 · 1,2 mi tokens", the estimate's caveat in the title. Nothing when no token was counted. */
export function UsageCost({ line, className = '' }: { line: AutomationUsageLine | undefined; className?: string }) {
  const { t } = useTranslation();
  if (!line || !hasTokens(line)) return null;
  return (
    <span className={`text-xs text-zinc-500 ${className}`} title={t('Estimativa em preço de API (equivalente em API); contas de assinatura não pagam por token.')}>
      {t('custo {{cost}} · {{tokens}} tokens', { cost: formatCost(line.cost_usd), tokens: formatTokens(line) })}
    </span>
  );
}

/**
 * A card's (or an epic's) estimated cost in its editor (spec D23). Asked only for cards tagged "automático":
 * only automatic tabs are metered, so nobody else pays for the request.
 */
export function CardUsageCost({ task }: { task: Task }) {
  const { t } = useTranslation();
  const [line, setLine] = useState<AutomationUsageLine | undefined>(undefined);
  useEffect(() => {
    if (!task.auto) return;
    let alive = true;
    (async () => {
      try {
        const usage = await api.automation.usage(task.project_id);
        if (!alive) return;
        setLine(task.type === 'epic' ? usage.epics.find((e) => e.epic_id === task.id) : usage.cards.find((c) => c.task_id === task.id));
      } catch {
        // no cost to show
      }
    })();
    return () => {
      alive = false;
    };
  }, [task.id, task.project_id, task.type, task.auto]);
  if (!line || !hasTokens(line)) return null;
  return (
    <div className="space-y-1">
      <h3 className="text-xs font-medium uppercase text-zinc-500">{task.type === 'epic' ? t('Custo do épico') : t('Custo do card')}</h3>
      <UsageCost line={line} />
    </div>
  );
}
