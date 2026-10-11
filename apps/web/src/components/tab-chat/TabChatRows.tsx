import { memo, useMemo, useState } from 'react';
import { useTranslation } from '../../i18n';
import type { TabChatRow, ToolRow } from '../../lib/tab-chat';
import { handleMarkdownClick, toHtml } from '../chat/ChatTurn';

const COPY_FEEDBACK_MS = 1500;

/** "Copiar" on a whole message: its text as the transcript holds it (Markdown for an answer). */
function CopyMessageButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = () => {
    const done = (s: 'copied' | 'failed') => {
      setState(s);
      window.setTimeout(() => setState('idle'), COPY_FEEDBACK_MS);
    };
    try {
      void Promise.resolve(navigator.clipboard?.writeText(text)).then(
        () => done(navigator.clipboard ? 'copied' : 'failed'),
        () => done('failed'),
      );
    } catch {
      done('failed');
    }
  };
  return (
    <button
      type="button"
      className="rounded px-1.5 py-0.5 text-[11px] text-fg-dim opacity-0 hover:bg-bg-3 hover:text-fg focus:opacity-100 group-hover:opacity-100"
      onClick={copy}
      aria-label={t('Copiar mensagem')}
    >
      {state === 'copied' ? t('copiado') : state === 'failed' ? t('falhou') : t('Copiar')}
    </button>
  );
}

function StatusMark({ status }: { status: ToolRow['status'] }) {
  const { t } = useTranslation();
  if (status === 'running') return <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent" title={t('rodando')} aria-label={t('rodando')} />;
  if (status === 'error') return <span className="shrink-0 text-danger" title={t('falhou')} aria-label={t('falhou')}>✕</span>;
  return <span className="shrink-0 text-ok" title={t('concluída')} aria-label={t('concluída')}>✓</span>;
}

/** One tool call inside an open group: name, what it is about, its status, and its result on demand. */
function ToolLine({ tool }: { tool: ToolRow }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <li className="py-0.5">
      <button type="button" className="flex w-full min-w-0 items-center gap-2 rounded px-1 text-left hover:bg-bg-3" onClick={() => setOpen((o) => !o)} aria-expanded={open} disabled={!tool.preview}>
        <StatusMark status={tool.status} />
        <span className="shrink-0 font-mono text-[11px] text-fg">{tool.name}</span>
        {tool.summary && <span className="min-w-0 truncate font-mono text-[11px] text-fg-dim">{tool.summary}</span>}
        {tool.preview && <span className="ml-auto shrink-0 text-[10px] text-fg-dim">{open ? t('ocultar') : t('resultado')}</span>}
      </button>
      {open && tool.preview && <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-bg-3 p-2 font-mono text-[11px] text-fg-muted [overflow-wrap:anywhere]">{tool.preview}</pre>}
    </li>
  );
}

/** Consecutive tool calls, folded in one line ("5 ferramentas · Bash") that opens to each call. */
function ToolsRow({ tools }: { tools: ToolRow[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const last = tools[tools.length - 1]!;
  const running = tools.some((x) => x.status === 'running');
  const failed = tools.filter((x) => x.status === 'error').length;
  return (
    <li className="rounded-lg border border-line bg-bg-2 px-2 py-1 text-xs">
      <button type="button" className="flex w-full min-w-0 items-center gap-2 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="text-fg-dim" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
        <StatusMark status={running ? 'running' : failed > 0 ? 'error' : 'done'} />
        <span className="shrink-0 text-fg-muted">{t('{{count}} ferramentas', { count: tools.length })}</span>
        <span className="min-w-0 truncate font-mono text-[11px] text-fg-dim">
          {last.name}
          {last.summary ? ` · ${last.summary}` : ''}
        </span>
      </button>
      {open && (
        <ul className="mt-1 border-t border-line pt-1">
          {tools.map((tool) => (
            <ToolLine key={tool.id} tool={tool} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** A subagent: its task, its state, and its report once it returned (rendered as the answer it is). */
function SubagentRow({ tool, projectId }: { tool: ToolRow; projectId: string | null }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const html = useMemo(() => (open && tool.preview ? toHtml(tool.preview, projectId) : ''), [open, tool.preview, projectId]);
  return (
    <li className="rounded-lg border border-accent/30 bg-accent/5 px-2 py-1 text-xs">
      <button type="button" className="flex w-full min-w-0 items-center gap-2 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open} disabled={!tool.preview}>
        <span className="text-fg-dim" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
        <StatusMark status={tool.status} />
        <span className="shrink-0 font-medium text-fg-muted">{t('Subagente')}</span>
        <span className="min-w-0 truncate text-fg">{tool.summary ?? tool.name}</span>
      </button>
      {open && html && <div className="prose-termhub mt-1 overflow-x-auto break-words border-t border-line pt-1" onClick={handleMarkdownClick} dangerouslySetInnerHTML={{ __html: html }} />}
    </li>
  );
}

function MessageRow({ row, projectId }: { row: Extract<TabChatRow, { kind: 'message' }>; projectId: string | null }) {
  const { t } = useTranslation();
  // The one HTML this view renders, and only ever `renderMarkdown`'s sanitised output (see ChatTurn).
  const html = useMemo(() => (row.role === 'assistant' ? toHtml(row.text, projectId) : ''), [row.role, row.text, projectId]);
  if (row.role === 'user') {
    return (
      <li data-item-id={row.id} className="group flex items-center justify-end gap-1">
        <CopyMessageButton text={row.text} />
        <div className="max-w-[85%] rounded-2xl bg-accent/10 px-4 py-2.5 text-sm leading-relaxed text-fg [overflow-wrap:anywhere]">
          {row.text && <div className="whitespace-pre-wrap">{row.text}</div>}
          {row.images > 0 && <div className="mt-1 text-xs text-fg-dim">{t('{{count}} imagens', { count: row.images })}</div>}
        </div>
      </li>
    );
  }
  return (
    <li data-item-id={row.id} className="group">
      <div className="prose-termhub overflow-x-auto break-words" onClick={handleMarkdownClick} dangerouslySetInnerHTML={{ __html: html }} />
      <div className="mt-0.5">
        <CopyMessageButton text={row.text} />
      </div>
    </li>
  );
}

/**
 * One row of a tab's conversation. Memoised: a live frame re-renders the list, and only the rows whose
 * data changed (a tool that got its result) should parse their Markdown again.
 */
export const TabChatRowView = memo(function TabChatRowView({ row, projectId }: { row: TabChatRow; projectId: string | null }) {
  switch (row.kind) {
    case 'message':
      return <MessageRow row={row} projectId={projectId} />;
    case 'tools':
      return <ToolsRow tools={row.tools} />;
    case 'subagent':
      return <SubagentRow tool={row.tool} projectId={projectId} />;
    case 'line':
      return <li className="text-center text-[11px] text-fg-dim [overflow-wrap:anywhere]">{row.text}</li>;
  }
});
