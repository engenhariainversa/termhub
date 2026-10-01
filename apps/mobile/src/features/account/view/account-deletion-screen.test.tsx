import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));
jest.mock('@/features/account/viewmodel/useAccountStore', () => ({ useAccountStore: require('../../../../test/helpers/ui-stores').stores.account }));

import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { enrolStores, stores } from '../../../../test/helpers/ui-stores';
import { AccountDeletionScreen } from './account-deletion-screen';

const LOAD = { timeout: 15_000 };
const PENDING = { pending: true, requested_at: '2026-10-01T12:00:00.000Z', scheduled_at: '2026-10-31T12:00:00.000Z' };
const realLeave = stores.store.getState().leave;

beforeAll(async () => {
  await enrolStores();
});

afterEach(() => {
  jest.restoreAllMocks();
  useSessionStore.setState({ leave: realLeave });
  stores.account.setState({ pending: false, scheduledAt: null, cancelling: false, error: null });
});

describe('Exclusão agendada (TER-720)', () => {
  it('shows the date, and "Cancelar exclusão" calls DELETE and brings the app back', async () => {
    stores.account.setState({ pending: true, scheduledAt: PENDING.scheduled_at });
    const status = jest.spyOn(stores.api, 'accountDeletion');
    const del = jest.spyOn(stores.api, 'cancelAccountDeletion');
    await render(<AccountDeletionScreen />);

    expect(screen.getByText('Sua conta será excluída em 31 de outubro de 2026.')).toBeTruthy();
    expect(status).not.toHaveBeenCalled(); // the date is known: nothing to read

    await fireEvent.press(screen.getByRole('button', { name: 'Cancelar exclusão' }));
    await waitFor(() => expect(stores.account.getState().pending).toBe(false), LOAD);
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('reads the date once when a 403 brought it here without one', async () => {
    stores.account.setState({ pending: true, scheduledAt: null });
    const status = jest.spyOn(stores.api, 'accountDeletion').mockResolvedValue(PENDING);
    await render(<AccountDeletionScreen />);

    expect(await screen.findByText('Sua conta será excluída em 31 de outubro de 2026.', undefined, LOAD)).toBeTruthy();
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('without the date (the status read failed), says the account is marked and still offers the cancel', async () => {
    stores.account.setState({ pending: true, scheduledAt: null });
    jest.spyOn(stores.api, 'accountDeletion').mockRejectedValue(new Error('offline'));
    await render(<AccountDeletionScreen />);

    expect(await screen.findByText('Sua conta está marcada para exclusão.', undefined, LOAD)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancelar exclusão' })).toBeTruthy();
  });

  it('a failed cancel shows the error and stays', async () => {
    stores.account.setState({ pending: true, scheduledAt: PENDING.scheduled_at });
    jest.spyOn(stores.api, 'cancelAccountDeletion').mockRejectedValue(new Error('offline'));
    await render(<AccountDeletionScreen />);

    await fireEvent.press(screen.getByRole('button', { name: 'Cancelar exclusão' }));
    expect(await screen.findByText('Não foi possível falar com o servidor. Tente de novo.', undefined, LOAD)).toBeTruthy();
    expect(stores.account.getState().pending).toBe(true);
  });

  it('"Sair e remover este aparelho" asks first, then calls leave()', async () => {
    stores.account.setState({ pending: true, scheduledAt: PENDING.scheduled_at });
    const leave = jest.fn(async () => undefined);
    useSessionStore.setState({ leave });
    await render(<AccountDeletionScreen />);

    await fireEvent.press(screen.getByRole('button', { name: 'Sair e remover este aparelho' }));
    expect(leave).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Remover' }));
    expect(leave).toHaveBeenCalledTimes(1);
  });
});
