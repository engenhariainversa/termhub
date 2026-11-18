import { fireEvent, render, screen } from '@testing-library/react-native';
import { chatTimeline } from '../model/timeline';
import type { ChatAction, TabQuestion, TabSuggestion } from '../model/types';
import { PendingBar } from './pending-bar';

const at = (n: number) => `2026-09-30T12:00:0${n}.000Z`;
const action = (id: string, extra: Partial<ChatAction> = {}): ChatAction => ({
  id,
  tool: 'send_input',
  args: {},
  class: 'write',
  status: 'pending',
  machine_id: null,
  project_id: null,
  tab_id: 't1',
  grant_id: null,
  summary: `digitar ${id} na aba api`,
  created_at: at(1),
  ...extra,
});
const common = { tab_id: 't1', tab_name: 'api', status: 'open', error_code: null, created_at: at(2), answered_at: null, closed_at: null } as const;
const choice = { ...common, id: 'q1', kind: 'choice', payload: { questions: [{ question: 'Rodar os testes?', header: 'Testes', multi_select: false, options: [] }] }, answer: null } as TabQuestion;
const permission = { ...common, id: 'q2', tab_name: null, kind: 'permission', payload: { tool_name: 'Bash' }, answer: null } as TabQuestion;
const suggestion = { ...common, id: 's1', kind: 'suggestion', payload: { text: 'commit it' }, answer: null } as TabSuggestion;

async function renderBar(actions: ChatAction[], questions: TabQuestion[] = [], suggestions: TabSuggestion[] = [], deciding = false) {
  const onJump = jest.fn();
  const onApprove = jest.fn();
  await render(<PendingBar entries={chatTimeline([], actions, questions, suggestions)} deciding={deciding} onJump={onJump} onApprove={onApprove} />);
  return { onJump, onApprove };
}

describe('PendingBar (spec 2026-09-30 §2.1)', () => {
  it('is hidden while nothing waits: decided cards, answered questions and suggestions do not count', async () => {
    await renderBar([action('a1', { status: 'executed' })], [{ ...choice, status: 'answered' } as TabQuestion], [suggestion]);
    expect(screen.queryByTestId('pending-bar')).toBeNull();
  });

  it('counts one pending card as "1 pendente", collapsed', async () => {
    await renderBar([action('a1')], [], [suggestion]);
    expect(screen.getByRole('button', { name: /1 pendente$/, expanded: false })).toBeTruthy();
    expect(screen.queryByText('digitar a1 na aba api')).toBeNull();
  });

  it('counts pending confirmations plus open choices and permissions, never suggestions; expanded it lists one line each', async () => {
    await renderBar([action('a1'), action('a2', { status: 'denied' })], [choice, permission], [suggestion]);
    await fireEvent.press(screen.getByRole('button', { name: /3 pendentes$/, expanded: false }));
    expect(screen.getByRole('button', { name: /3 pendentes$/, expanded: true })).toBeTruthy();
    expect(screen.getByText('digitar a1 na aba api')).toBeTruthy();
    expect(screen.getByText('A aba «api» pergunta: Rodar os testes?')).toBeTruthy();
    expect(screen.getByText('Uma aba pede permissão para usar «Bash»')).toBeTruthy();
    expect(screen.queryByText(/commit it/)).toBeNull();
  });

  it('a line calls onJump with its card\'s id and collapses the bar', async () => {
    const { onJump } = await renderBar([action('a1')], [choice]);
    await fireEvent.press(screen.getByRole('button', { name: /2 pendentes$/ }));
    await fireEvent.press(screen.getByText('A aba «api» pergunta: Rodar os testes?'));
    expect(onJump).toHaveBeenCalledWith('q1');
    expect(screen.queryByText('digitar a1 na aba api')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: /2 pendentes$/ }));
    await fireEvent.press(screen.getByText('digitar a1 na aba api'));
    expect(onJump).toHaveBeenLastCalledWith('a1');
  });

  it('offers "Aprovar as reversíveis (n)" from two pending writes, approving only those', async () => {
    const { onApprove } = await renderBar([action('a1'), action('a2', { class: 'irreversible' }), action('a3')]);
    await fireEvent.press(screen.getByRole('button', { name: /3 pendentes$/ }));
    await fireEvent.press(screen.getByRole('button', { name: 'Aprovar as reversíveis (2)' }));
    expect(onApprove).toHaveBeenCalledWith(['a1', 'a3']);
  });

  it('does not offer the batch for a single pending write', async () => {
    await renderBar([action('a1'), action('a2', { class: 'irreversible' })]);
    await fireEvent.press(screen.getByRole('button', { name: /2 pendentes$/ }));
    expect(screen.queryByRole('button', { name: /Aprovar as reversíveis/ })).toBeNull();
  });

  it('approves every pending write at once, 50 of them too (TER-1192)', async () => {
    const { onApprove } = await renderBar(Array.from({ length: 50 }, (_, i) => action(`a${i}`)));
    await fireEvent.press(screen.getByRole('button', { name: /50 pendentes$/ }));
    await fireEvent.press(screen.getByRole('button', { name: 'Aprovar as reversíveis (50)' }));
    expect(onApprove.mock.calls[0]![0]).toHaveLength(50);
  });

  it('disables the batch while a decision is in flight', async () => {
    const { onApprove } = await renderBar([action('a1'), action('a2')], [], [], true);
    await fireEvent.press(screen.getByRole('button', { name: /2 pendentes$/ }));
    const batch = screen.getByRole('button', { name: 'Aprovar as reversíveis (2)' });
    expect(batch).toBeDisabled();
    await fireEvent.press(batch);
    expect(onApprove).not.toHaveBeenCalled();
  });
});
