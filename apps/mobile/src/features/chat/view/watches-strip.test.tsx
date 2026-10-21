import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ChatWatch } from '../model/types';
import { WatchesStrip } from './watches-strip';

const NOW = new Date(2026, 9, 21, 9, 0);

const watch = (patch: Partial<ChatWatch> = {}): ChatWatch => ({
  id: 'w1',
  kind: 'pr',
  target_id: 'pr-511',
  label: 'PR #511 Mostrar assinaturas',
  events: ['merged'],
  recurring: false,
  note: '',
  created_at: NOW.toISOString(),
  expires_at: new Date(2026, 9, 21, 18, 0).toISOString(),
  fire_count: 0,
  ...patch,
});

describe('WatchesStrip (TER-1099)', () => {
  it('is hidden while there is no watch', async () => {
    await render(<WatchesStrip watches={[]} onCancel={jest.fn()} now={NOW} />);
    expect(screen.queryByTestId('watches-strip')).toBeNull();
  });

  it('names the one watch folded; unfolded, each row says what it follows, until when, its note, and cancels it', async () => {
    const onCancel = jest.fn();
    const watches = [watch(), watch({ id: 'w2', kind: 'tab', label: 'api', events: ['finished', 'error'], recurring: true, note: 'Rodar os testes depois.' })];
    const { rerender } = await render(<WatchesStrip watches={[watches[0]!]} onCancel={onCancel} now={NOW} />);
    expect(screen.getByText('Acompanhando: PR #511 Mostrar assinaturas')).toBeTruthy();
    await rerender(<WatchesStrip watches={watches} onCancel={onCancel} now={NOW} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Acompanhando (2)' }));
    expect(screen.getByText(/^Quando for mergeado · até \d{2}:\d{2}$/)).toBeTruthy();
    expect(screen.getByText(/^Quando terminar, der erro · Recorrente · até \d{2}:\d{2}$/)).toBeTruthy();
    expect(screen.getByText('Rodar os testes depois.')).toBeTruthy();
    expect(screen.getByText('Aba')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Cancelar acompanhamento de api' }));
    expect(onCancel).toHaveBeenCalledWith('w2');
  });
});
