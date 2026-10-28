import { useState } from 'react';
import { CLAUDE_MODEL_ALIASES } from '@termhub/mobile-api/models';
import { i18n, useTranslation } from '../../i18n';
import { api, ApiError } from '../../lib/api';
import type { ChatMemory } from '../../lib/types';

/**
 * "Modelos do concierge" (TER-1145): the Claude families the concierge never runs on — "Nunca usar Fable"
 * first, the ready-made answer to the Fable weekly allowance. Saved on each click; one family always stays
 * allowed. Only the chat obeys it: the tabs' agents keep the project's model.
 */
export function ConciergeModelsField({ memory, onSaved }: { memory: ChatMemory; onSaved: (next: ChatMemory) => void }) {
  const { t } = useTranslation();
  const blocked = memory.blocked_models ?? [];
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (family: string) => {
    const next = blocked.includes(family) ? blocked.filter((f) => f !== family) : [...blocked, family];
    setSaving(true);
    setError(null);
    try {
      onSaved(await api.setChatMemory({ blocked_models: next }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : i18n.t('Não foi possível salvar os modelos do concierge'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <fieldset className="mt-3 rounded-lg border border-line bg-bg-2 p-3">
      <legend className="sr-only">{t('Modelos do concierge')}</legend>
      <span className="text-sm text-fg">{t('Modelos do concierge')}</span>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {CLAUDE_MODEL_ALIASES.map((family) => {
          const checked = blocked.includes(family);
          // The last allowed family cannot be ruled out: the concierge has to run on something.
          const last = !checked && blocked.length >= CLAUDE_MODEL_ALIASES.length - 1;
          return (
            <label key={family} className="flex items-center gap-1.5 text-sm text-fg">
              <input type="checkbox" checked={checked} disabled={saving || last} onChange={() => void toggle(family)} />
              {t('Nunca usar {{model}}', { model: family })}
            </label>
          );
        })}
      </div>
      <p className="mt-1 text-xs text-fg-dim">
        {t('O concierge nunca sobe nesses modelos: quando o modelo do projeto ou o padrão da CLI for um deles, ele usa o próximo liberado (opus, sonnet, haiku), também ao trocar de conta por limite. Os agentes das abas não mudam.')}
      </p>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </fieldset>
  );
}
