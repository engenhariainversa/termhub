import { memo, useMemo } from 'react';
import type { MouseEvent } from 'react';
import { decorateCodeBlocks } from '../../lib/code-blocks';
import { renderMarkdown } from '../../lib/markdown';
import type { ChatErrorCode, ChatMessage } from '../../lib/types';

const COPY_FEEDBACK_MS = 1500;

/** What an answer that stopped says when nothing was said about why. */
const GENERIC_FAILURE = 'A resposta não terminou — tente de novo.';

/**
 * One sentence per stored failure: what happened, and what to do about it. Short, because this is read
 * on a phone under an answer that stopped — and specific, because "a resposta não terminou" told a
 * person whose machine has no `claude` installed exactly nothing. An unknown code (a server newer than
 * this bundle) falls back to the generic line rather than showing a label.
 */
const FAILURE_LINE: Record<ChatErrorCode, string> = {
  RUNNER_FAILED: GENERIC_FAILURE,
  TOKEN_FAILED: 'O servidor não conseguiu criar a credencial do concierge. Tente de novo.',
  CLI_MISSING: 'Essa máquina não tem o Claude Code instalado. Instale o claude nela e mande a mensagem de novo.',
  CLI_REJECTED: 'O Claude Code dessa máquina recusou os parâmetros do chat. Atualize o claude nela e tente de novo.',
  MISSING_SESSION: 'A sessão do Claude nessa máquina não existe mais. Mande a mensagem de novo para começar uma nova.',
  RUN_FAILED: 'O Claude parou no meio da resposta. Mande a mensagem de novo.',
  // Unreachable on a stored row today, and kept anyway: the agent only ever sends `killed` in answer
  // to the server's own `close`, and the connection layer swallows that ack (a locally closed channel
  // reports no exit), so nothing writes KILLED. The sentence stays because the label is the protocol's
  // and a future path may store it — but nobody should write a test that expects this on screen, since
  // it would be a test for a state the server cannot produce.
  KILLED: 'A resposta foi interrompida antes de terminar. Mande a mensagem de novo.',
  HOST_GONE: 'A máquina do chat saiu do ar no meio da resposta. Ligue-a e mande a mensagem de novo.',
  // Not a machine that went away: it is up, and this sentence must not send anyone looking for a
  // problem with it. What unblocks the chat is closing a few terminals, and nothing else.
  HOST_BUSY: 'A máquina do chat está com terminais demais abertos e não sobrou espaço para a conversa. Feche algumas abas e mande a mensagem de novo.',
  AGENT_TOO_OLD: 'O agente dessa máquina ainda não sabe rodar o chat. Atualize o agente e tente de novo.',
};

/** The two things a copy attempt can end as, in the words the block shows and the ones it announces. */
const COPY_OUTCOME = {
  copied: { label: 'copiado', announced: 'Código copiado', name: 'Código copiado' },
  failed: { label: 'falhou', announced: 'Não foi possível copiar o código', name: 'Não foi possível copiar' },
} as const;

/**
 * The one delegated handler for every copy button a message's decorated HTML may contain — there is
 * no React node per block, since the blocks come from an HTML string. `event.target` is whatever the
 * click actually landed on inside the button (its label span, most likely), so this walks up to the
 * element `decorateCodeBlocks` marked with `data-copy`.
 *
 * Every way this can fail ends in the same visible "falhou": a missing `navigator.clipboard` (an
 * insecure context, an older browser), a `writeText` that rejects (Firefox without the permission, a
 * document that is not focused), and a `writeText` that is not a promise at all, which used to throw
 * out of this handler on `.then`. Copying the block is the whole point of the button — a tap that
 * silently does nothing, again and again, is the one outcome it must never have.
 */
function handleCopyClick(event: MouseEvent<HTMLDivElement>): void {
  const target = event.target as HTMLElement;
  const button = target.closest('[data-copy]') as HTMLElement | null;
  if (!button) return;

  const pre = button.closest('figure')?.querySelector('pre');
  // `<code>`'s `textContent` for a fenced block always carries the fence's own trailing newline (see
  // markdown.test.ts) — that is a serialiser artefact, not part of what the user typed, so it is
  // trimmed before anything reaches the clipboard.
  const text = (pre?.textContent ?? '').replace(/\n$/, '');

  try {
    const clipboard = navigator.clipboard;
    if (!clipboard) {
      flashCopy(button, COPY_OUTCOME.failed);
      return;
    }
    // `Promise.resolve` so a `writeText` that returns undefined (or anything else) is handled here
    // instead of throwing on `.then`.
    void Promise.resolve(clipboard.writeText(text)).then(
      () => flashCopy(button, COPY_OUTCOME.copied),
      () => flashCopy(button, COPY_OUTCOME.failed),
    );
  } catch {
    // `writeText` threw synchronously, or reading `navigator.clipboard` itself did.
    flashCopy(button, COPY_OUTCOME.failed);
  }
}

/** Transient, DOM-only feedback on the button that was clicked — there is no React state to hold it,
 * since the button is not a React node. The outcome also goes into the block's own live region, which
 * `decorateCodeBlocks` mounted with the block. Reverts on its own after `COPY_FEEDBACK_MS`. */
function flashCopy(button: HTMLElement, outcome: (typeof COPY_OUTCOME)[keyof typeof COPY_OUTCOME]): void {
  const live = button.closest('figure')?.querySelector('[data-copy-live]') ?? null;
  if (live) live.textContent = outcome.announced;

  const label = button.querySelector('[data-copy-label]');
  const original = label?.textContent ?? null;
  if (label) label.textContent = outcome.label;
  button.setAttribute('aria-label', outcome.name);
  window.setTimeout(() => {
    if (live) live.textContent = '';
    if (label) label.textContent = original;
    button.setAttribute('aria-label', 'Copiar código');
  }, COPY_FEEDBACK_MS);
}

export interface ChatTurnProps {
  message: ChatMessage;
  /** What has streamed for this row so far, if anything (`live.deltas` in `ChatPage`). */
  streaming?: string;
  /** The tool calls seen for this row while it is being written (`fold.get(id).tools` in `ChatPanel`). */
  tools?: readonly { tool: string }[];
  /** The page decided this empty row is the answer being written right now: say "pensando…". */
  waiting: boolean;
  /** The page decided nothing will ever fill this row: say so instead of waiting for ever. */
  failed: boolean;
}

/**
 * One turn of the conversation. The user's words go in a bubble on the right and are never parsed
 * as Markdown — what they typed is what they see. The concierge's answer is left-aligned prose with
 * no bubble, rendered through `renderMarkdown`, which is the only sanitising path in `apps/web` and
 * the only reason `dangerouslySetInnerHTML` is allowed here.
 *
 * Purely presentational: `waiting` and `failed` are decisions `ChatPage` owns (they were each paid
 * for with a production bug) and must never be re-derived here.
 *
 * Memoised, and the parsing memoised inside it: a streamed answer re-renders the whole thread on
 * every delta, and parsing plus sanitising one message costs about 1 ms — a 50-message thread was
 * paying ~51 ms per delta, on the same main thread the answer is being written on.
 */
export const ChatTurn = memo(function ChatTurn({ message, streaming, tools, waiting, failed }: ChatTurnProps) {
  const body = message.role === 'user' ? '' : message.text || streaming || (waiting ? 'pensando…' : '');
  // Keyed on the body alone: the same text always sanitises to the same HTML, so a delta only ever
  // re-parses the row it lands in. `decorateCodeBlocks` runs inside the same memo rather than a
  // second pass elsewhere — it, too, would otherwise re-run on every streamed delta.
  const html = useMemo(() => {
    if (!body) return '';
    const rendered = renderMarkdown(body, { markdownOnly: true });
    // No fence in this answer, nothing to decorate: every delta of a prose-only reply would otherwise
    // pay for a full DOMParser round trip that cannot change anything.
    return rendered.includes('<pre') ? decorateCodeBlocks(rendered) : rendered;
  }, [body]);

  if (message.role === 'user') {
    return (
      <li className="flex justify-end">
        {/* `break-words` so a pasted path or URL wraps instead of widening the column on a phone. */}
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-accent/10 px-4 py-2.5 text-sm leading-relaxed text-fg">{message.text}</div>
      </li>
    );
  }

  return (
    <li className="text-fg">
      {/* The one place in the chat that renders HTML, and only ever `renderMarkdown`'s output: this
       * text comes from an agent that reads real terminal screens, so `markdownOnly` keeps this to
       * the elements Markdown itself produces — nothing here can make the browser fetch a URL.
       *
       * The two classes are on this container, not on `.prose-termhub` (the notes editor shares that
       * class), and they fix the same finding from both ends: a `ol` with `overflow-y-auto` computes
       * `overflow-x` to `auto`, so anything wider than the column makes the whole conversation — the
       * reader's own bubbles included — scroll sideways on a phone. `break-words` wraps an unbroken
       * path quoted off a terminal; `overflow-x-auto` contains what cannot wrap, since a six-column
       * GFM table's min-content width does not shrink, and gives that scroll to the answer instead of
       * to the thread. `pre` keeps its own horizontal scroll either way. */}
      {body && (
        <div
          className="prose-termhub overflow-x-auto break-words"
          // The one delegated handler for every copy button this row's HTML may contain (there can be
          // several, one per fence) — a per-block React handler is impossible anyway, since the blocks
          // come from an HTML string, not from JSX.
          onClick={handleCopyClick}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
      {(tools ?? []).length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {(tools ?? []).map((a, i) => (
            <span key={i} className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-fg-dim">
              {a.tool}
            </span>
          ))}
        </div>
      )}
      {failed && <p className="mt-1 text-xs text-danger">{(message.error_code && FAILURE_LINE[message.error_code]) || GENERIC_FAILURE}</p>}
    </li>
  );
});
