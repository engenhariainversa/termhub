import { useTranslation } from '../../i18n';
import { useId, useState } from 'react';
import type { AutoDecision, ChatAction } from '../../lib/types';
import { autoAnswerReason } from './tab-question-text';

/** Mirrors `actionAutoDecision` (packages/mobile-api): the precedent a send cited, only when the call
 * also ran without a click (`grant_id`: a default allowance or a grant). A pending card, or one the
 * person approved by hand, is never an automatic decision (TER-641). */
export function actionAutoDecision(action: ChatAction): AutoDecision | null {
  if (!action.auto_decision || !action.grant_id || action.status === 'pending') return null;
  return action.auto_decision;
}

/** Mirrors `autoDecisionSourceLine` (packages/mobile-api): a decision of the person's reads as its
 * question and answer, anything else as the bare ref. */
export function autoDecisionSourceLine(source: AutoDecision['sources'][number]): string {
  if (source.question === null) return source.ref;
  return source.answer ? `«${source.question}» → ${source.answer}` : `«${source.question}»`;
}

/**
 * "Decisão automática" (TER-641): marks what the concierge sent a tab on its own, from memory. The badge
 * toggles the detail — the reason and each cited ref with the recorded question and answer — so the
 * person sees at a glance what was decided without them. Plain text only: everything here came from
 * the model or the person's own history.
 */
export function AutoDecisionBadge({ decision }: { decision: AutoDecision }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const reason = decision.by ? autoAnswerReason(decision) : decision.reason;
  return (
    <div className="mt-1 text-xs">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        title={reason ?? t('Decidido com base na memória')}
        className="inline-flex items-center rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 font-medium text-accent hover:bg-accent/20"
        onClick={() => setOpen((v) => !v)}
      >
        {t('Decisão automática')}
      </button>
      {open && (
        <div id={detailId} className="mt-1 space-y-0.5 text-fg-dim">
          {reason && <p className="whitespace-pre-wrap">{t('Motivo: {{reason}}', { reason })}</p>}
          {decision.sources.length > 0 && (
            <>
              <p>{t('Com base em:')}</p>
              <ul className="list-inside list-disc">
                {decision.sources.map((s) => (
                  <li key={s.ref} className="whitespace-pre-wrap">
                    {autoDecisionSourceLine(s)} <span className="font-mono text-[10px]">({s.ref})</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
