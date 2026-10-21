import { useState, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { useTranslation } from '@/i18n';
import { AppText, Icon } from '@/ui';
import { questionTrailSummary } from '../model/question-trail';
import type { TabQuestion } from '../model/types';

type Props = { questions: TabQuestion[]; renderQuestion(question: TabQuestion): ReactNode };

/** Whether a trail is open, by its first card's id, outside the component: the list recycles rows and
 * remounts one whose key moves, and a trail the person opened must not snap shut. */
const opened = new Set<string>();

/**
 * A run of settled tab cards as one accordion (TER-1108), like the web's `ChatQuestionTrail`: closed by
 * default, one line says how many, whose and how they ended, and a tap opens their compact lines, each
 * expandable to the whole card. Only settled cards land here (`groupSettledQuestions`): a card still
 * waiting on the person stays in the thread on its own.
 */
export function QuestionTrailCard({ questions, renderQuestion }: Props) {
  const { t } = useTranslation();
  const id = questions[0]!.id;
  const [open, setOpen] = useState(() => opened.has(id));
  const toggle = () => {
    if (open) opened.delete(id);
    else opened.add(id);
    setOpen(!open);
  };
  const summary = questionTrailSummary(questions);
  return (
    <View className="gap-2">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={summary}
        accessibilityHint={open ? t('Recolher') : t('Ver detalhes')}
        accessibilityState={{ expanded: open }}
        onPress={toggle}
        className="flex-row items-center gap-2 self-start rounded-xl border border-app-border px-3 py-2"
      >
        <Icon name={open ? { ios: 'chevron.down', android: 'expand_more' } : { ios: 'chevron.right', android: 'chevron_right' }} size={12} tone="muted" />
        <AppText variant="muted" className="shrink" numberOfLines={2}>
          {summary}
        </AppText>
      </Pressable>
      {open ? questions.map((q) => <View key={q.id}>{renderQuestion(q)}</View>) : null}
    </View>
  );
}
