import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { decorateCodeBlocks } from '../lib/code-blocks';
import { sendFileToChat } from '../lib/chat-inbox';
import { useProjectChat } from '../lib/project-chat';
import { formatBytes } from '../lib/attachments';
import { renderFileMarkdown } from '../lib/markdown';
import type { FilePreview, FilePreviewOk } from '../lib/types';
import { handleCopyClick } from './chat/ChatTurn';
import { formatDateTime } from '../lib/format';
import { tk, useTranslation } from '../i18n';

/** Why a file has no preview, in the words the screen shows (spec 2026-10-04 file preview D8). */
export const REFUSAL_TEXT: Record<string, string> = {
  missing: tk('Arquivo não encontrado nesta máquina.'),
  outside: tk('Este arquivo está fora das pastas que o agente pode ler (o projeto, a sua pasta pessoal e /tmp).'),
  hidden: tk('Arquivos em pastas ocultas (como ~/.ssh ou .git) não são abertos.'),
  type: tk('Só arquivos .md, .markdown e .txt podem ser abertos aqui.'),
  not_file: tk('Este caminho não é um arquivo.'),
  too_large: tk('O arquivo passa de 512 KB, o limite da prévia.'),
  binary: tk('O arquivo não é texto (UTF-8).'),
  eperm: tk('O agente não tem permissão para ler este arquivo.'),
};
/** The pt-BR key of the refusal; shown through `t()`. */
const refusalText = (status: string) => REFUSAL_TEXT[status] ?? tk('Não foi possível abrir este arquivo.');

/** The folder of the path as it was asked, so relative links inside the file resolve from there. */
export function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

const isMarkdown = (name: string) => /\.(?:md|markdown)$/i.test(name);

type Load = { phase: 'loading' } | { phase: 'done'; file: FilePreview } | { phase: 'error'; message: string; outdated: boolean };

interface Props {
  /** The project whose machines hold the file; null outside a project (the person's machines). */
  projectId: string | null;
  /** The path as the answer wrote it: absolute, `~/…` or relative to the project folder. */
  path: string;
  machineId?: string | null;
  /** Loads only once the tab is shown, so a restored tab bar does not read every file at once. */
  active: boolean;
  /** A relative Markdown link inside the file: another preview (single click) or pinned (double click). */
  onOpenFile?: (path: string, mode: 'preview' | 'pin') => void;
}

/**
 * A Markdown (or text) file an agent wrote, read on its machine on demand. The body goes through
 * `renderFileMarkdown`, the chat's sanitiser with links rewritten, so the file can fetch nothing.
 */
export function FileView({ projectId, path, machineId = null, active, onOpenFile }: Props) {
  const { t } = useTranslation();
  const [load, setLoad] = useState<Load | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const navigate = useNavigate();
  const chat = useProjectChat();

  const fetchFile = useCallback(async () => {
    setLoad({ phase: 'loading' });
    try {
      const file = await api.filePreview({ path, project_id: projectId, machine_id: machineId });
      setLoad({ phase: 'done', file });
    } catch (e) {
      const outdated = e instanceof ApiError && e.code === 'AGENT_OUTDATED';
      setLoad({ phase: 'error', message: e instanceof ApiError ? e.message : t('Erro ao abrir o arquivo'), outdated });
    }
  }, [path, projectId, machineId, t]);

  useEffect(() => {
    if (active && load === null) void fetchFile();
  }, [active, load, fetchFile]);

  const ok: FilePreviewOk | null = load?.phase === 'done' && load.file.status === 'ok' ? (load.file as FilePreviewOk) : null;
  const html = useMemo(() => {
    if (!ok || !isMarkdown(ok.name)) return null;
    const rendered = renderFileMarkdown(ok.content, dirOf(path));
    return rendered.includes('<pre') ? decorateCodeBlocks(rendered) : rendered;
  }, [ok, path]);

  const flash = (text: string) => {
    setNote(text);
    window.setTimeout(() => setNote(null), 2000);
  };

  const copy = async () => {
    if (!ok) return;
    try {
      await navigator.clipboard.writeText(ok.content);
      flash(t('Copiado.'));
    } catch {
      flash(t('Não foi possível copiar.'));
    }
  };

  const download = () => {
    if (!ok) return;
    const url = URL.createObjectURL(new Blob([ok.content], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = ok.name;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const toChat = () => {
    if (!ok) return;
    sendFileToChat(projectId, new File([ok.content], ok.name, { type: 'text/markdown' }));
    // The project's chat opens beside the file; outside a project, the account chat is its own page.
    if (projectId) {
      chat.setOpen(projectId, true);
      flash(t('Anexado à caixa do chat do projeto.'));
    } else navigate('/chat');
  };

  const onBodyClick = (e: MouseEvent<HTMLDivElement>) => {
    const link = (e.target as HTMLElement).closest('a[data-file-link]');
    if (link && onOpenFile && e.button === 0 && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      onOpenFile(link.getAttribute('data-file-link')!, e.detail >= 2 ? 'pin' : 'preview');
      return;
    }
    handleCopyClick(e);
  };

  return (
    <div className="flex h-full flex-col bg-bg" data-testid="file-view">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-bg-2 px-3 py-1.5 text-xs">
        <span className="min-w-0 flex-1 truncate font-mono text-fg-muted" title={ok?.path ?? path}>
          {ok?.path ?? path}
        </span>
        {ok && (
          <span className="text-fg-dim">
            {ok.machine.name} · {formatBytes(ok.size)} · {formatDateTime(ok.mtime)}
          </span>
        )}
        {note && (
          <span role="status" className="text-ok">
            {note}
          </span>
        )}
        <button className="btn-ghost text-xs" onClick={() => void fetchFile()} disabled={load?.phase === 'loading'}>
          {t('Atualizar', { context: 'refresh' })}
        </button>
        {ok && (
          <>
            <button className="btn-ghost text-xs" onClick={() => void copy()}>
              {t('Copiar')}
            </button>
            <button className="btn-ghost text-xs" onClick={download}>
              {t('Baixar')}
            </button>
            {ok.github_url && (
              <a className="btn-ghost text-xs" href={ok.github_url} target="_blank" rel="noopener noreferrer">
                {t('Abrir no GitHub')}
              </a>
            )}
            <button className="btn-ghost text-xs" onClick={toChat}>
              {t('Mandar para o chat')}
            </button>
          </>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {(load === null || load.phase === 'loading') && <p className="text-sm text-fg-dim">{t('Abrindo arquivo…')}</p>}
        {load?.phase === 'error' && (
          <div className={`rounded border px-3 py-2 text-sm ${load.outdated ? 'border-warn/30 bg-warn/10 text-warn' : 'border-danger/30 bg-danger/10 text-danger'}`}>
            {load.message}
          </div>
        )}
        {load?.phase === 'done' && load.file.status !== 'ok' && (
          <div className="rounded border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn">
            {t(refusalText(load.file.status))}
            {load.file.machine && <span className="text-fg-dim"> ({load.file.machine.name})</span>}
          </div>
        )}
        {ok &&
          (html !== null ? (
            // Running text meant to be read: the one place this view caps its width (CLAUDE.md).
            // `renderFileMarkdown` is the sanitising path; nothing else reaches this HTML.
            <div className="prose-termhub mx-auto max-w-4xl break-words" onClick={onBodyClick} dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-xs text-fg">{ok.content}</pre>
          ))}
      </div>
    </div>
  );
}
