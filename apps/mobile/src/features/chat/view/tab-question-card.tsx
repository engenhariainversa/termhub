import { memo, useEffect, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import type { TTabQuestionAnswerBody } from '@/services/api/contract';
import { AppText, Button } from '@/ui';
import { answerSummary, statusLabel, tabLabel } from '../model/tab-question-text';
import type { TabQuestion } from '../model/types';

type Props = {
  question: TabQuestion;
  /** An answer (this one or another card's) is in flight. */
  busy: boolean;
  onAnswer(questionId: string, body: TTabQuestionAnswerBody): void;
  loadScreen(questionId: string): Promise<string | null>;
};
type Choice = Extract<TabQuestion, { kind: 'choice' }>;
type Permission = Extract<TabQuestion, { kind: 'permission' }>;

const INPUT = 'rounded-xl border border-app-border bg-app-surface px-4 py-3 text-base text-app-text placeholder:text-app-muted';

/** A question an agent in a tab asked (spec 2026-09-25 §6.3), the web card's twin: options with the
 * recommended one marked, "Outra resposta", or Permitir / Negar / Negar e dizer… — no PIN. Memoised:
 * `onAnswer` and `loadScreen` are the store's own (stable) actions. */
export const TabQuestionCard = memo(function TabQuestionCard(props: Props) {
  const { question } = props;
  return (
    // The testID disambiguates this card's own controls (e.g. "Enviar" on a permission's deny-text
    // form) from the composer's own button of the same accessible name, both on screen at once.
    <View testID={`tab-question-${question.id}`} className="gap-3 rounded-2xl border border-app-accent bg-app-surface2 p-4">
      {question.kind === 'choice' ? <ChoiceBody {...props} question={question} /> : <PermissionBody {...props} question={question} />}
      {question.status !== 'open' ? <AppText variant="muted">{statusLabel(question)}</AppText> : null}
    </View>
  );
});

function ChoiceBody({ question, busy, onAnswer }: Props & { question: Choice }) {
  const items = question.payload.questions;
  const [current, setCurrent] = useState(0);
  const [selected, setSelected] = useState<number[][]>(() => items.map(() => []));
  const [texts, setTexts] = useState<string[]>(() => items.map(() => ''));
  const title = <AppText variant="label">{`${tabLabel(question)} perguntou`}</AppText>;
  if (question.status !== 'open') {
    return (
      <View className="gap-1">
        {title}
        {answerSummary(question).map((line, i) => (
          <AppText key={i}>{line}</AppText>
        ))}
      </View>
    );
  }
  const item = items[current]!;
  const typing = texts[current]!.trim() !== '';
  const answers = items.map((_, i) => (texts[i]!.trim() ? { selected: [], text: texts[i]!.trim() } : { selected: [...selected[i]!].sort((a, b) => a - b) }));
  const complete = answers.every((a) => 'text' in a || a.selected.length > 0);
  const toggle = (option: number) =>
    setSelected((prev) => prev.map((s, j) => (j !== current ? s : item.multi_select ? (s.includes(option) ? s.filter((x) => x !== option) : [...s, option]) : [option])));
  return (
    <View className="gap-2">
      {title}
      {items.length > 1 ? (
        <View className="flex-row flex-wrap gap-2">
          {items.map((it, i) => (
            <Button key={i} label={it.header || `Pergunta ${i + 1}`} variant={i === current ? 'primary' : 'secondary'} onPress={() => setCurrent(i)} />
          ))}
        </View>
      ) : null}
      <AppText>{item.question}</AppText>
      {item.options.map((o, oi) => {
        const checked = selected[current]!.includes(oi);
        return (
          <Pressable
            key={oi}
            accessibilityRole={item.multi_select ? 'checkbox' : 'radio'}
            accessibilityLabel={o.label}
            accessibilityState={{ checked, disabled: busy || typing }}
            disabled={busy || typing}
            onPress={() => toggle(oi)}
            className={`gap-1 rounded-xl border p-3 ${checked ? 'border-app-accent' : 'border-app-border'}`}
          >
            <AppText>{`${checked ? '●' : '○'} ${o.label}`}</AppText>
            {o.recommended ? <AppText variant="muted">Recomendada</AppText> : null}
            {o.description ? <AppText variant="muted">{o.description}</AppText> : null}
          </Pressable>
        );
      })}
      <TextInput
        accessibilityLabel="Outra resposta"
        placeholder="Outra resposta"
        value={texts[current]}
        maxLength={2000}
        editable={!busy}
        onChangeText={(t) => setTexts((prev) => prev.map((x, j) => (j === current ? t : x)))}
        className={INPUT}
      />
      <Button label="Responder" onPress={() => onAnswer(question.id, { answers })} disabled={busy || !complete} />
    </View>
  );
}

function PermissionBody({ question, busy, onAnswer, loadScreen }: Props & { question: Permission }) {
  const open = question.status === 'open';
  const [excerpt, setExcerpt] = useState<string | null>(null);
  const [showing, setShowing] = useState(false);
  const [denying, setDenying] = useState(false);
  const [text, setText] = useState('');
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void loadScreen(question.id).then((t) => {
      if (alive) setExcerpt(t);
    });
    return () => {
      alive = false;
    };
  }, [open, question.id, loadScreen]);
  return (
    <View className="gap-2">
      <AppText>{`${tabLabel(question)} pede permissão para usar «${question.payload.tool_name}»`}</AppText>
      {open && excerpt !== null ? <Button label="Tela da aba" variant="ghost" onPress={() => setShowing((v) => !v)} /> : null}
      {open && showing && excerpt !== null ? <AppText className="font-mono text-xs">{excerpt}</AppText> : null}
      {open ? (
        <View className="gap-2">
          <View className="flex-row gap-2">
            <View className="flex-1">
              <Button label="Permitir" onPress={() => onAnswer(question.id, { allow: true })} disabled={busy} />
            </View>
            <View className="flex-1">
              <Button label="Negar" variant="danger" onPress={() => onAnswer(question.id, { allow: false })} disabled={busy} />
            </View>
          </View>
          <Button label="Negar e dizer…" variant="secondary" onPress={() => setDenying(true)} disabled={busy} />
          {denying ? (
            <View className="gap-2">
              <TextInput accessibilityLabel="O que dizer à aba" value={text} maxLength={2000} editable={!busy} onChangeText={setText} className={INPUT} />
              <Button label="Enviar" variant="danger" onPress={() => onAnswer(question.id, { allow: false, text: text.trim() })} disabled={busy || !text.trim()} />
            </View>
          ) : null}
        </View>
      ) : (
        answerSummary(question).map((line, i) => <AppText key={i}>{line}</AppText>)
      )}
    </View>
  );
}
