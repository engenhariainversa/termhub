import { useCallback, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { Paperclip } from 'lucide-react';
import { useTranslation } from '../../i18n';
import { api, ApiError } from '../../lib/api';
import { appNavigate } from '../../lib/app-navigate';
import { sendsMessage } from '../../lib/chat-scroll';
import { filePreviewHref } from '../../lib/md-paths';
import { withAttachedPaths } from '../../lib/tab-chat';
import { TAB_MESSAGE_MAX_CHARS } from '../../lib/use-tab-chat';

/** A file for the session, saved on the tab's machine as a paste in the terminal is; the message carries its path. */
interface Draft {
  key: number;
  name: string;
  phase: 'uploading' | 'uploaded' | 'failed';
  path: string | null;
  error: string | null;
}

const MAX_ROWS = 8;
const LINE_PX = 20;

export interface TabChatComposerProps {
  tabId: string;
  projectId: string;
  machineId: string | null;
  /** Resolves `true` once the text was typed into the tab; `false` gives it back to the box. */
  onSend: (text: string) => Promise<boolean>;
  /** Esc in the session (Interromper): offered while the tab works. */
  onInterrupt?: () => void;
  /** Why nothing can be sent right now (the machine is offline); null = it can. */
  blockedReason: string | null;
}

/**
 * The box of a tab's conversation (TER-1003): text, files and send. Enter sends (Shift+Enter is a line;
 * a touch keyboard keeps Enter for lines, ⌘/Ctrl+Enter always sends), as in the chat. A file is saved on
 * the tab's machine the moment it is picked, dropped or pasted; its path goes at the end of the message.
 * A Markdown file opens in a preview tab (TER-941) from its chip.
 */
export function TabChatComposer({ tabId, projectId, machineId, onSend, onInterrupt, blockedReason }: TabChatComposerProps) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [sending, setSending] = useState(false);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  // The box grows with its text up to MAX_ROWS, then scrolls.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_ROWS * LINE_PX + 16)}px`;
  }, [text]);

  const addFiles = useCallback(
    (files: File[]) => {
      for (const file of files) {
        const key = ++seq.current;
        setDrafts((d) => [...d, { key, name: file.name || t('arquivo'), phase: 'uploading', path: null, error: null }]);
        api.tabs.pasteFile(tabId, file, file.name || undefined).then(
          (r) => setDrafts((d) => d.map((x) => (x.key === key ? { ...x, phase: 'uploaded', path: r.path } : x))),
          (e: unknown) => setDrafts((d) => d.map((x) => (x.key === key ? { ...x, phase: 'failed', error: e instanceof ApiError ? e.message : t('Não foi possível enviar o arquivo.') } : x))),
        );
      }
    },
    [tabId, t],
  );

  const uploading = drafts.some((d) => d.phase === 'uploading');
  const paths = drafts.flatMap((d) => (d.phase === 'uploaded' && d.path ? [d.path] : []));
  const message = withAttachedPaths(text, paths);
  const tooLong = message.length > TAB_MESSAGE_MAX_CHARS;
  const canSend = !blockedReason && !sending && !uploading && !tooLong && message.length > 0;

  const send = async () => {
    if (!canSend) return;
    const before = { text, drafts };
    setSending(true);
    setText('');
    setDrafts([]);
    const ok = await onSend(message).catch(() => false);
    setSending(false);
    // A refused message comes back, unless something new was typed meanwhile.
    if (!ok) {
      setText((now) => (now ? now : before.text));
      setDrafts((now) => (now.length > 0 ? now : before.drafts));
    }
    boxRef.current?.focus();
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    addFiles(files);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    addFiles(files);
  };

  return (
    <div className="shrink-0 border-t border-line bg-bg-2 px-3 py-2" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      {drafts.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1" aria-label={t('Anexos')}>
          {drafts.map((d) => {
            const markdown = /\.(md|markdown)$/i.test(d.name) && d.path;
            return (
              <li key={d.key} className={`flex max-w-[260px] items-center gap-1 rounded border px-2 py-0.5 text-[11px] ${d.phase === 'failed' ? 'border-danger/50 text-danger' : 'border-line text-fg-muted'}`} title={d.error ?? d.path ?? d.name}>
                {markdown ? (
                  <button type="button" className="truncate underline" onClick={() => appNavigate(filePreviewHref(projectId, d.path!, machineId ?? undefined))} title={t('Ver prévia')}>
                    {d.name}
                  </button>
                ) : (
                  <span className="truncate">{d.name}</span>
                )}
                {d.phase === 'uploading' && <span className="text-fg-dim">{t('enviando…')}</span>}
                {d.phase === 'failed' && <span>{t('falhou')}</span>}
                <button type="button" className="text-fg-dim hover:text-fg" onClick={() => setDrafts((all) => all.filter((x) => x.key !== d.key))} aria-label={t('Remover {{name}}', { name: d.name })}>
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex items-end gap-2">
        <button type="button" className="mb-1 rounded p-1 text-fg-dim hover:bg-bg-3 hover:text-fg disabled:opacity-40" onClick={() => fileRef.current?.click()} disabled={!!blockedReason} title={t('Anexar arquivo')} aria-label={t('Anexar arquivo')}>
          <Paperclip size={16} />
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
        <textarea
          ref={boxRef}
          rows={1}
          className="min-h-[36px] flex-1 resize-none rounded-lg border border-line bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-accent/60"
          placeholder={blockedReason ?? t('Mensagem para a sessão…')}
          aria-label={t('Mensagem para a sessão')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (sendsMessage(e)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {onInterrupt && (
          <button type="button" className="btn-ghost mb-0.5 text-xs" onClick={onInterrupt} title={t('Interromper (Esc na sessão)')}>
            {t('Interromper')}
          </button>
        )}
        <button type="button" className="btn-primary mb-0.5 text-xs disabled:opacity-40" onClick={() => void send()} disabled={!canSend}>
          {t('Enviar')}
        </button>
      </div>
      {tooLong && <p className="mt-1 text-[11px] text-danger">{t('Mensagem longa demais (máximo de {{max}} caracteres)', { max: TAB_MESSAGE_MAX_CHARS })}</p>}
    </div>
  );
}
