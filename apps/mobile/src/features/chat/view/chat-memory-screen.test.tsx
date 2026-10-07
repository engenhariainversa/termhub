import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert, Linking } from 'react-native';

jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));
jest.mock('@/features/chat/viewmodel/useChatMemoryStore', () => ({ useChatMemoryStore: require('../../../../test/helpers/ui-stores').stores.chatMemory }));
jest.mock('@/features/chat/viewmodel/useMemoryRulesStore', () => ({ useMemoryRulesStore: require('../../../../test/helpers/ui-stores').stores.memoryRules }));

const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

import type { TChatDecision, TConciergeNote, TDecisionsResponse, TLessonItem } from '@/services/api/contract';
import { setLocale } from '@/i18n';
import { TERMHUB_URL } from '@/services/api/config';
import { enrolStores, stores } from '../../../../test/helpers/ui-stores';
import { useChatMemoryStore } from '../viewmodel/useChatMemoryStore';
import { ChatMemoryScreen } from './chat-memory-screen';

/** The first load of a file signs its first P-256 proof, slow while other suites share the CPU. */
const LOAD = { timeout: 15_000 };

function dec(over: Partial<TChatDecision> & { id: string; question: string }): TChatDecision {
  return {
    project_id: null,
    project_name: null,
    header: 'H',
    options: [],
    multi_select: false,
    answer: { labels: ['Sim'] },
    suggested_count: 1,
    accepted_count: 1,
    created_at: new Date().toISOString(),
    ...over,
  };
}

function note(over: Partial<TConciergeNote> & { id: string; question: string }): TConciergeNote {
  return {
    project_id: null,
    project_name: null,
    decision: 'Sim',
    reason: 'Você sempre isola em worktree',
    created_at: new Date().toISOString(),
    ...over,
  };
}

function lesson(over: Partial<TLessonItem> & { id: string; title: string }): TLessonItem {
  return {
    project: null,
    excerpt: 'Um erro que já aconteceu.',
    origin: 'file',
    path: 'docs/lessons/x.md',
    tab_id: null,
    card: null,
    pr: null,
    evidence: 'observed',
    verified: false,
    verified_at: null,
    created_at: new Date().toISOString(),
    ...over,
  };
}

beforeAll(async () => {
  await enrolStores();
});

beforeEach(() => {
  for (const fn of Object.values(mockRouter)) fn.mockClear();
  // Every test starts from an empty notes/lessons list unless it seeds its own — this file's shared
  // mock backend carries no note or lesson fixtures (unlike decisions).
  jest.spyOn(stores.api, 'chatNotes').mockResolvedValue({ notes: [], next_cursor: null });
  jest.spyOn(stores.api, 'chatLessons').mockResolvedValue({ lessons: [], next_cursor: null });
  // "Regras vigentes" has its own tests (memory-rules-section.test.tsx).
  jest.spyOn(stores.api, 'chatRules').mockResolvedValue({ rules: [], proposals: [] });
});

afterEach(() => {
  jest.restoreAllMocks();
  // Every test starts from a clean slate: the store is a singleton shared across this file's tests.
  useChatMemoryStore.setState({
    memory: null,
    decisions: null,
    cursor: null,
    q: '',
    loadingMore: false,
    switching: false,
    forgettingId: null,
    error: null,
    notes: null,
    notesCursor: null,
    loadingMoreNotes: false,
    forgettingNoteId: null,
    notesError: null,
    lessons: null,
    lessonsCursor: null,
    lessonsQ: '',
    loadingMoreLessons: false,
    verifyingLessonId: null,
    forgettingLessonId: null,
    lessonsError: null,
    lessonsNote: null,
  });
});

describe('Memória do chat', () => {
  it('lists the remembered decisions: question, answer, project and counts', async () => {
    await render(<ChatMemoryScreen />);
    expect(await screen.findByText('Usar worktree para essa tarefa?', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText('→ Não')).toBeTruthy();
    expect(screen.getByText(/termhub · .+ · sugerida 3× · aceita 2×/)).toBeTruthy();
    // A free-text answer shows the text, not an empty label list.
    expect(screen.getByText('Qual branch a partir de main?')).toBeTruthy();
    expect(screen.getByText('→ fix/city-sound-ios')).toBeTruthy();
  });

  it('mounts "Regras vigentes", which loads on its own', async () => {
    await render(<ChatMemoryScreen />);
    expect(await screen.findByText('Nenhuma regra vigente nem proposta por enquanto.', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText('Regras vigentes')).toBeTruthy();
    expect(stores.api.chatRules).toHaveBeenCalled();
  });

  it('typing in "Buscar" re-queries with q, debounced', async () => {
    // Real timers throughout (the debounce is only ~300ms, well under `LOAD`'s own timeout):
    // toggling jest's fake timers mid-test, with a real async store already in flight over the
    // mock transport, is fragile here and buys nothing a longer `findBy` wait doesn't already give.
    const spy = jest.spyOn(stores.api, 'chatDecisions');
    await render(<ChatMemoryScreen />);
    await screen.findByText('Usar worktree para essa tarefa?', undefined, LOAD);
    spy.mockClear();

    await fireEvent.changeText(screen.getByTestId('chat-memory-search'), 'branch');
    // Both fixtures show at first (unfiltered): "Qual branch…" is on screen either way, so only the
    // *disappearance* of the other row proves the debounced, filtered re-query actually landed.
    await waitFor(() => expect(screen.queryByText('Usar worktree para essa tarefa?')).toBeNull(), LOAD);
    expect(screen.getByText('Qual branch a partir de main?')).toBeTruthy();
    expect(spy).toHaveBeenLastCalledWith(expect.anything(), 'branch');
  });

  it('unmounting before the debounce fires cancels the pending search: no request is made', async () => {
    // The store is a singleton that outlives this screen (see `cancel()` in
    // createChatMemoryStore.ts): leaving right after typing must not let the debounced search fire
    // later and clobber whatever the next visit's own `load()` shows.
    const spy = jest.spyOn(stores.api, 'chatDecisions');
    const view = await render(<ChatMemoryScreen />);
    await screen.findByText('Usar worktree para essa tarefa?', undefined, LOAD);
    spy.mockClear();

    await fireEvent.changeText(screen.getByTestId('chat-memory-search'), 'branch');
    view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 400)); // real wall-clock, past the 300ms debounce
    expect(spy).not.toHaveBeenCalled();
  });

  it('"Esquecer" asks a native confirm and removes the row once the DELETE resolves', async () => {
    // `mockResolvedValue`, not a call-through spy: this file's mock backend is shared across every
    // test below, and a real DELETE would remove the seeded fixture for good.
    const forget = jest.spyOn(stores.api, 'forgetChatDecision').mockResolvedValue(undefined);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _msg, buttons) => {
      buttons?.find((b) => b.style === 'destructive')?.onPress?.();
    });
    await render(<ChatMemoryScreen />);
    await screen.findByText('Usar worktree para essa tarefa?', undefined, LOAD);

    // Decisions list newest first: `d-branch` (6h ago) is the first row, `d-worktree` (2 days ago) the second.
    await act(async () => fireEvent.press(screen.getAllByRole('button', { name: 'Esquecer' })[0]!));
    expect(alert).toHaveBeenCalled();
    await waitFor(() => expect(forget).toHaveBeenCalledWith(expect.anything(), 'd-branch'), LOAD);
    await waitFor(() => expect(screen.queryByText('Qual branch a partir de main?')).toBeNull(), LOAD);
    expect(screen.getByText('Usar worktree para essa tarefa?')).toBeTruthy(); // the other row stays
  });

  it('the switch calls setChatMemory(false)', async () => {
    // `mockResolvedValue`, not a call-through spy: a real PATCH would flip the shared mock
    // backend's switch for every test that runs after this one in the file.
    const spy = jest.spyOn(stores.api, 'setChatMemory').mockResolvedValue({ enabled: false, autodecide: false, codex_replies: false, available: true, count: 2, notes: 0 });
    await render(<ChatMemoryScreen />);
    const toggle = await screen.findByRole('switch', { name: 'Sugerir respostas com base nas minhas decisões' }, LOAD);
    await act(async () => fireEvent(toggle, 'valueChange', false));
    expect(spy).toHaveBeenCalledWith(expect.anything(), false);
  });

  it('available: false hides the switch and shows "Sugestões indisponíveis neste servidor"', async () => {
    await render(<ChatMemoryScreen />);
    await screen.findByText('Usar worktree para essa tarefa?', undefined, LOAD);
    await act(async () => useChatMemoryStore.setState((s) => ({ memory: s.memory ? { ...s.memory, available: false } : s.memory })));
    expect(screen.getByText('Sugestões indisponíveis neste servidor')).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'Sugerir respostas com base nas minhas decisões' })).toBeNull();
    // The Codex reply card needs no embeddings, so its switch stays.
    expect(screen.getByRole('switch', { name: 'Responder perguntas do Codex pelo chat' })).toBeTruthy();
  });

  it('the Codex reply switch is off by default and calls setChatMemory({ codex_replies })', async () => {
    const spy = jest.spyOn(stores.api, 'setChatMemory').mockResolvedValue({ enabled: true, autodecide: false, codex_replies: true, available: true, count: 2, notes: 0 });
    await render(<ChatMemoryScreen />);
    const sw = await screen.findByRole('switch', { name: 'Responder perguntas do Codex pelo chat' }, LOAD);
    expect(sw.props.value).toBe(false);
    expect(screen.getByText('Quando o Codex termina o turno com uma pergunta, abre um card no chat para você responder sem ir até a aba.')).toBeTruthy();
    await act(async () => fireEvent(sw, 'valueChange', true));
    expect(spy).toHaveBeenCalledWith(expect.anything(), { codex_replies: true });
  });

  it('the "Responder sozinho" switch reflects autodecide and calls setAutodecide(true)', async () => {
    const spy = jest.spyOn(stores.api, 'setChatMemory').mockResolvedValue({ enabled: true, autodecide: true, codex_replies: false, available: true, count: 2, notes: 0 });
    await render(<ChatMemoryScreen />);
    const sw = await screen.findByRole('switch', { name: 'Responder sozinho quando houver precedente' }, LOAD);
    expect(sw.props.value).toBe(false);
    await act(async () => fireEvent(sw, 'valueChange', true));
    expect(spy).toHaveBeenCalledWith(expect.anything(), { autodecide: true });
    expect(screen.getByText(/O concierge espera|espera 60 segundos/)).toBeTruthy();
  });

  it('"Anotações do concierge" lists question, decision, reason and date, and "Esquecer" removes the row after confirming', async () => {
    jest.spyOn(stores.api, 'chatNotes').mockResolvedValueOnce({ notes: [note({ id: 'n1', question: 'Usar worktree para essa tarefa?' })], next_cursor: null });
    const forgetNote = jest.spyOn(stores.api, 'forgetChatNote').mockResolvedValue(undefined);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _msg, buttons) => {
      buttons?.find((b) => b.style === 'destructive')?.onPress?.();
    });
    await render(<ChatMemoryScreen />);
    await screen.findByText('Anotações do concierge', undefined, LOAD);
    await screen.findByText(/Você sempre isola em worktree/, undefined, LOAD);
    expect(screen.getByText('→ Sim')).toBeTruthy();

    // Two "Esquecer" buttons on screen: the decisions' and this note's own. The note's row is the last.
    const forgetButtons = screen.getAllByRole('button', { name: 'Esquecer' });
    await act(async () => fireEvent.press(forgetButtons[forgetButtons.length - 1]!));
    expect(alert).toHaveBeenCalled();
    await waitFor(() => expect(forgetNote).toHaveBeenCalledWith(expect.anything(), 'n1'), LOAD);
    await waitFor(() => expect(screen.queryByText(/Você sempre isola em worktree/)).toBeNull(), LOAD);
  });

  it('no notes shows "Nenhuma anotação ainda."', async () => {
    await render(<ChatMemoryScreen />);
    expect(await screen.findByText('Nenhuma anotação ainda.', undefined, LOAD)).toBeTruthy();
  });

  it('"Carregar mais" appears with a next_cursor and appends the next page', async () => {
    const page1: TDecisionsResponse = { decisions: [dec({ id: 'd1', question: 'Primeira pergunta?' })], next_cursor: 'c2' };
    const page2: TDecisionsResponse = { decisions: [dec({ id: 'd2', question: 'Segunda pergunta?' })], next_cursor: null };
    jest.spyOn(stores.api, 'chatDecisions').mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);
    await render(<ChatMemoryScreen />);
    expect(await screen.findByText('Primeira pergunta?', undefined, LOAD)).toBeTruthy();

    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Carregar mais' })));
    expect(await screen.findByText('Segunda pergunta?', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText('Primeira pergunta?')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Carregar mais' })).toBeNull();
  });

  it('"Voltar" goes back', async () => {
    await render(<ChatMemoryScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Voltar' }, LOAD));
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });

  describe('"Lições" (spec 2026-09-27 failure lessons §6/§8)', () => {
    it('no lessons shows "Nenhuma lição ainda."', async () => {
      await render(<ChatMemoryScreen />);
      expect(await screen.findByText('Nenhuma lição ainda.', undefined, LOAD)).toBeTruthy();
    });

    it('lists title, excerpt, project/origin/evidence/date, and the "verificada" badge when verified', async () => {
      jest.spyOn(stores.api, 'chatLessons').mockResolvedValueOnce({
        lessons: [
          lesson({
            id: 'l1',
            title: 'Migração sem transação',
            project: { id: 'p1', name: 'termhub' },
            origin: 'file',
            path: 'docs/lessons/migration.md',
            evidence: 'fixed',
            verified: true,
          }),
        ],
        next_cursor: null,
      });
      await render(<ChatMemoryScreen />);
      expect(await screen.findByText('Migração sem transação', undefined, LOAD)).toBeTruthy();
      expect(screen.getByText('Um erro que já aconteceu.')).toBeTruthy();
      expect(screen.getByText(/termhub · arquivo docs\/lessons\/migration\.md · corrigida · .+ · verificada/)).toBeTruthy();
    });

    it('"Verificar" calls the API and flips the label to "Desfazer verificação"', async () => {
      jest.spyOn(stores.api, 'chatLessons').mockResolvedValueOnce({ lessons: [lesson({ id: 'l1', title: 'Sintoma X' })], next_cursor: null });
      const verify = jest.spyOn(stores.api, 'verifyChatLesson').mockResolvedValue(lesson({ id: 'l1', title: 'Sintoma X', verified: true, verified_at: new Date().toISOString() }));
      await render(<ChatMemoryScreen />);
      await screen.findByText('Sintoma X', undefined, LOAD);

      await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Verificar' })));
      expect(verify).toHaveBeenCalledWith(expect.anything(), 'l1');
      expect(await screen.findByRole('button', { name: 'Desfazer verificação' }, LOAD)).toBeTruthy();
    });

    it('"Esquecer" asks a native confirm, removes the row and shows the server\'s note', async () => {
      jest.spyOn(stores.api, 'chatLessons').mockResolvedValueOnce({ lessons: [lesson({ id: 'l1', title: 'Sintoma X' })], next_cursor: null });
      const forget = jest
        .spyOn(stores.api, 'forgetChatLesson')
        .mockResolvedValue({ ok: true, note: 'O arquivo continua no repositório; apague-o por um PR para sumir de vez' });
      const alert = jest.spyOn(Alert, 'alert').mockImplementation((title, _msg, buttons) => {
        expect(title).toBe('Esquecer esta lição?');
        buttons?.find((b) => b.style === 'destructive')?.onPress?.();
      });
      await render(<ChatMemoryScreen />);
      await screen.findByText('Sintoma X', undefined, LOAD);

      // Decisions' own fixtures also render "Esquecer" buttons; the lesson's own is the last one.
      const forgetButtons = screen.getAllByRole('button', { name: 'Esquecer' });
      await act(async () => fireEvent.press(forgetButtons[forgetButtons.length - 1]!));
      expect(alert).toHaveBeenCalled();
      await waitFor(() => expect(forget).toHaveBeenCalledWith(expect.anything(), 'l1'), LOAD);
      await waitFor(() => expect(screen.queryByText('Sintoma X')).toBeNull(), LOAD);
      expect(await screen.findByText('O arquivo continua no repositório; apague-o por um PR para sumir de vez', undefined, LOAD)).toBeTruthy();
    });

    it('"Abrir origem" opens the PR link when present', async () => {
      jest.spyOn(stores.api, 'chatLessons').mockResolvedValueOnce({ lessons: [lesson({ id: 'l1', title: 'Sintoma X', pr: 'https://github.com/x/y/pull/1' })], next_cursor: null });
      const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
      await render(<ChatMemoryScreen />);
      await screen.findByText('Sintoma X', undefined, LOAD);

      await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Abrir origem' })));
      expect(open).toHaveBeenCalledWith('https://github.com/x/y/pull/1');
    });

    it('"Abrir origem" opens the web app\'s card URL when there is no PR', async () => {
      jest.spyOn(stores.api, 'chatLessons').mockResolvedValueOnce({ lessons: [lesson({ id: 'l1', title: 'Sintoma X', card: 'TER-205' })], next_cursor: null });
      const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
      await render(<ChatMemoryScreen />);
      await screen.findByText('Sintoma X', undefined, LOAD);

      await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Abrir origem' })));
      expect(open).toHaveBeenCalledWith(`${TERMHUB_URL}/project/TER-205`);
    });

    it('"Abrir origem" is hidden with neither a PR nor a card', async () => {
      jest.spyOn(stores.api, 'chatLessons').mockResolvedValueOnce({ lessons: [lesson({ id: 'l1', title: 'Sintoma X' })], next_cursor: null });
      await render(<ChatMemoryScreen />);
      await screen.findByText('Sintoma X', undefined, LOAD);
      expect(screen.queryByRole('button', { name: 'Abrir origem' })).toBeNull();
    });

    it('"Buscar lições" re-queries with q, debounced', async () => {
      const spy = jest.spyOn(stores.api, 'chatLessons').mockImplementation(async (_auth, q) => {
        const all = [lesson({ id: 'l1', title: 'Sintoma X' }), lesson({ id: 'l2', title: 'Sintoma Y' })];
        return { lessons: q ? all.filter((l) => l.title.toLowerCase().includes(q.toLowerCase())) : all, next_cursor: null };
      });
      await render(<ChatMemoryScreen />);
      await screen.findByText('Sintoma X', undefined, LOAD);
      spy.mockClear();

      await fireEvent.changeText(screen.getByTestId('chat-memory-lessons-search'), 'Y');
      await waitFor(() => expect(screen.queryByText('Sintoma X')).toBeNull(), LOAD);
      expect(screen.getByText('Sintoma Y')).toBeTruthy();
      expect(spy).toHaveBeenLastCalledWith(expect.anything(), 'Y');
    });
  });
});

describe('Memória do chat in English (i18n)', () => {
  beforeEach(() => setLocale('en'));
  afterEach(() => setLocale(null));

  it('shows the screen, the decision rows and the lessons in English', async () => {
    jest.spyOn(stores.api, 'chatLessons').mockResolvedValue({ lessons: [lesson({ id: 'l1', title: 'Pod sem Node', verified: true })], next_cursor: null });
    await render(<ChatMemoryScreen />);
    expect(await screen.findByText('Usar worktree para essa tarefa?', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText('Chat memory')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
    expect(screen.getByText(/termhub · .+ · suggested 3× · accepted 2×/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Forget' }).length).toBeGreaterThan(0);
    expect(screen.getByText('Concierge notes')).toBeTruthy();
    expect(screen.getByText('Lessons')).toBeTruthy();
    expect(await screen.findByText(/^no project · file docs\/lessons\/x\.md · observed · .+ · verified$/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Undo verification' })).toBeTruthy();
  });

  it('asks before forgetting a decision, in English', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await render(<ChatMemoryScreen />);
    await screen.findByText('Usar worktree para essa tarefa?', undefined, LOAD);
    await fireEvent.press(screen.getAllByRole('button', { name: 'Forget' })[0]!);
    expect(alert).toHaveBeenCalledWith('Forget this decision?', expect.any(String), [
      expect.objectContaining({ text: 'Cancel', style: 'cancel' }),
      expect.objectContaining({ text: 'Forget', style: 'destructive' }),
    ]);
  });
});
