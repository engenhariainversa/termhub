import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useData } from '../lib/data';
import { formatDateTime } from '../lib/format';
import { i18n, useTranslation } from '../i18n';
import type { AiMemoryState, Machine } from '../lib/types';

export const AI_MEMORY_DEFAULT_URL = 'http://127.0.0.1:49374';

/** One line for what the machine reported: installed or not, version, server up or down. */
export function aiMemoryStateLine(s: Extract<AiMemoryState, { enabled: true }>): { text: string; warn: boolean } {
  if (!s.installed) return { text: i18n.t('ai-memory não encontrado nesta máquina (comando ai-memory fora do PATH).'), warn: true };
  const version = s.version ?? i18n.t('versão desconhecida');
  return s.server_up
    ? { text: i18n.t('ai-memory {{version}} instalado · servidor no ar em {{url}}', { version, url: s.url }), warn: false }
    : { text: i18n.t('ai-memory {{version}} instalado · servidor fora do ar em {{url}} (rode ai-memory serve)', { version, url: s.url }), warn: true };
}

/**
 * Machine form: "Usar ai-memory nesta máquina" (TER-1018), off by default. Off, the machine is never
 * asked anything; on, the card shows what the machine detected. Nothing ai-memory stores reaches termhub.
 */
export function AiMemoryCard({ machine }: { machine: Machine }) {
  const { t } = useTranslation();
  const { updateMachine } = useData();
  const [enabled, setEnabled] = useState(!!machine.ai_memory_enabled);
  const [savedUrl, setSavedUrl] = useState(machine.ai_memory_url ?? AI_MEMORY_DEFAULT_URL);
  const [url, setUrl] = useState(savedUrl);
  const [state, setState] = useState<AiMemoryState | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      setState(await api.machines.aiMemory(machine.id));
    } catch (e) {
      setState(null);
      setError(e instanceof ApiError ? e.message : t('Erro ao consultar'));
    } finally {
      setChecking(false);
    }
  }, [machine.id]);

  useEffect(() => {
    if (enabled) void check();
  }, [enabled, savedUrl, check]);

  const toggle = async (next: boolean) => {
    setEnabled(next);
    setError(null);
    if (!next) setState(null);
    try {
      await updateMachine(machine.id, { ai_memory_enabled: next });
    } catch (e) {
      setEnabled(!next);
      setError(e instanceof ApiError ? e.message : t('Erro ao salvar'));
    }
  };

  const saveUrl = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await updateMachine(machine.id, { ai_memory_url: url.trim() || null });
      const next = saved.ai_memory_url ?? AI_MEMORY_DEFAULT_URL;
      setUrl(next);
      setSavedUrl(next);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('Erro ao salvar'));
    } finally {
      setSaving(false);
    }
  };

  const line = state?.enabled ? aiMemoryStateLine(state) : null;
  return (
    <div className="rounded-md border border-line bg-bg p-2 text-xs">
      <label className="flex items-center gap-2 font-medium text-fg-muted">
        <input type="checkbox" checked={enabled} onChange={(e) => void toggle(e.target.checked)} />
        {t('Usar ai-memory nesta máquina')}
      </label>
      <p className="mt-1 text-fg-dim">
        {t('Detecta o ai-memory (memória local compartilhada entre Claude Code, Codex e outras CLIs) e o servidor dele nesta máquina. O que ele guarda fica na máquina: nada vai para o termhub.')}
      </p>
      {enabled && (
        <>
          <div className="mt-2 flex items-center gap-1">
            <label htmlFor={`ai-memory-url-${machine.id}`} className="shrink-0 text-fg-muted">
              {t('Servidor local')}
            </label>
            <input
              id={`ai-memory-url-${machine.id}`}
              className="input min-w-0 flex-1 py-0.5 font-mono text-xs"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={AI_MEMORY_DEFAULT_URL}
            />
            {url.trim() !== savedUrl && (
              <button type="button" className="btn-ghost border border-line px-2 py-0.5" onClick={() => void saveUrl()} disabled={saving}>
                {saving ? '…' : t('Salvar')}
              </button>
            )}
            <button type="button" className="btn-ghost px-2 py-0.5" onClick={() => void check()} disabled={checking}>
              {checking ? '…' : t('Verificar de novo')}
            </button>
          </div>
          <p className="mt-1 text-fg-dim">{t('Só endereços locais (127.0.0.1, localhost) ou de rede privada.')}</p>
          {checking && !state && <p className="mt-1 text-fg-dim">{t('Verificando…')}</p>}
          {line && (
            <p className={`mt-1 ${line.warn ? 'text-warn' : 'text-fg-muted'}`} title={state?.enabled ? formatDateTime(state.checked_at) : undefined}>
              {line.text}
            </p>
          )}
        </>
      )}
      {error && <p className="mt-1 text-danger">{error}</p>}
    </div>
  );
}
