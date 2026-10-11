import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));
jest.mock('@/features/chat/viewmodel/useChatStore', () => ({ useChatStore: require('../../../../test/helpers/ui-stores').stores.chat }));
jest.mock('@/features/tab-chat/viewmodel/useTabChatStore', () => {
  const actual = jest.requireActual('@/features/tab-chat/viewmodel/useTabChatStore');
  return { ...actual, useTabChatStore: (tabId: string) => actual.useTabChatStore(tabId, (id: string) => mockMake(id)) };
});
jest.mock('@/features/chat/viewmodel/use-voice', () => ({
  useVoice: () => ({ state: 'idle', seconds: 0, level: 0, error: null, notice: null, start: jest.fn(), stop: jest.fn(), cancel: jest.fn() }),
  useRecorder: () => ({ state: 'idle', seconds: 0, error: null, start: jest.fn(async () => undefined), stop: jest.fn(async () => null), cancel: jest.fn() }),
}));
// The attachment menu's pickers: a test says what the next pick hands over.
const mockPicked: { files: import('@/features/chat/viewmodel/attachments').PickedFile[] } = { files: [] };
jest.mock('@/features/chat/view/attachment-menu', () => {
  const { Pressable, Text } = require('react-native');
  return {
    AttachmentMenu: ({ open, onPicked, onClose }: { open: boolean; onPicked(f: unknown[]): void; onClose(): void }) =>
      open ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Escolher arquivo" onPress={() => (onPicked(mockPicked.files), onClose())}>
          <Text>Escolher arquivo</Text>
        </Pressable>
      ) : null,
  };
});

let mockTabId = 't-api';
const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: mockBack, replace: jest.fn(), canGoBack: () => true }),
  useLocalSearchParams: () => ({ tabId: mockTabId }),
}));

import type { TTabQuestion } from '@/services/api/contract';
import type { TabChatStore } from '@/features/tab-chat/viewmodel/useTabChatStore';
import { enrolStores, stores } from '../../../../test/helpers/ui-stores';
import { SessionScreen } from './session-screen';

/** Every store the screen made, and a spy on each one's `close`. */
const made: { store: TabChatStore; closed: jest.Mock }[] = [];
function mockMake(id: string): TabChatStore {
  const store = stores.makeTabChat(id);
  const closed = jest.fn();
  const close = store.getState().close;
  store.setState({ close: () => (closed(), close()) });
  made.push({ store, closed });
  return store;
}
const current = () => made[made.length - 1]!.store;

const LOAD = { timeout: 15_000 };
const at = '2026-10-01T10:00:00.000Z';

beforeAll(async () => {
  await enrolStores();
});

beforeEach(() => {
  mockTabId = 't-api';
  mockPicked.files = [];
});

afterEach(() => {
  while (made.length) made.pop()!.store.getState().close();
  jest.restoreAllMocks();
});

async function renderSession(tabId = 't-api') {
  mockTabId = tabId;
  const view = await render(<SessionScreen />);
  await waitFor(() => expect(current().getState().status).not.toBe('loading'), LOAD);
  return view;
}

describe('the conversation', () => {
  it('shows the messages, the tools folded in one row, and the header with state and mode', async () => {
    await renderSession();
    expect(screen.getByText('roda os testes')).toBeTruthy();
    expect(screen.getByText('Vou rodar os testes.')).toBeTruthy();
    expect(screen.getByText('2 ferramentas')).toBeTruthy();
    expect(screen.getByText('api')).toBeTruthy();
    expect(screen.getByText('Trabalhando · Bash')).toBeTruthy();
    expect(screen.getByText('Padrão')).toBeTruthy();
  });

  it('a mode this build does not know reads as itself', async () => {
    await renderSession();
    await act(() => current().setState({ mode: 'auto' }));
    expect(screen.getByText('Automático')).toBeTruthy();
    await act(() => current().setState({ mode: 'turbo' }));
    expect(screen.getByText('turbo')).toBeTruthy();
  });

  it('reaching the top loads the page before, once per page; at the start nothing', async () => {
    await renderSession();
    const read = jest.spyOn(stores.api, 'tabChat');
    const list = screen.getByTestId('session-thread');
    await act(async () => list.props.onEndReached?.());
    await act(async () => list.props.onEndReached?.());
    await waitFor(() => expect(current().getState().loadingEarlier).toBe(false));
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![2]).toBeTruthy();
    await act(() => current().setState({ before: null }));
    await act(async () => screen.getByTestId('session-thread').props.onEndReached?.());
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("open questions come after the last row, with the chat's card, answered through the same route", async () => {
    await renderSession();
    const question: TTabQuestion = { id: 'q1', tab_id: 't-api', tab_name: 'api', status: 'open', error_code: null, created_at: at, answered_at: null, closed_at: null, kind: 'permission', payload: { tool_name: 'Bash' }, answer: null };
    const answer = jest.spyOn(stores.api, 'answerTabQuestion').mockResolvedValueOnce(undefined);
    await act(() => current().setState({ questions: [question] }));
    await fireEvent.press(screen.getByRole('button', { name: 'Permitir' }));
    expect(answer).toHaveBeenCalledWith(expect.anything(), 'q1', { allow: true });
  });
});

describe('the composer', () => {
  it('while the tab works, the send button interrupts; a long press still sends', async () => {
    await renderSession();
    const action = jest.spyOn(stores.api, 'tabAction');
    const send = jest.spyOn(stores.api, 'sendTabMessage');
    await fireEvent.press(screen.getByRole('button', { name: 'Interromper' }));
    expect(action).toHaveBeenCalledWith(expect.anything(), 't-api', 'interrupt');
    await fireEvent.changeText(screen.getByLabelText('Mensagem'), 'depois rode o lint');
    await fireEvent(screen.getByRole('button', { name: 'Interromper' }), 'longPress');
    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.anything(), 't-api', 'depois rode o lint'));
  });

  it('an idle tab gets a plain send button', async () => {
    await renderSession();
    await act(() => current().setState({ tab: { ...current().getState().tab!, state: 'idle', activity: null } }));
    expect(screen.queryByRole('button', { name: 'Interromper' })).toBeNull();
    await fireEvent.changeText(screen.getByLabelText('Mensagem'), 'oi');
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeTruthy();
  });

  it('a refused send shows why under the composer and keeps the text', async () => {
    await renderSession('t-deploy');
    await fireEvent.changeText(screen.getByLabelText('Mensagem'), 'segue');
    await fireEvent.press(screen.getByRole('button', { name: 'Enviar' }));
    expect(await screen.findByText('Responda a pergunta acima antes de enviar uma mensagem')).toBeTruthy();
    expect(screen.getByLabelText('Mensagem').props.value).toBe('segue');
  });

  it("an attachment goes to the tab's machine and its path is a line of the message", async () => {
    await renderSession();
    await act(() => current().setState({ tab: { ...current().getState().tab!, state: 'idle' } }));
    const send = jest.spyOn(stores.api, 'sendTabMessage');
    mockPicked.files = [{ uri: 'file:///x/foto.png', name: 'foto.png', mime: 'image/png', bytes: 10 }];
    await fireEvent.press(screen.getByRole('button', { name: 'Anexar' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Escolher arquivo' }));
    await fireEvent.changeText(screen.getByLabelText('Mensagem'), 'olha isso');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Enviar' })).toBeEnabled());
    await fireEvent.press(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.anything(), 't-api', 'olha isso\n/tmp/termhub-uploads/foto.png'));
  });

  it('a failed upload says so and sends nothing', async () => {
    await renderSession();
    await act(() => current().setState({ tab: { ...current().getState().tab!, state: 'idle' } }));
    jest.spyOn(stores.api, 'uploadTabFile').mockRejectedValueOnce(new Error('offline'));
    const send = jest.spyOn(stores.api, 'sendTabMessage');
    mockPicked.files = [{ uri: 'file:///x/foto.png', name: 'foto.png', mime: 'image/png', bytes: 10 }];
    await fireEvent.press(screen.getByRole('button', { name: 'Anexar' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Escolher arquivo' }));
    expect(await screen.findByText('Não foi possível enviar o arquivo.')).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });
});

/** As the server says it: an `unavailable` frame, once the screen's socket is there to hear it (its
 * `hello` would otherwise land later and say `ready`). */
async function setAvailability(availability: string, tabId = 't-api') {
  await waitFor(async () => {
    await act(() => stores.controls.tabFrame(tabId, { type: 'unavailable', availability }));
    expect(current().getState().availability).toBe(availability);
  }, LOAD);
}

describe('availability', () => {
  it.each(['offline', 'agent_outdated', 'unsupported_machine'])('%s: the line, and a disabled composer', async (availability) => {
    await renderSession();
    await setAvailability(availability);
    expect(screen.getByTestId('session-availability')).toBeTruthy();
    expect(screen.getByLabelText('Mensagem').props.editable).toBe(false);
  });

  it.each(['no_session', 'unsupported_tool'])('%s: the line offers Ver tela, and the composer works', async (availability) => {
    await renderSession();
    await setAvailability(availability);
    expect(screen.getByTestId('session-availability')).toBeTruthy();
    expect(screen.getByLabelText('Mensagem').props.editable).toBe(true);
    const read = jest.spyOn(stores.api, 'tabScreen');
    await fireEvent.press(screen.getByRole('button', { name: 'Ver tela' }));
    await waitFor(() => expect(read).toHaveBeenCalled());
  });

  it('the line reads the reason', async () => {
    await renderSession();
    await setAvailability('offline');
    expect(screen.getAllByText('Máquina offline').length).toBeGreaterThan(0);
  });

  it('a degraded history says so', async () => {
    await renderSession();
    await act(() => current().setState({ degraded: true }));
    expect(screen.getByText('Não consegui ler parte do histórico. Use Ver tela.')).toBeTruthy();
  });
});

describe('the menu', () => {
  it('Limpar conversa asks before sending /clear', async () => {
    await renderSession();
    const action = jest.spyOn(stores.api, 'tabAction');
    await fireEvent.press(screen.getByRole('button', { name: 'Mais ações' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Limpar conversa (/clear)' }));
    expect(screen.getByText('Limpar a conversa desta sessão? O Claude esquece o que foi dito até aqui.')).toBeTruthy();
    expect(action).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Limpar conversa' }));
    await waitFor(() => expect(action).toHaveBeenCalledWith(expect.anything(), 't-api', 'clear'));
  });

  it('Compactar and Alternar modo send their actions; the mode follows', async () => {
    await renderSession();
    const action = jest.spyOn(stores.api, 'tabAction');
    await fireEvent.press(screen.getByRole('button', { name: 'Mais ações' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Compactar (/compact)' }));
    await waitFor(() => expect(action).toHaveBeenCalledWith(expect.anything(), 't-api', 'compact'));
    await fireEvent.press(screen.getByRole('button', { name: 'Mais ações' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Alternar modo' }));
    expect(await screen.findByText('Aceitar edições')).toBeTruthy();
  });

  it('Ver tela opens the raw screen', async () => {
    await renderSession();
    await fireEvent.press(screen.getByRole('button', { name: 'Mais ações' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Ver tela' }));
    expect(await screen.findByText('$ npm test\n842 passed\n> ')).toBeTruthy();
  });
});

it('leaving the screen closes its store', async () => {
  const view = await renderSession();
  const { closed } = made[made.length - 1]!;
  await view.unmount();
  expect(closed).toHaveBeenCalled();
});
