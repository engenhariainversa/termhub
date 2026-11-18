import { fireEvent, render, screen, within } from '@testing-library/react-native';
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
    await first.unmount();
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

  it('50 cards scroll inside the card, the buttons stay outside the list, and approve or deny all 50 (TER-1192)', async () => {
    const onDecide = jest.fn();
    const many = Array.from({ length: 50 }, (_, i) => action(`m${i}`, { tool: 'create_task', summary: `criar o card ${i}` }));
    await render(<ActionGroupCard actions={many} busy={false} onDecide={onDecide} onShowSeparately={jest.fn()} />);
    const list = screen.getByTestId('action-group-list');
    expect(list.props.className).toContain('max-h-80');
    expect(within(list).queryByRole('button', { name: 'Aprovar selecionadas (50)' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Aprovar selecionadas (50)' }));
    expect(onDecide.mock.calls[0][0]).toHaveLength(50);
    await fireEvent.press(screen.getByRole('button', { name: 'Recusar todas' }));
    expect(onDecide.mock.calls[1][0].every((d: { decision: string }) => d.decision === 'deny')).toBe(true);
  });

  it('says once why the cards were asked when the open mode ran out of its hourly limit (TER-1192)', async () => {
    await render(<ActionGroupCard actions={[action('b1', { error_code: 'OPEN_BUDGET' }), action('b2', { error_code: 'OPEN_BUDGET' })]} busy={false} onDecide={jest.fn()} onShowSeparately={jest.fn()} />);
    expect(screen.getAllByText('Pediu confirmação porque o limite por hora do modo liberado acabou.')).toHaveLength(1);
  });
});
