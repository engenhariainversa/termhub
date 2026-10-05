import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { Machine, MachineHooks } from '../lib/types';
import { formatDateTime } from '../lib/format';
import { i18n, Trans, useTranslation } from '../i18n';

/**
 * What the machine's tabs are reporting, in one sentence. A tab only reaches the monitor once its
 * tool fired a hook, so "has tabs but none reporting" is the state that makes "Precisando de você"
 * (and the office view) look empty for someone who does have terminals open.
 */
export function monitorHealthNote(machine: Pick<Machine, 'tabs' | 'tabs_reporting'>, installed: boolean): { text: string; warn: boolean } {
  const tabs = machine.tabs ?? 0;
  const reporting = machine.tabs_reporting ?? 0;
  if (tabs === 0) return { text: i18n.t('Nenhuma tab de terminal nesta máquina ainda.'), warn: false };
  if (reporting === 0) {
    return {
      text: installed
        ? i18n.t('Nenhuma das {{count}} tabs reportou estado ainda: elas não aparecem em “Precisando de você”. O estado chega no primeiro hook — rode algo numa tab.', { count: tabs })
        : i18n.t('Nenhuma das {{count}} tabs reportou estado: sem os hooks instalados, elas não aparecem em “Precisando de você”.', { count: tabs }),
      warn: true,
    };
  }
  return { text: i18n.t('{{reporting}} de {{count}} tabs reportando estado ao monitor.', { reporting, count: tabs }), warn: false };
}

type HookResult = 'installed' | 'skipped';

/** What an install hooked, tool by tool (a Cursor status left out comes from an agent that predates it). */
export function hooksInstallNote(r: { claude: HookResult; claude_dirs?: string[]; codex: HookResult; cursor?: HookResult | 'agent_outdated' }): string {
  const missing = i18n.t('não encontrado');
  const found = (s: HookResult | undefined) => (s === 'installed' ? 'ok' : missing);
  const claude = r.claude === 'installed' ? `ok (${(r.claude_dirs ?? ['~/.claude']).join(', ')})` : missing;
  const codex = r.codex === 'installed' ? i18n.t('ok (abra o Codex uma vez e confie nos hooks)') : missing;
  const cursor = r.cursor === 'agent_outdated' ? i18n.t('atualize o agente (0.4.3 ou mais novo)') : found(r.cursor);
  return i18n.t('Claude Code: {{claude}} · Codex: {{codex}} · Cursor CLI: {{cursor}}. Vale para sessões abertas a partir de agora.', { claude, codex, cursor });
}

/** Machine form: install / remove the monitor hooks (what feeds "Precisando de você"). */
export function MonitorHooksCard({ machine }: { machine: Machine }) {
  const { t } = useTranslation();
  const [hooks, setHooks] = useState<MachineHooks | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.machines
      .hooks(machine.id)
      .then((h) => !cancelled && setHooks(h))
      .catch((e) => !cancelled && setError(e instanceof ApiError ? e.message : t('Erro ao consultar')));
    return () => {
      cancelled = true;
    };
  }, [machine.id]);

  const install = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await api.machines.installHooks(machine.id);
      setHooks({ installed_at: r.installed_at, hooks_url: r.hooks_url });
      setNote(hooksInstallNote(r));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('Erro ao instalar'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(t('Remover os hooks do termhub desta máquina?'))) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await api.machines.removeHooks(machine.id);
      setHooks((h) => (h ? { ...h, installed_at: null } : h));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('Erro ao remover'));
    } finally {
      setBusy(false);
    }
  };

  const installed = !!hooks?.installed_at;
  const health = monitorHealthNote(machine, installed);
  return (
    <div className="rounded-md border border-line bg-bg p-2 text-xs">
      <div className="flex items-center gap-2">
        <p className="font-medium text-fg-muted">{t('Monitor das tabs')}</p>
        <span className="text-fg-dim">{hooks ? (installed ? t('instalado em {{date}}', { date: formatDateTime(hooks.installed_at!) }) : t('não instalado')) : '…'}</span>
        <span className="ml-auto flex gap-1">
          {installed && (
            <button type="button" className="btn-ghost px-2 py-0.5" onClick={() => void remove()} disabled={busy}>
              {t('Remover')}
            </button>
          )}
          <button type="button" className="btn-ghost px-2 py-0.5" onClick={() => void install()} disabled={busy || !hooks}>
            {busy ? '…' : installed ? t('Reinstalar') : t('Instalar')}
          </button>
        </span>
      </div>
      <p className="mt-1 text-fg-dim">
        <Trans
          i18nKey="Escreve <0>~/.termhub/bin/termhub-hook</0> e registra hooks no Claude Code (<1>~/.claude/settings.json</1> e o diretório de cada conta do Claude desta máquina, em Contas de IA), no Codex (<2>~/.codex/config.toml</2>) e no Cursor CLI (<3>~/.cursor/hooks.json</3>) para avisar quando uma tab está esperando você. Só a pergunta da ferramenta é enviada, nunca o conteúdo do terminal."
          components={[<code key="0" className="font-mono" />, <code key="1" className="font-mono" />, <code key="2" className="font-mono" />, <code key="3" className="font-mono" />]}
        />
        {machine.type === 'agent' && ` ${t('Numa máquina com agente, é o próprio agente que escreve os arquivos (precisa estar conectado).')}`}
      </p>
      <p className={`mt-1 ${health.warn ? 'text-warn' : 'text-fg-muted'}`}>{health.text}</p>
      {hooks && <p className="mt-1 truncate font-mono text-[10px] text-fg-dim" title={hooks.hooks_url}>→ {hooks.hooks_url}</p>}
      {note && <p className="mt-1 text-fg-muted">{note}</p>}
      {error && <p className="mt-1 text-danger">{error}</p>}
    </div>
  );
}
