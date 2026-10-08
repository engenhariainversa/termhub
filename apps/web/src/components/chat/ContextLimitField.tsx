import { useEffect, useState } from 'react';
import { i18n, useTranslation } from '../../i18n';
import { api, ApiError } from '../../lib/api';
import { parseContextLimit } from '../../lib/chat-context';
import type { ChatMemory } from '../../lib/types';

/**
 * "Limite de contexto do chat" (TER-1038): the chat's context meter measures against this many
 * thousand tokens instead of the model's window, and warns on it. Empty = the window (the default).
 * Saved on "Salvar" or Enter; the meter picks it up the next time the chat loads.
 */
export function ContextLimitField({ memory, onSaved }: { memory: ChatMemory; onSaved: (next: ChatMemory) => void }) {
  const { t } = useTranslation();
  const stored = memory.context_limit ?? null;
  const [text, setText] = useState(stored === null ? '' : String(Math.round(stored / 1_000)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(stored === null ? '' : String(Math.round(stored / 1_000))), [stored]);

  const parsed = parseContextLimit(text);
  const dirty = parsed !== undefined && parsed !== stored;

  const save = async () => {
    if (parsed === undefined) {
      setError(i18n.t('Use um número inteiro entre 10 e 10000 (mil tokens), ou deixe vazio.'));
      return;
    }
    if (!dirty) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(await api.setChatMemory({ context_limit: parsed }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : i18n.t('Não foi possível salvar o limite de contexto'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-line bg-bg-2 p-3">
      <label className="text-sm text-fg" htmlFor="chat-context-limit">
        {t('Limite de contexto do chat')}
      </label>
      <div className="mt-2 flex items-center gap-2">
        <input
          id="chat-context-limit"
          className="input w-28"
          inputMode="numeric"
          value={text}
          placeholder={t('janela')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
          }}
        />
        <span className="text-xs text-fg-dim">{t('mil tokens')}</span>
        <button type="button" className="btn-ghost text-xs" disabled={saving || (!dirty && parsed !== undefined)} onClick={() => void save()}>
          {saving ? t('Salvando…') : t('Salvar')}
        </button>
      </div>
      <p className="mt-1 text-xs text-fg-dim">
        {t('O medidor do chat mostra o contexto da conversa contra este limite (ex.: 200 = 200 mil tokens) e avisa a partir de 80% dele; o concierge usa o mesmo número para sugerir compactar. Vazio = a janela do modelo.')}
      </p>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}
