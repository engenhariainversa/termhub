import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';

jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));
jest.mock('@/features/ai-login/viewmodel/useAiLoginStore', () => ({ useAiLoginStore: require('../../../../test/helpers/ui-stores').stores.aiLogin }));
jest.mock('@/features/ai-login/viewmodel/deps', () => {
  const { stores } = require('../../../../test/helpers/ui-stores');
  const { createAiLoginFlow } = require('@/features/ai-login/viewmodel/createAiLoginFlow');
  return {
    makeAiLoginFlow: (accountId: string) =>
      createAiLoginFlow({ api: stores.api, session: () => stores.store.getState(), accountId, onLoggedIn: (id: string) => stores.aiLogin.getState().markOk(id) }),
  };
});

let mockAccountId = 'acc-2';
const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, useLocalSearchParams: () => ({ accountId: mockAccountId }) }));

import { enrolStores, stores } from '../../../../test/helpers/ui-stores';
import { AiLoginScreen } from './ai-login-screen';

const LOAD = { timeout: 15_000 };

beforeAll(async () => {
  await enrolStores();
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const fn of Object.values(mockRouter)) fn.mockClear();
});

describe('Refazer login', () => {
  it('Claude: opens the page, sends the pasted code, then resumes the stuck tab', async () => {
    mockAccountId = 'acc-2';
    stores.controls.setAiLoginState('acc-2', 'login_required');
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const submit = jest.spyOn(stores.api, 'submitAiLogin');
    const resume = jest.spyOn(stores.api, 'resumeAiLoginTabs');
    await render(<AiLoginScreen />);

    expect(await screen.findByText('Claude Trabalho · Claude · jarvis', undefined, LOAD)).toBeTruthy();
    await fireEvent.press(await screen.findByRole('button', { name: 'Abrir página de login' }, LOAD));
    expect(open).toHaveBeenCalledWith(expect.stringContaining('claude.com'));

    const send = screen.getByRole('button', { name: 'Enviar código' });
    expect(send.props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(screen.getByLabelText('Cole o código aqui'), 'abc123');
    await fireEvent.press(screen.getByRole('button', { name: 'Enviar código' }));

    expect(await screen.findByText('Login refeito', undefined, LOAD)).toBeTruthy();
    expect(submit).toHaveBeenCalledWith(expect.anything(), 'acc-2', expect.any(String), 'abc123');
    // The banner's row is fine now.
    expect(stores.aiLogin.getState().accounts.find((a) => a.account_id === 'acc-2')?.state).toBe('ok');
    expect(screen.getByText('Retomar 1 aba?')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Retomar' }));
    expect(await screen.findByText('1 aba retomada.', undefined, LOAD)).toBeTruthy();
    expect(resume).toHaveBeenCalledWith(expect.anything(), 'acc-2', ['t-api']);

    await fireEvent.press(screen.getByRole('button', { name: 'Concluir' }));
    expect(mockRouter.back).toHaveBeenCalled();
  });

  it('Claude: a refused code shows why, and "Tentar de novo" starts over', async () => {
    mockAccountId = 'acc-1';
    const start = jest.spyOn(stores.api, 'startAiLogin');
    await render(<AiLoginScreen />);
    await fireEvent.changeText(await screen.findByLabelText('Cole o código aqui', undefined, LOAD), 'errado');
    await fireEvent.press(screen.getByRole('button', { name: 'Enviar código' }));
    expect(await screen.findByText('O Claude recusou o código. Comece de novo.', undefined, LOAD)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByLabelText('Cole o código aqui', undefined, LOAD)).toBeTruthy();
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('Codex: shows the device code and confirms with "Já autorizei"', async () => {
    mockAccountId = 'acc-3';
    const submit = jest.spyOn(stores.api, 'submitAiLogin');
    await render(<AiLoginScreen />);
    expect(await screen.findByText('ABCD-EFGH1', undefined, LOAD)).toBeTruthy();
    expect(screen.queryByLabelText('Cole o código aqui')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Já autorizei' }));
    expect(await screen.findByText('Login refeito', undefined, LOAD)).toBeTruthy();
    expect(submit).toHaveBeenCalledWith(expect.anything(), 'acc-3', expect.any(String), null);
  });

  it('closing before the end cancels the flow on the machine', async () => {
    mockAccountId = 'acc-1';
    const cancel = jest.spyOn(stores.api, 'cancelAiLogin');
    const view = await render(<AiLoginScreen />);
    await screen.findByLabelText('Cole o código aqui', undefined, LOAD);
    await view.unmount();
    expect(cancel).toHaveBeenCalledWith(expect.anything(), 'acc-1', expect.any(String));
  });

  it('a provider the app cannot log in shows the manual instruction and starts nothing', async () => {
    mockAccountId = 'acc-g';
    jest.spyOn(stores.api, 'aiLoginStatus').mockResolvedValue({
      accounts: [{ account_id: 'acc-g', label: 'Gemini Pedro', provider: 'gemini', machine_id: 'm-jarvis', machine_name: 'jarvis', state: 'login_required', checked_at: null, supported: false }],
    });
    const start = jest.spyOn(stores.api, 'startAiLogin');
    await render(<AiLoginScreen />);
    expect(
      await screen.findByText('O login do Gemini é refeito na própria máquina: abra um terminal em jarvis e entre de novo no CLI.', undefined, LOAD),
    ).toBeTruthy();
    await waitFor(() => expect(start).not.toHaveBeenCalled());
  });
});
