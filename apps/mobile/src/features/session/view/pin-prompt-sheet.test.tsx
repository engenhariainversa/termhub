import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));

import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { enrolStores, stores } from '../../../../test/helpers/ui-stores';
import { PinPromptSheet } from './pin-prompt-sheet';

/** The first proof of a file signs P-256 and derives the wrap key: slow while suites share the CPU. */
const LOAD = { timeout: 15_000 };

/** The whole PIN at once, as the system number pad delivers it into the hidden field. */
async function typePin(pin: string) {
  await fireEvent.changeText(screen.getByLabelText('PIN'), pin);
}

/** What the chat store's `decide('approve')` does: the approval performed with the proof, against
 * the mock's own `decide`, which checks the proof (a wrong PIN answers PIN_INVALID). */
function approve(actionId: string): Promise<void> {
  return stores.store
    .getState()
    .requestPinProof(actionId, (proof) => stores.api.decide(stores.store.getState().auth(), actionId, { decision: 'approve', ...proof }));
}

beforeAll(async () => {
  await enrolStores();
});

afterEach(async () => {
  jest.restoreAllMocks();
  // Still mounted here (the library's own cleanup runs after this hook): wrapped in act.
  await act(async () => {
    useSessionStore.getState().cancelPinPrompt();
    useSessionStore.setState({ error: null, attemptsLeft: null, busy: false });
  });
});

describe('PinPromptSheet', () => {
  it('a wrong PIN keeps the prompt open with "PIN incorreto." and the attempts left, clears the field, and the right PIN then goes through', async () => {
    const decide = jest.spyOn(stores.api, 'decide');
    await render(<PinPromptSheet />);
    let approved = false;
    await act(async () => {
      void approve('a-termhub-1').then(
        () => (approved = true),
        () => undefined,
      );
    });
    expect(screen.getByText('Autorizar esta ação')).toBeTruthy();

    await typePin('000000');
    expect(await screen.findByText('PIN incorreto. 2 tentativas restantes.', undefined, LOAD)).toBeTruthy();
    await expect(decide.mock.results[0]!.value).rejects.toMatchObject({ code: 'PIN_INVALID' });
    expect(useSessionStore.getState().pinPrompt).toEqual({ actionId: 'a-termhub-1', decision: 'approve' });
    expect(approved).toBe(false);

    // The field took a fresh six digits: it was cleared and re-enabled after the rejection.
    await typePin('123456');
    await waitFor(() => expect(approved).toBe(true), LOAD);
    expect(decide).toHaveBeenCalledTimes(2);
    expect(useSessionStore.getState()).toMatchObject({ pinPrompt: null, error: null, attemptsLeft: null });
  }, 20_000);

  it('shows that the PIN is being checked, instead of the PIN field, and disables Cancelar while busy', async () => {
    useSessionStore.setState({ pinPrompt: { actionId: 'a1', decision: 'approve' }, busy: true });
    await render(<PinPromptSheet />);
    expect(screen.getByText('Conferindo o PIN…')).toBeTruthy();
    expect(screen.queryByLabelText('PIN')).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancelar' }).props.accessibilityState.disabled).toBe(true);
  });

  it('says "Permitir sempre nesta aba" for approve_tab and "Autorizar esta ação" for approve', async () => {
    useSessionStore.setState({ pinPrompt: { actionId: 'a1', decision: 'approve_tab' } });
    await render(<PinPromptSheet />);
    expect(screen.getByText('Permitir sempre nesta aba')).toBeTruthy();
    expect(screen.queryByText('Autorizar esta ação')).toBeNull();
    await act(async () => {
      useSessionStore.setState({ pinPrompt: { actionId: 'a1', decision: 'approve' } });
    });
    expect(screen.getByText('Autorizar esta ação')).toBeTruthy();
  });

  it('counts the actions of a batch: "Autorizar 2 ações"', async () => {
    useSessionStore.setState({ pinPrompt: { actionId: 'a1', actionIds: ['a1', 'a2'], decision: 'approve' } });
    await render(<PinPromptSheet />);
    expect(screen.getByText('Autorizar 2 ações')).toBeTruthy();
  });
});
