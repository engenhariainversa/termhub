import { memo, useState } from 'react';
import { TextInput, View } from 'react-native';
import { useTranslation } from '@/i18n';
import { AppText, Button } from '@/ui';
import { CODEX_REPLY_PLACEHOLDER, CONTEXT_PREVIEW_MAX, isReplyCard, lastParagraph, suggestionFieldLabel, suggestionHint, suggestionStatusLabel, suggestionTitle } from '../model/tab-suggestion-text';
import type { TabSuggestion } from '../model/types';

type Props = {
  suggestion: TabSuggestion;
  /** This card's send or dismiss is in flight. */
  busy: boolean;
  /** Why this card's last send or dismiss did not go through (pt-BR). */
  error?: string | null;
  onSend(suggestionId: string, text: string): void;
  onDismiss(suggestionId: string): void;
};

const INPUT = 'rounded-xl border border-app-border bg-app-surface px-4 py-3 text-base text-app-text placeholder:text-app-muted';

/** Claude Code's dimmed next prompt in a tab that finished its turn — an offer, not a question (spec 2026-09-26
 * TER-203 §5) —, the web card's twin, with the agent's message it answers (spec 2026-09-26 §6.4): the text
 * editable, Enviar / Dispensar — no PIN. Memoised: `onSend` and `onDismiss` are stable. */
export const TabSuggestionCard = memo(function TabSuggestionCard({ suggestion, busy, error, onSend, onDismiss }: Props) {
  const { t } = useTranslation();
  const [text, setText] = useState(suggestion.payload.text);
  const open = suggestion.status === 'open';
  const trimmed = text.trim();
  const context = suggestion.payload.context?.trim() || null;
  // A Codex reply card holds no suggested text: it asks the person a question, so it takes an answer, not an edit.
  const codex = isReplyCard(suggestion);
  const fieldLabel = suggestionFieldLabel(suggestion);
  const label = codex ? t(CODEX_REPLY_PLACEHOLDER) : fieldLabel;
  return (
    // The testID tells this card's "Enviar" from the composer's, both on screen at once.
    <View testID={`tab-suggestion-${suggestion.id}`} className="gap-3 rounded-2xl border border-app-border bg-app-surface2 p-4">
      <AppText variant="label">{suggestionTitle(suggestion)}</AppText>
      {open ? <AppText variant="muted">{suggestionHint(suggestion)}</AppText> : null}
      {context ? <SuggestionContext text={context} /> : null}
      {open ? (
        <View className="gap-2">
          {codex ? null : <AppText variant="muted">{fieldLabel}</AppText>}
          <TextInput accessibilityLabel={label} placeholder={codex ? t(CODEX_REPLY_PLACEHOLDER) : undefined} value={text} maxLength={2000} editable={!busy} onChangeText={setText} className={INPUT} />
          <View className="flex-row gap-2">
            <View className="flex-1">
              <Button label={t('Enviar')} onPress={() => onSend(suggestion.id, trimmed)} disabled={busy || !trimmed} />
            </View>
            <View className="flex-1">
              <Button label={t('Dispensar')} variant="secondary" onPress={() => onDismiss(suggestion.id)} disabled={busy} />
            </View>
          </View>
        </View>
      ) : (
        <View className="gap-1">
          <AppText>{suggestion.answer?.text ?? suggestion.payload.text}</AppText>
          <AppText variant="muted">{suggestionStatusLabel(suggestion)}</AppText>
        </View>
      )}
      {error ? <AppText className="text-app-danger">{error}</AppText> : null}
    </View>
  );
});

/** The agent's message, plain text set off by a rule: its last paragraph, the whole of it on demand. */
function SuggestionContext({ text }: { text: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const short = lastParagraph(text, CONTEXT_PREVIEW_MAX);
  return (
    <View className="gap-1 border-l-2 border-app-border pl-3">
      <AppText variant="muted">{expanded ? text : short}</AppText>
      {short !== text ? <Button label={expanded ? t('Recolher') : t('Ver mensagem inteira')} variant="ghost" onPress={() => setExpanded((v) => !v)} /> : null}
    </View>
  );
}
