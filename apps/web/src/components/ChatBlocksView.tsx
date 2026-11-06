import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import type { ChatBlock, ChatBlockKind, ChatDefault, Project } from '../lib/types';
import { ChatAutoThresholds } from './ChatAutoThresholds';
import { i18n, tk, useTranslation } from '../i18n';

/** What each block kind names, in pt-BR (TER-1164). Mirrors `BLOCK_KIND_LABEL` on the server. */
export const BLOCK_KIND_LABEL: Record<ChatBlockKind, string> = {
  open_tab: tk('Abrir abas'),
  close_tab: tk('Fechar abas paradas'),
  start_agent: tk('Iniciar agentes'),
  board: tk('Mexer no quadro'),
  link_tab_task: tk('Ligar aba a card'),
  terminal: tk('Digitar texto e teclas nas abas'),
  run_command: tk('Rodar comandos'),
  share_file: tk('Compartilhar arquivos das máquinas'),
  machines: tk('Mexer nas máquinas (ligar ao projeto, pasta, acordar, atualizar o agente, hooks)'),
  tickets: tk('Sincronizar e importar tickets'),
  automation: tk('Retomar o trabalho automático'),
};
const KINDS = Object.keys(BLOCK_KIND_LABEL) as ChatBlockKind[];

const blockTitle = (b: ChatBlock): string =>
  b.kind === 'run_command' && b.words.length > 0 ? i18n.t('Rodar «{{command}}…»', { command: b.words.join(' ') }) : i18n.t(BLOCK_KIND_LABEL[b.kind]);

const blockDetails = (b: ChatBlock): string => {
  const where = b.project_id === null ? i18n.t('em todos os projetos') : i18n.t('no projeto {{project}}', { project: b.project_name ?? b.project_id });
  const effect = b.effect === 'never' ? i18n.t('nunca') : i18n.t('pedir antes');
  return `${where} · ${effect}`;
};

/**
 * "O que o chat não pode fazer" (TER-1164, flag chat_open_permissions): the chat acts without asking, and the
 * person lists what it must not do. The fixed core, the blocks in force with "Tirar", and a form to add one.
 * A default unchecked before the open model shows as a block for every project, lifted by turning that
 * default back on. Also the thresholds of an automatic answer from memory (`ChatAutoThresholds`).
 */
export function ChatBlocksView() {
  const { t } = useTranslation();
  const [blocks, setBlocks] = useState<ChatBlock[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [kind, setKind] = useState<ChatBlockKind>('run_command');
  const [projectId, setProjectId] = useState('');
  const [command, setCommand] = useState('');
  const [effect, setEffect] = useState<ChatBlock['effect']>('ask');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      setBlocks((await api.listChatBlocks()).blocks);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
    api.projects.list().then((r) => setProjects(r.projects.filter((p) => p.status !== 'archived')), () => setProjects([]));
  }, [load]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.createChatBlock({ kind, project_id: projectId || null, ...(kind === 'run_command' && command.trim() ? { command: command.trim() } : {}), effect });
      setCommand('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Não foi possível salvar o bloqueio.'));
    } finally {
      setSaving(false);
    }
  };

  const lift = async (b: ChatBlock) => {
    setBusyId(b.id);
    setError(null);
    try {
      if (b.source === 'restriction') await api.setChatDefault(b.id.slice('restriction:'.length) as ChatDefault['kind'], true);
      else await api.deleteChatBlock(b.id);
      await load();
    } catch {
      setError(t('Não foi possível tirar o bloqueio.'));
    } finally {
      setBusyId(null);
    }
  };

  if (loadFailed)
    return (
      <div className="space-y-2 text-sm">
        <p className="text-danger">{t('Não foi possível carregar os bloqueios.')}</p>
        <button type="button" className="btn-ghost" onClick={() => void load()}>
          {t('Tentar de novo')}
        </button>
      </div>
    );
  if (blocks === null) return <p className="text-sm text-fg-dim">{t('Carregando…')}</p>;

  return (
    <div className="space-y-6">
      <p className="text-sm text-fg-muted">{t('O chat age sem pedir confirmação. Diga aqui o que ele não pode fazer: um bloqueio pede confirmação antes ou, se for “nunca”, é recusado. Você também pode pedir ao chat (“não deixa dar push no projeto X”).')}</p>
      {error && <p className="text-sm text-danger">{error}</p>}
      <section aria-labelledby="chat-core" className="space-y-2">
        <h2 id="chat-core" className="text-sm font-semibold text-fg">
          {t('Sempre pedem confirmação')}
        </h2>
        <p className="text-xs text-fg-dim">
          {t('Apagar card, fechar aba trabalhando, as teclas Ctrl+C e Esc, responder permissões do CLI (salvo quando o chat repassa a sua própria resposta), comandos encadeados ou com redirecionamento, sudo, rm, kill, git push --force, git reset --hard, git clean, ssh e shells, o que toca segredos, merge e subir o nível da automação, status de ticket, integrações, login e setup das contas de IA, tirar um bloqueio e qualquer ferramenta nova.')}
        </p>
      </section>
      <section aria-labelledby="chat-blocks" className="space-y-2">
        <h2 id="chat-blocks" className="text-sm font-semibold text-fg">
          {t('Bloqueios')}
        </h2>
        {blocks.length === 0 ? (
          <p className="text-sm text-fg-dim">{t('Nenhum bloqueio: o chat faz tudo o que não está na lista acima sem pedir.')}</p>
        ) : (
          <ul className="space-y-2">
            {blocks.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg-2 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm text-fg">{blockTitle(b)}</p>
                  <p className="text-xs text-fg-dim">{b.source === 'restriction' ? `${blockDetails(b)} · ${t('desmarcado antes em Liberadas por padrão')}` : blockDetails(b)}</p>
                </div>
                <button type="button" className="btn-ghost shrink-0" disabled={busyId === b.id} onClick={() => void lift(b)}>
                  {t('Tirar')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <form onSubmit={(e) => void add(e)} aria-labelledby="chat-block-new" className="space-y-2">
        <h2 id="chat-block-new" className="text-sm font-semibold text-fg">
          {t('Novo bloqueio')}
        </h2>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-fg-dim">
            {t('O chat não pode')}
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value as ChatBlockKind)}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(BLOCK_KIND_LABEL[k])}
                </option>
              ))}
            </select>
          </label>
          {kind === 'run_command' && (
            <label className="flex flex-col gap-1 text-xs text-fg-dim">
              {t('Só os comandos que começam com (opcional)')}
              {/* i18n-ignore: a command, not copy */}
              <input className="input font-mono" value={command} placeholder="git push" onChange={(e) => setCommand(e.target.value)} maxLength={200} />
            </label>
          )}
          <label className="flex flex-col gap-1 text-xs text-fg-dim">
            {t('Onde')}
            <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">{t('Todos os projetos')}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-fg-dim">
            {t('Efeito')}
            <select className="input" value={effect} onChange={(e) => setEffect(e.target.value as ChatBlock['effect'])}>
              <option value="ask">{t('Pedir antes')}</option>
              <option value="never">{t('Nunca')}</option>
            </select>
          </label>
          <button type="submit" className="btn-primary" disabled={saving}>
            {t('Adicionar bloqueio')}
          </button>
        </div>
      </form>
      <ChatAutoThresholds onError={setError} />
    </div>
  );
}
