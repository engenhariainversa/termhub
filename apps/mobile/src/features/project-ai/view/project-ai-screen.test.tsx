import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));
jest.mock('@/features/project-ai/viewmodel/deps', () => {
  const { stores } = require('../../../../test/helpers/ui-stores');
  return { projectAiDeps: { api: stores.api, session: () => stores.store.getState() } };
});

const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, useLocalSearchParams: () => ({ projectId: 'p-termhub' }) }));

import type { TProjectAiResponse } from '@/services/api/contract';
import { ApiError } from '@/services/api/errors';
import { enrolStores, stores } from '../../../../test/helpers/ui-stores';
import { ProjectAiScreen } from './project-ai-screen';

const LOAD = { timeout: 15_000 };

const RESPONSE: TProjectAiResponse = {
  ai: { accounts: ['a2', 'gone', 'a1'], models: { claude: null, chatgpt: null } },
  available: [
    { id: 'a1', label: 'Pessoal', provider: 'claude', machine_id: 'm1', machine_name: 'jarvis', default: true },
    { id: 'a2', label: 'Trabalho', provider: 'claude', machine_id: 'm1', machine_name: 'jarvis', default: false },
    { id: 'a3', label: 'Codex Pedro', provider: 'chatgpt', machine_id: 'm1', machine_name: 'jarvis', default: true },
  ],
};

beforeAll(async () => {
  await enrolStores();
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const fn of Object.values(mockRouter)) fn.mockClear();
});

const saveButton = () => screen.getByRole('button', { name: 'Salvar' });

describe('Contas e modelo do projeto', () => {
  it('lists the included accounts numbered, the others with a toggle, and one model choice per provider', async () => {
    jest.spyOn(stores.api, 'getProjectAi').mockResolvedValue(RESPONSE);
    await render(<ProjectAiScreen />);
    expect(screen.getByText('Contas e modelo do projeto')).toBeTruthy();
    expect(await screen.findByText('1. Trabalho · Claude · jarvis', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText('2. Pessoal (login padrão) · Claude · jarvis')).toBeTruthy();
    expect(screen.getByText('Codex Pedro (login padrão) · Codex · jarvis')).toBeTruthy();
    expect(screen.getByLabelText('Incluir Codex Pedro')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Subir Trabalho' }).props.accessibilityState.disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Descer Pessoal' }).props.accessibilityState.disabled).toBe(true);
    expect(screen.getByText('Modelo do Claude')).toBeTruthy();
    expect(screen.getByText('Modelo do Codex')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'opus' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'fable' })).toBeTruthy(); // TER-1097
    // Aliases are Claude's only: one "Padrão do CLI" and one "Outro id…" per provider, one "opus".
    expect(screen.getAllByRole('radio', { name: 'Padrão do CLI' })).toHaveLength(2);
    expect(screen.getAllByRole('radio', { name: 'opus' })).toHaveLength(1);
    expect(screen.getAllByRole('radio', { name: 'fable' })).toHaveLength(1);
    // The unknown id is already out of the edit: nothing to save yet.
    expect(saveButton().props.accessibilityState.disabled).toBe(true);
  });

  it('says so when no account is chosen', async () => {
    jest.spyOn(stores.api, 'getProjectAi').mockResolvedValue({ ...RESPONSE, ai: { accounts: [], models: { claude: null, chatgpt: null } } });
    await render(<ProjectAiScreen />);
    expect(await screen.findByText('Sem contas escolhidas, cada início de agente pede a conta, como hoje.', undefined, LOAD)).toBeTruthy();
  });

  it('reorders, removes and adds, then saves the known accounts and the model, and says so', async () => {
    jest.spyOn(stores.api, 'getProjectAi').mockResolvedValue(RESPONSE);
    const save = jest.spyOn(stores.api, 'saveProjectAi').mockImplementation(async (_auth, _id, ai) => ({ ai, available: RESPONSE.available }));
    await render(<ProjectAiScreen />);
    await screen.findByText('1. Trabalho · Claude · jarvis', undefined, LOAD);

    await fireEvent.press(screen.getByRole('button', { name: 'Subir Pessoal' }));
    expect(screen.getByText('1. Pessoal (login padrão) · Claude · jarvis')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Remover Trabalho' }));
    expect(screen.getByText('Trabalho · Claude · jarvis')).toBeTruthy();
    await fireEvent(screen.getByLabelText('Incluir Codex Pedro'), 'valueChange', true);
    expect(screen.getByText('2. Codex Pedro (login padrão) · Codex · jarvis')).toBeTruthy();
    await fireEvent.press(screen.getByRole('radio', { name: 'sonnet' }));

    expect(saveButton().props.accessibilityState.disabled).toBe(false);
    await fireEvent.press(saveButton());
    expect(save).toHaveBeenCalledWith(expect.anything(), 'p-termhub', { accounts: ['a1', 'a3'], models: { claude: 'sonnet', chatgpt: null } });
    expect(await screen.findByText('Contas e modelo salvos.', undefined, LOAD)).toBeTruthy();
    expect(saveButton().props.accessibilityState.disabled).toBe(true);
  });

  it('checks a free model id: the format error blocks saving, a full Claude id warns', async () => {
    jest.spyOn(stores.api, 'getProjectAi').mockResolvedValue(RESPONSE);
    await render(<ProjectAiScreen />);
    await screen.findByText('Modelo do Claude', undefined, LOAD);

    await fireEvent.press(screen.getAllByRole('radio', { name: 'Outro id…' })[0]!);
    // Nothing typed yet: no message, and nothing to save.
    expect(saveButton().props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(screen.getByLabelText('Id do modelo do Claude'), 'opus 4');
    expect(screen.getByText('Use só letras, números, ponto, hífen, dois-pontos ou colchetes.')).toBeTruthy();
    expect(saveButton().props.accessibilityState.disabled).toBe(true);

    await fireEvent.changeText(screen.getByLabelText('Id do modelo do Claude'), 'claude-opus-4-1');
    expect(screen.queryByText('Use só letras, números, ponto, hífen, dois-pontos ou colchetes.')).toBeNull();
    expect(screen.getByText('Um CLI mais antigo numa máquina pode não reconhecer este id. Um apelido (fable, opus, sonnet, haiku) o próprio CLI resolve para o modelo mais novo.')).toBeTruthy();
    expect(saveButton().props.accessibilityState.disabled).toBe(false);
  });

  it("shows the server's own sentence when the save is refused", async () => {
    jest.spyOn(stores.api, 'getProjectAi').mockResolvedValue(RESPONSE);
    jest.spyOn(stores.api, 'saveProjectAi').mockRejectedValue(new ApiError(400, 'BAD_REQUEST', 'A conta "Trabalho" está na máquina jarvis, que não está ligada ao projeto'));
    await render(<ProjectAiScreen />);
    await screen.findByText('1. Trabalho · Claude · jarvis', undefined, LOAD);
    await fireEvent.press(screen.getByRole('button', { name: 'Remover Pessoal' }));
    await fireEvent.press(saveButton());
    await waitFor(() => expect(screen.getByText('A conta "Trabalho" está na máquina jarvis, que não está ligada ao projeto')).toBeTruthy(), LOAD);
    expect(screen.queryByText('Contas e modelo salvos.')).toBeNull();
  });

  it('loads through the mock server and saves there too', async () => {
    await render(<ProjectAiScreen />);
    expect(await screen.findByText('Sem contas escolhidas, cada início de agente pede a conta, como hoje.', undefined, LOAD)).toBeTruthy();
    await fireEvent(screen.getByLabelText('Incluir Claude Trabalho'), 'valueChange', true);
    await fireEvent.press(saveButton());
    expect(await screen.findByText('Contas e modelo salvos.', undefined, LOAD)).toBeTruthy();
    expect((await stores.api.getProjectAi(stores.store.getState().auth(), 'p-termhub')).ai.accounts).toEqual(['acc-2']);
  });
});
