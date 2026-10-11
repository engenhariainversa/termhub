import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { formatCost, formatTokenCount, usageOf } from '../lib/automation-usage';
import type { ProgressUsage, Task } from '../lib/types';
import { useTranslation } from '../i18n';

/**
 * "custo US$ 1,23 · 1,2 mi tokens", the estimate's caveat in the title. A tab whose tokens cannot be read
 * (Codex) shows "custo —". Nothing when nothing was metered.
 */
export function UsageCost({ usage, className = '' }: { usage: ProgressUsage | null | undefined; className?: string }) {
  const { t } = useTranslation();
  if (!usage) return null;
  return (
    <span className={`text-xs text-zinc-500 ${className}`} title={t('Estimativa em preço de API (equivalente em API); contas de assinatura não pagam por token.')}>
      {usage.tokens > 0
        ? t('custo {{cost}} · {{tokens}} tokens', { cost: formatCost(usage.cost_usd), tokens: formatTokenCount(usage.tokens) })
        : t('custo {{cost}}', { cost: formatCost(usage.cost_usd) })}
    </span>
  );
}

/**
 * A card's (or an epic's) estimated cost in its editor (spec D23). Asked only for cards tagged "automático":
 * only automatic tabs are metered, so nobody else pays for the request.
 */
export function CardUsageCost({ task }: { task: Task }) {
  const { t } = useTranslation();
  const [usage, setUsage] = useState<ProgressUsage | null>(null);
  useEffect(() => {
    if (!task.auto) return;
    let alive = true;
    (async () => {
      try {
        const all = await api.automation.usage(task.project_id);
        if (!alive) return;
        const line = task.type === 'epic' ? all.epics.find((e) => e.epic_id === task.id) : all.cards.find((c) => c.task_id === task.id);
        setUsage(line ? usageOf(line) : null);
      } catch {
        // no cost to show
      }
    })();
    return () => {
      alive = false;
    };
  }, [task.id, task.project_id, task.type, task.auto]);
  if (!usage) return null;
  return (
    <div className="space-y-1">
      <h3 className="text-xs font-medium uppercase text-zinc-500">{task.type === 'epic' ? t('Custo do épico') : t('Custo do card')}</h3>
      <UsageCost usage={usage} />
    </div>
  );
}
