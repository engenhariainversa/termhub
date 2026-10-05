import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

jest.mock('@/features/automation/viewmodel/usePauseStore', () => ({ usePauseStore: require('../../../../test/helpers/ui-stores').stores.pause }));
jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));
jest.mock('@/features/progress/viewmodel/useProgressStore', () => ({ useProgressStore: require('../../../../test/helpers/ui-stores').stores.progress }));
jest.mock('expo-router', () => ({
  useFocusEffect: (cb: () => void | (() => void)) => {
    require('react').useEffect(cb, [cb]);
  },
}));

import { useProgressStore } from '@/features/progress/viewmodel/useProgressStore';
import { setLocale } from '@/i18n';
import { mockProgress } from '@/services/api/mock/handlers/progress';
import { enrolStores, stores } from '../../../../test/helpers/ui-stores';
import { ProgressScreen } from './progress-screen';

const LOAD = { timeout: 15_000 };

beforeAll(async () => {
  await enrolStores();
});
beforeEach(() => {
  useProgressStore.setState({ epics: [], feed: [], loading: false, refreshing: false, error: null });
});
afterEach(() => {
  useProgressStore.getState().stopPolling();
  jest.restoreAllMocks();
});

describe('Progresso', () => {
  it('shows the Automático feed, newest first, and the badge on the automatic tab', async () => {
    await render(<ProgressScreen />);
    const feed = await screen.findByTestId('progress-feed', {}, LOAD);
    expect(within(feed).getByText('TER-183: PR aberto')).toBeTruthy();
    expect(within(feed).getByText('TER-183 iniciado em jarvis (pessoal)')).toBeTruthy();
    expect(within(feed).getByText('PR #12')).toBeTruthy();
    expect(within(feed).getAllByText('#abcdef').length).toBe(2);
    const texts = within(feed).getAllByText(/TER-183/).map((n) => n.props.children);
    expect(texts[0]).toBe('TER-183: PR aberto');
  });

  it('badges the tab an automatic run started', async () => {
    const progress = mockProgress(Date.now());
    progress.epics[0]!.cards[0]!.agents![0]!.automatic = true;
    jest.spyOn(stores.api, 'progress').mockResolvedValue(progress);
    await render(<ProgressScreen />);
    await act(async () => fireEvent.press(await screen.findByText('Visão gerencial', {}, LOAD)));
    expect(screen.getByLabelText('automático')).toBeTruthy();
  });

  it('has no feed section when there is nothing to show', async () => {
    jest.spyOn(stores.api, 'progress').mockResolvedValue({ epics: [], feed: [], generated_at: new Date().toISOString() });
    await render(<ProgressScreen />);
    await waitFor(() => expect(screen.getByText('Nenhum épico em andamento')).toBeTruthy(), LOAD);
    expect(screen.queryByTestId('progress-feed')).toBeNull();
  });

  it('in English: the agents waiting and the estimate', async () => {
    setLocale('en');
    try {
      await render(<ProgressScreen />);
      expect(await screen.findByText('Visão gerencial', {}, LOAD)).toBeTruthy();
      expect(screen.getByText('1 agent waiting for you')).toBeTruthy();
    } finally {
      await act(async () => setLocale(null));
    }
  });

  it('loads on focus and shows the epic, its percent and who waits for the user', async () => {
    const load = jest.spyOn(stores.api, 'progress');
    await render(<ProgressScreen />);
    expect(load).toHaveBeenCalled();
    expect(await screen.findByText('Visão gerencial', {}, LOAD)).toBeTruthy();
    expect(screen.getByText('50%')).toBeTruthy();
    expect(screen.getByText('1 agente esperando você')).toBeTruthy();
  });

  it('expands an epic to its cards and agents', async () => {
    await render(<ProgressScreen />);
    const title = await screen.findByText('Visão gerencial', {}, LOAD);
    await act(async () => fireEvent.press(title));
    expect(screen.getByText('TER-183 Painel de progresso')).toBeTruthy();
    expect(screen.getByText(/api · esperando você/)).toBeTruthy();
    expect(screen.getAllByText('~20–45 min de trabalho').length).toBeGreaterThan(0);
  });

  it('a long-press on a card tags it for automatic work and shows the badge', async () => {
    await render(<ProgressScreen />);
    await act(async () => fireEvent.press(await screen.findByText('Visão gerencial', {}, LOAD)));
    expect(screen.queryByLabelText('automático')).toBeNull();
    await act(async () => fireEvent(screen.getByLabelText('TER-183 Painel de progresso'), 'longPress'));
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Marcar como automático' })));
    await waitFor(() => expect(screen.getByLabelText('automático')).toBeTruthy());
  });

  it('tells assistive tech whether an epic is expanded', async () => {
    await render(<ProgressScreen />);
    await screen.findByText('Visão gerencial', {}, LOAD);
    const epic = screen.getByRole('button', { expanded: false });
    await act(async () => fireEvent.press(epic));
    expect(screen.getByRole('button', { expanded: true })).toBeTruthy();
  });

  it('spins only for a pull, not for the background poll, and a pull refreshes', async () => {
    await render(<ProgressScreen />);
    await screen.findByText('Visão gerencial', {}, LOAD);
    const control = () => screen.getByTestId('progress-list').props.refreshControl;
    await act(async () => useProgressStore.setState({ loading: true }));
    expect(control().props.refreshing).toBe(false);
    await act(async () => useProgressStore.setState({ loading: false, refreshing: true }));
    expect(control().props.refreshing).toBe(true);
    await act(async () => useProgressStore.setState({ refreshing: false }));
    const refresh = jest.spyOn(useProgressStore.getState(), 'refresh');
    await act(async () => control().props.onRefresh());
    expect(refresh).toHaveBeenCalled();
  });

  it('shows the CI line and the PR badges of an expanded card', async () => {
    await render(<ProgressScreen />);
    expect(await screen.findByText('PRs: 1 aberto · 1 falhou', {}, LOAD)).toBeTruthy();
    const title = screen.getByText('Visão gerencial');
    await act(async () => fireEvent.press(title));
    expect(screen.getByText('PR #12 · CI falhou: lint')).toBeTruthy();
  });

  it('shows the empty state', async () => {
    jest.spyOn(stores.api, 'progress').mockResolvedValue({ epics: [], feed: [], generated_at: '' });
    await render(<ProgressScreen />);
    expect(await screen.findByText('Nenhum épico em andamento', {}, LOAD)).toBeTruthy();
  });

  it('keeps the list off the status bar: inside the safe area, top edge included, the tab bar\'s bottom left alone', async () => {
    await render(<ProgressScreen />);
    await screen.findByText('Visão gerencial', {}, LOAD);
    const safeArea = screen.getByTestId('progress-safe-area');
    expect(safeArea.props.edges).toEqual(['top', 'left', 'right']);
    // The list is what the safe area holds, and fills it: it still scrolls to its last card.
    expect(within(safeArea).getByTestId('progress-list')).toBe(screen.getByTestId('progress-list'));
    expect(within(safeArea).getByText('Visão gerencial')).toBeTruthy();
  });

  it('keeps the safe area around the empty state and the error too', async () => {
    jest.spyOn(stores.api, 'progress').mockRejectedValue(new Error('offline'));
    await render(<ProgressScreen />);
    await waitFor(() => expect(useProgressStore.getState().error).not.toBeNull(), LOAD);
    const safeArea = screen.getByTestId('progress-safe-area');
    expect(within(safeArea).getByText(useProgressStore.getState().error!)).toBeTruthy();
    expect(within(safeArea).getByText('Nenhum épico em andamento')).toBeTruthy();
  });

  it('keeps the epics in a readable column on a wide window (spec 2026-09-28 iPad §2.4)', async () => {
    await render(<ProgressScreen />);
    await screen.findByText('Visão gerencial', {}, LOAD);
    const column = StyleSheet.flatten(screen.getByTestId('progress-list').props.contentContainerStyle);
    expect(column).toMatchObject({ width: '100%', maxWidth: 720, alignSelf: 'center' });
  });
});
