import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ChatAction } from '../model/types';
import { ActionGroupCard } from './action-group-card';

const action = (id: string, over: Partial<ChatAction> = {}): ChatAction => ({
  id,
  tool: 'send_input',
  args: {},
  class: 'write',
  status: 'pending',
  machine_id: null,
  project_id: 'p-docverse',
  tab_id: null,
  grant_id: null,
  summary: `digitar na aba ${id}`,
  created_at: new Date().toISOString(),
  ...over,
});

describe('ActionGroupCard', () => {
  it('approves the ticked cards and denies the rest in one call', async () => {
    const onDecide = jest.fn();
    await render(<ActionGroupCard actions={[action('g1'), action('g2', { class: 'irreversible', summary: 'fechar a aba g2' })]} busy={false} onDecide={onDecide} onShowSeparately={jest.fn()} />);
    expect(screen.getByText('As desmarcadas serão recusadas.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Aprovar selecionadas (1)' }));
    expect(onDecide).toHaveBeenCalledWith([
      { id: 'g1', decision: 'approve' },
      { id: 'g2', decision: 'deny' },
    ]);
  });

  it('keeps the ticks across a remount, so a retry never turns ticked irreversible cards into refusals (TER-530)', async () => {
    const actions = [action('t1', { class: 'irreversible', summary: 'fechar a aba 1' }), action('t2', { class: 'irreversible', summary: 'fechar a aba 2' }), action('t3')];
    const first = await render(<ActionGroupCard actions={actions} busy={false} onDecide={jest.fn()} onShowSeparately={jest.fn()} />);
    await fireEvent.press(screen.getByRole('checkbox', { name: 'fechar a aba 1' }));
    await fireEvent.press(screen.getByRole('checkbox', { name: 'fechar a aba 2' }));
    // The PIN step failed (the 429) and the group remounted: a new pending card moved its list key.
    first.unmount();
    const onDecide = jest.fn();
    await render(<ActionGroupCard actions={[...actions, action('t4')]} busy={false} onDecide={onDecide} onShowSeparately={jest.fn()} />);
    expect(screen.getByRole('checkbox', { name: 'fechar a aba 1' }).props.accessibilityState).toMatchObject({ checked: true });
    await fireEvent.press(screen.getByRole('button', { name: 'Aprovar selecionadas (4)' }));
    expect(onDecide).toHaveBeenCalledWith([
      { id: 't1', decision: 'approve' },
      { id: 't2', decision: 'approve' },
      { id: 't3', decision: 'approve' },
      { id: 't4', decision: 'approve' },
    ]);
  });
});
