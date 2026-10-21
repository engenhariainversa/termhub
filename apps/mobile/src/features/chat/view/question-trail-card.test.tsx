import { fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import type { TabQuestion } from '../model/types';
import { QuestionTrailCard } from './question-trail-card';

const question = (id: string): TabQuestion =>
  ({ id, tab_id: 't1', tab_name: 'codex · ChatGPT', kind: 'permission', status: 'answered_in_tab', answer: null, payload: { tool_name: 'Bash', agent: 'codex', question: `Posso rodar ${id}?` }, error_code: null, created_at: '2026-10-21T00:00:00.000Z', answered_at: null, closed_at: null }) as TabQuestion;

const renderLine = (q: TabQuestion) => <Text>{(q.payload as { question?: string }).question}</Text>;

describe('QuestionTrailCard (TER-1108)', () => {
  it('starts closed, with a line saying how many and how they ended, and opens to the cards on a tap', async () => {
    const questions = Array.from({ length: 4 }, (_, i) => question(`q${i}`));
    await render(<QuestionTrailCard questions={questions} renderQuestion={renderLine} />);
    const toggle = screen.getByRole('button', { name: '4 permissões do Codex respondidas na aba' });
    expect(toggle.props.accessibilityState).toMatchObject({ expanded: false });
    expect(screen.queryByText('Posso rodar q0?')).toBeNull();

    await fireEvent.press(toggle);
    expect(screen.getAllByText(/^Posso rodar q\d\?$/)).toHaveLength(4);

    await fireEvent.press(screen.getByRole('button'));
    expect(screen.queryByText('Posso rodar q0?')).toBeNull();
  });

  it('stays open across a remount once the person opened it (the list recycles rows)', async () => {
    const questions = [question('x1'), question('x2')];
    const first = await render(<QuestionTrailCard questions={questions} renderQuestion={renderLine} />);
    await fireEvent.press(screen.getByRole('button'));
    first.unmount();
    await render(<QuestionTrailCard questions={questions} renderQuestion={renderLine} />);
    expect(screen.getByText('Posso rodar x1?')).toBeTruthy();
  });
});
