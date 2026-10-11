import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));
jest.mock('@/features/automation/viewmodel/usePauseStore', () => ({ usePauseStore: require('../../../../test/helpers/ui-stores').stores.pause }));
jest.mock('expo-router', () => ({
  useFocusEffect: (cb: () => void | (() => void)) => {
    require('react').useEffect(cb, [cb]);
  },
}));

import { usePauseStore } from '../viewmodel/usePauseStore';
import { enrolStores, stores } from '../../../../test/helpers/ui-stores';
import { PauseCard } from './pause-card';

const LOAD = { timeout: 15_000 };

beforeAll(async () => {
  await enrolStores();
});
beforeEach(() => {
  usePauseStore.setState({ state: null, busy: false, error: null });
});
afterEach(() => {
  usePauseStore.getState().stopPolling();
  jest.restoreAllMocks();
});

describe('PauseCard', () => {
  it('pauses with no PIN, says since when, and resumes only after a confirmation', async () => {
    const pin = jest.spyOn(stores.store.getState(), 'requestPinProof');
    await render(<PauseCard />);
    await act(async () => fireEvent.press(await screen.findByText('Pausar automático', {}, LOAD)));
    expect(await screen.findByText(/^Automático pausado desde \d{2}:\d{2}\.$/, {}, LOAD)).toBeTruthy();
    expect(pin).not.toHaveBeenCalled();

    await act(async () => fireEvent.press(screen.getByText('Retomar automático')));
    // Not resumed yet: the sheet asks first.
    expect(screen.getByText('Retomar o trabalho automático?')).toBeTruthy();
    expect(usePauseStore.getState().state?.paused_at).not.toBeNull();
    await act(async () => fireEvent.press(screen.getByText('Retomar')));
    await waitFor(() => expect(usePauseStore.getState().state?.paused_at).toBeNull(), LOAD);
    expect(pin).not.toHaveBeenCalled();
  });

  it('"Pausar e interromper as abas" asks the server to interrupt', async () => {
    const pause = jest.spyOn(stores.api, 'pauseAutomation');
    await render(<PauseCard />);
    await act(async () => fireEvent.press(await screen.findByText('Pausar e interromper as abas', {}, LOAD)));
    await waitFor(() => expect(pause).toHaveBeenCalledWith(expect.anything(), 'all', true), LOAD);
    await act(async () => fireEvent.press(await screen.findByText('Retomar automático', {}, LOAD)));
    await act(async () => fireEvent.press(screen.getByText('Retomar')));
    await waitFor(() => expect(usePauseStore.getState().state?.paused_at).toBeNull(), LOAD);
  });
});

describe('PauseCard visibility', () => {
  it('is hidden while no project has automatic work on, and never polls on a timer', async () => {
    const spy = jest.spyOn(stores.api, 'getPauseState').mockResolvedValue({ paused_at: null, projects: [], has_automation: false, can_update: true });
    await render(<PauseCard />);
    await waitFor(() => expect(spy).toHaveBeenCalled(), LOAD);
    await act(async () => {});
    expect(screen.queryByText('Pausar automático')).toBeNull();
  });

  it('is hidden without projects:update', async () => {
    jest.spyOn(stores.api, 'getPauseState').mockResolvedValue({ paused_at: null, projects: [], has_automation: true, can_update: false });
    await render(<PauseCard />);
    await act(async () => {});
    expect(screen.queryByText('Pausar automático')).toBeNull();
  });
});
