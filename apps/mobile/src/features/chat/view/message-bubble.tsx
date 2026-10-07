import { router } from 'expo-router';
import { memo, useCallback } from 'react';
import { Text, View } from 'react-native';
import Markdown from 'react-native-markdown-display';
import { filePathOfLink, filePreviewRoute, linkifyMarkdown } from '@/features/file-preview/model/md-paths';
import { useTranslation } from '@/i18n';
import type { SchemeName } from '@/theme/tokens';
import { AppText, Button, useSchemeName } from '@/ui';
import { failureSentence } from '../model/copy';
import { limitSentence, swapSentence } from '../model/notice';
import { splitSettled } from '../model/markdown-split';
import type { ChatMessage } from '../model/types';
import { codeRules } from './code-block';
import { markdownStyle } from './markdown-style';
import { MessageAttachments } from './message-attachments';
import { ReplyQuote } from './reply-quote';

type Props = {
  message: ChatMessage;
  /** The text streamed so far for this row (`live.deltas`). */
  streamed: string | undefined;
  /** Whether this row's run showed any sign of life (`live.started`). */
  started: boolean;
  /** "Tentar de novo" on a row whose send failed (`local: 'failed'`). */
  onRetry?(id: string): void;
  /** A quote's tap (TER-447): shows the original if the screen has it, and says whether it did. */
  onOpenReply?(id: string): boolean;
  /** The row a quote just scrolled to: outlined for a moment. */
  highlighted?: boolean;
  /** Where a Markdown path in the answer is looked for (spec 2026-10-04 file preview): the chat's project
   *  or the session's tab. Absent: paths stay plain text. */
  fileContext?: { projectId?: string | null; tabId?: string | null };
};

/** A tap on a link of the answer: a Markdown path opens its preview; any other link, the system's way. */
type OnLink = ((url: string) => boolean) | undefined;

/** The part of a streaming answer that no later delta can change: parsed once per distinct text. */
const SettledMarkdown = memo(function SettledMarkdown({ text, scheme, onLink }: { text: string; scheme: SchemeName; onLink: OnLink }) {
  return (
    <Markdown style={markdownStyle(scheme)} rules={codeRules} onLinkPress={onLink}>
      {text}
    </Markdown>
  );
});

/** One row of the thread: the person's text as typed, the assistant's rendered as markdown — its
 * final text, or the deltas streamed so far, or "pensando…" while its run shows signs of life. An
 * empty row that never started reads as the failure it is, same as the web. Memoised on its own
 * row's props: a delta re-renders only the bubble it streams into, and inside it only the tail after
 * the last blank line is re-parsed (`splitSettled`); the settled prefix keeps its parsed tree. When
 * the final text lands the whole body renders once — the same markdown, so nothing reflows. */
export const MessageBubble = memo(function MessageBubble({ message, streamed, started, onRetry, onOpenReply, highlighted = false, fileContext }: Props) {
  const { t } = useTranslation();
  const scheme = useSchemeName();
  const projectId = fileContext?.projectId ?? null;
  const tabId = fileContext?.tabId ?? null;
  const linking = fileContext !== undefined;
  const onLink = useCallback(
    (url: string) => {
      const path = filePathOfLink(url);
      if (path === null) return true;
      router.push(filePreviewRoute(path, { projectId, tabId }));
      return false;
    },
    [projectId, tabId],
  );

  if (message.role === 'user') {
    // Dimmed while the server has not accepted it; with the reason and a retry once it refused. What
    // was attached rides under the text (a message may be attachments only).
    const attachments = message.attachments ?? [];
    return (
      <View className="max-w-[85%] items-end gap-1 self-end">
        {/* The border is always there, transparent until a quote scrolls here: the row never changes size. */}
        <View className={`rounded-2xl border-2 bg-app-accent px-4 py-2.5 ${highlighted ? 'border-white/70' : 'border-transparent'} ${message.local === 'sending' ? 'opacity-60' : ''}`}>
          {message.reply_to ? <ReplyQuote reply={message.reply_to} onOpen={onOpenReply} /> : null}
          {message.text ? <Text className="text-base text-white">{message.text}</Text> : null}
          {attachments.length > 0 ? <MessageAttachments attachments={attachments} /> : null}
        </View>
        {message.local === 'failed' ? (
          <View className="flex-row items-center gap-2">
            <Text className="text-sm text-app-danger">{message.local_error ?? t('Não foi possível enviar.')}</Text>
            <Button label={t('Tentar de novo')} variant="ghost" onPress={() => onRetry?.(message.id)} />
          </View>
        ) : null}
      </View>
    );
  }

  const streaming = !message.text && !!streamed;
  const body = message.text || streamed || '';
  const split = streaming ? splitSettled(body) : { settled: '', tail: body };
  const settled = linking ? linkifyMarkdown(split.settled) : split.settled;
  const tail = linking ? linkifyMarkdown(split.tail) : split.tail;
  return (
    <View className={`max-w-[92%] gap-1 self-start rounded-2xl border-2 bg-app-surface px-4 py-2.5 ${highlighted ? 'border-app-accent' : 'border-transparent'}`}>
      {message.notice?.kind === 'account_swap' ? <AppText variant="muted">{swapSentence(message.notice)}</AppText> : null}
      {settled ? <SettledMarkdown text={settled} scheme={scheme} onLink={linking ? onLink : undefined} /> : null}
      {tail ? (
        <Markdown style={markdownStyle(scheme)} rules={codeRules} onLinkPress={linking ? onLink : undefined}>
          {tail}
        </Markdown>
      ) : null}
      {message.error_code !== null ? (
        <Text className="text-sm text-app-danger">{message.error_code === 'USAGE_LIMIT' ? limitSentence(message.notice) : failureSentence(message.error_code)}</Text>
      ) : !body && started ? (
        <AppText variant="muted">{t('pensando…')}</AppText>
      ) : !body ? (
        <Text className="text-sm text-app-danger">{failureSentence(null)}</Text>
      ) : null}
    </View>
  );
});
