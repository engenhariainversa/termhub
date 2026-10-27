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

  it('shows one watch on one row: the person\'s line, what happened, until when, and ✕; never the note', async () => {
    const onCancel = jest.fn();
    const w = watch({ summary: 'Te aviso quando o PR #511 for mesclado', note: 'read_last_answer e notify', fire_count: 1, last_event: 'ci_failed', last_fired_at: new Date(2026, 9, 21, 8, 30).toISOString() });
    await render(<WatchesStrip watches={[w]} onCancel={onCancel} now={NOW} />);
    expect(screen.getByText('Te aviso quando o PR #511 for mesclado')).toBeTruthy();
    expect(screen.getByText('CI falhou às 08:30 · até 18:00')).toBeTruthy();
    expect(screen.queryByText(/read_last_answer/)).toBeNull();
    // The detailed events only unfolded.
    expect(screen.queryByText(/Quando for mergeado/)).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Te aviso quando o PR #511 for mesclado' }));
    expect(screen.getByText('PR #511 Mostrar assinaturas · Quando for mergeado · Uma vez')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Cancelar acompanhamento de Te aviso quando o PR #511 for mesclado' }));
    expect(onCancel).toHaveBeenCalledWith('w1');
  });

  it('folds several into "Acompanhando N coisas", unfolded on a press', async () => {
    const onCancel = jest.fn();
    const watches = [watch(), watch({ id: 'w2', kind: 'tab', label: 'api', events: ['finished', 'error'], recurring: true, summary: 'Te aviso quando a aba api parar', target_state: 'working' })];
    await render(<WatchesStrip watches={watches} onCancel={onCancel} now={NOW} />);
    expect(screen.queryByText('Te aviso quando a aba api parar')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Acompanhando 2 coisas' }));
    expect(screen.getByText('PR #511 Mostrar assinaturas: te aviso quando for mergeado')).toBeTruthy();
    expect(screen.getByText('Te aviso quando a aba api parar')).toBeTruthy();
    expect(screen.getByText(/^trabalhando agora · até 18:00$/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Cancelar acompanhamento de Te aviso quando a aba api parar' }));
    expect(onCancel).toHaveBeenCalledWith('w2');
  });
});
