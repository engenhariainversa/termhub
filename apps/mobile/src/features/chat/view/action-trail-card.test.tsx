import { fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import type { ChatAction } from '../model/types';
import { ActionTrailCard } from './action-trail-card';

const action = (id: string, over: Partial<ChatAction> = {}): ChatAction => ({
  id,
  tool: 'close_tab',
  args: {},
  class: 'write',
  status: 'executed',
  machine_id: null,
  project_id: 'p-docverse',
  tab_id: 't1',
  grant_id: 'sg1',
  summary: `fechar a aba «${id}»`,
  created_at: new Date().toISOString(),
  ...over,
});

const renderCard = (a: ChatAction) => <Text>{a.summary}</Text>;

describe('ActionTrailCard (TER-1024)', () => {
  it('starts closed, with a line saying how many and what, and opens to the cards on a tap', async () => {
    const actions = Array.from({ length: 7 }, (_, i) => action(`aba ${i}`));
    await render(<ActionTrailCard actions={actions} renderAction={renderCard} />);
    const toggle = screen.getByRole('button', { name: '7 ações executadas · fechar aba ×7' });
    expect(toggle.props.accessibilityState).toMatchObject({ expanded: false });
    expect(screen.queryByText('fechar a aba «aba 0»')).toBeNull();

    await fireEvent.press(toggle);
    expect(screen.getAllByText(/^fechar a aba «aba \d»$/)).toHaveLength(7);

    await fireEvent.press(screen.getByRole('button'));
    expect(screen.queryByText('fechar a aba «aba 0»')).toBeNull();
  });

  it('says how they ended when they differ', async () => {
    await render(<ActionTrailCard actions={[action('a1'), action('a2'), action('a3', { status: 'denied', grant_id: null })]} renderAction={renderCard} />);
    expect(screen.getByRole('button', { name: '3 ações · 2 executadas, 1 recusada · fechar aba ×3' })).toBeTruthy();
  });

  it('stays open across a remount once the person opened it (the list recycles rows)', async () => {
    const actions = [action('x1'), action('x2')];
    const first = await render(<ActionTrailCard actions={actions} renderAction={renderCard} />);
    await fireEvent.press(screen.getByRole('button'));
    first.unmount();
    await render(<ActionTrailCard actions={actions} renderAction={renderCard} />);
    expect(screen.getByText('fechar a aba «x1»')).toBeTruthy();
  });
});
