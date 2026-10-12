// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ChatMemoryPage } from './ChatMemoryPage';
import type { ChatDecision, ConciergeNote, LessonItem } from '../lib/types';

const chatMemoryMock = vi.fn();
const chatDecisionsMock = vi.fn();
const setChatMemoryMock = vi.fn();
const forgetChatDecisionMock = vi.fn();
const chatNotesMock = vi.fn();
const forgetChatNoteMock = vi.fn();
const chatLessonsListMock = vi.fn();
const chatLessonsVerifyMock = vi.fn();
const chatLessonsUnverifyMock = vi.fn();
const chatLessonsForgetMock = vi.fn();
const setDecisionStatusMock = vi.fn();
const setNoteStatusMock = vi.fn();
const memoryReplacementsMock = vi.fn();

vi.mock('../lib/api', () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
      public code?: string,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    api: {
      chatMemory: (...a: unknown[]) => chatMemoryMock(...a),
      chatDecisions: (...a: unknown[]) => chatDecisionsMock(...a),
      setChatMemory: (...a: unknown[]) => setChatMemoryMock(...a),
      forgetChatDecision: (...a: unknown[]) => forgetChatDecisionMock(...a),
      chatNotes: (...a: unknown[]) => chatNotesMock(...a),
      forgetChatNote: (...a: unknown[]) => forgetChatNoteMock(...a),
      setDecisionStatus: (...a: unknown[]) => setDecisionStatusMock(...a),
      setNoteStatus: (...a: unknown[]) => setNoteStatusMock(...a),
      memoryReplacements: (...a: unknown[]) => memoryReplacementsMock(...a),
      chat: {
        lessons: {
          list: (...a: unknown[]) => chatLessonsListMock(...a),
          verify: (...a: unknown[]) => chatLessonsVerifyMock(...a),
          unverify: (...a: unknown[]) => chatLessonsUnverifyMock(...a),
          forget: (...a: unknown[]) => chatLessonsForgetMock(...a),
        },
      },
    },
  };
});

const dec = (over: Partial<ChatDecision> & { id: string }): ChatDecision => ({
  project_id: 'p1',
  project_name: 'termhub',
  header: 'Worktree',
  question: 'Usar worktree?',
  options: [
    { label: 'Sim', description: '' },
    { label: 'Não', description: '' },
  ],
  multi_select: false,
  answer: { labels: ['Não'] },
  suggested_count: 2,
  accepted_count: 1,
  created_at: '2026-09-20T10:00:00.000Z',
  status: 'current',
  expires_at: null,
  superseded_by: null,
  ...over,
});

const note = (over: Partial<ConciergeNote> & { id: string }): ConciergeNote => ({
  project_id: 'p1',
  project_name: 'termhub',
  question: 'Usar worktree?',
  decision: 'Sim',
  reason: 'Você sempre usa worktree para isolar o trabalho',
  created_at: '2026-09-21T10:00:00.000Z',
  status: 'current',
  expires_at: null,
  superseded_by: null,
  ...over,
});

beforeEach(() => {
  chatMemoryMock.mockReset();
  chatDecisionsMock.mockReset();
  setChatMemoryMock.mockReset();
  forgetChatDecisionMock.mockReset();
  chatNotesMock.mockReset();
  forgetChatNoteMock.mockReset();
  chatLessonsListMock.mockReset();
  chatLessonsVerifyMock.mockReset();
  chatLessonsUnverifyMock.mockReset();
  chatLessonsForgetMock.mockReset();
  setDecisionStatusMock.mockReset();
  setNoteStatusMock.mockReset();
  memoryReplacementsMock.mockReset();
  // Every test that does not care about notes/lessons gets an empty, immediately-resolved list — the
  // search and toggle tests below never mock `chatNotes`/`chatLessonsList` themselves.
  chatNotesMock.mockResolvedValue({ notes: [], next_cursor: null });
  chatLessonsListMock.mockResolvedValue({ lessons: [], next_cursor: null });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('loads GET /memory and GET /decisions and lists question, answer, project, date and counts', async () => {
  chatMemoryMock.mockResolvedValue({ enabled: true, available: true, count: 1, autodecide: false, codex_replies: false, notes: 0 });
  chatDecisionsMock.mockResolvedValue({ decisions: [dec({ id: 'd1' })], next_cursor: null });
  render(<ChatMemoryPage />, { wrapper: MemoryRouter });
  expect(await screen.findByText('Usar worktree?')).toBeInTheDocument();
  expect(screen.getByText('→ Não')).toBeInTheDocument();
  expect(screen.getByText(/termhub/)).toBeInTheDocument();
  expect(screen.getByText(/20\/09\/2026/)).toBeInTheDocument();
  expect(screen.getByText(/sugerida 2× · aceita 1×/)).toBeInTheDocument();
  expect(chatMemoryMock).toHaveBeenCalled();
  expect(chatDecisionsMock).toHaveBeenCalledWith(undefined);
});

it('shows a free-text answer as the text, not the labels', async () => {
  chatMemoryMock.mockResolvedValue({ enabled: true, available: true, count: 1, autodecide: false, codex_replies: false, notes: 0 });
  chatDecisionsMock.mockResolvedValue({ decisions: [dec({ id: 'd1', answer: { labels: [], text: 'Usar branch' } })], next_cursor: null });
  render(<ChatMemoryPage />, { wrapper: MemoryRouter });
  expect(await screen.findByText('→ Usar branch')).toBeInTheDocument();
});

it('typing in "Buscar" re-queries with q, debounced', async () => {
  chatMemoryMock.mockResolvedValue({ enabled: true, available: true, count: 0, autodecide: false, codex_replies: false, notes: 0 });
  chatDecisionsMock.mockResolvedValue({ decisions: [], next_cursor: null });
  render(<ChatMemoryPage />, { wrapper: MemoryRouter });
  await screen.findByLabelText('Buscar');
  expect(chatDecisionsMock).toHaveBeenCalledTimes(1);

  vi.useFakeTimers();
  fireEvent.change(screen.getByLabelText('Buscar'), { target: { value: 'worktree' } });
  expect(chatDecisionsMock).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(300);
  expect(chatDecisionsMock).toHaveBeenCalledTimes(2);
  expect(chatDecisionsMock).toHaveBeenLastCalledWith('worktree');
});

it('"Esquecer" asks window.confirm and removes the row after the DELETE', async () => {
  chatMemoryMock.mockResolvedValue({ enabled: true, available: true, count: 1, autodecide: false, codex_replies: false, notes: 0 });
  chatDecisionsMock.mockResolvedValue({ decisions: [dec({ id: 'd1' })], next_cursor: null });
  forgetChatDecisionMock.mockResolvedValue(undefined);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<ChatMemoryPage />, { wrapper: MemoryRouter });
  fireEvent.click(await screen.findByRole('button', { name: 'Esquecer' }));
  expect(window.confirm).toHaveBeenCalled();
  await waitFor(() => expect(forgetChatDecisionMock).toHaveBeenCalledWith('d1'));
  await waitFor(() => expect(screen.queryByText('Usar worktree?')).toBeNull());
});

it('the switch PATCHes { enabled: false }', async () => {
  chatMemoryMock.mockResolvedValue({ enabled: true, available: true, count: 0, autodecide: false, codex_replies: false, notes: 0 });
  chatDecisionsMock.mockResolvedValue({ decisions: [], next_cursor: null });
  setChatMemoryMock.mockResolvedValue({ enabled: false, available: true, count: 0 });
  render(<ChatMemoryPage />, { wrapper: MemoryRouter });
  fireEvent.click(await screen.findByRole('switch', { name: 'Sugerir respostas com base nas minhas decisões' }));
  expect(setChatMemoryMock).toHaveBeenCalledWith(false);
});

it('shows the unavailable note and hides the switch when available is false', async () => {
  chatMemoryMock.mockResolvedValue({ enabled: false, available: false, count: 0, autodecide: false, codex_replies: false, notes: 0 });
  chatDecisionsMock.mockResolvedValue({ decisions: [], next_cursor: null });
  render(<ChatMemoryPage />, { wrapper: MemoryRouter });
  expect(await screen.findByText('Sugestões indisponíveis neste servidor')).toBeInTheDocument();
  expect(screen.queryByRole('switch', { name: 'Sugerir respostas com base nas minhas decisões' })).toBeNull();
});

it("shows the later search's results even if the earlier one resolves after it", async () => {
  // The debounce only ever cancels the *timer*; once both requests are in flight, only a
  // request-generation check (not the timer) can stop a slow, superseded search from winning.
  chatMemoryMock.mockResolvedValue({ enabled: true, available: true, count: 0, autodecide: false, codex_replies: false, notes: 0 });
  type Page = { decisions: ChatDecision[]; next_cursor: string | null };
  const deferred: Array<(v: Page) => void> = [];
  chatDecisionsMock.mockResolvedValueOnce({ decisions: [], next_cursor: null }); // initial load on mount
  chatDecisionsMock.mockImplementationOnce(() => new Promise<Page>((resolve) => deferred.push(resolve)));
  chatDecisionsMock.mockImplementationOnce(() => new Promise<Page>((resolve) => deferred.push(resolve)));
  render(<ChatMemoryPage />, { wrapper: MemoryRouter });
  await screen.findByLabelText('Buscar');

  vi.useFakeTimers();
  fireEvent.change(screen.getByLabelText('Buscar'), { target: { value: 'first' } });
  await vi.advanceTimersByTimeAsync(300);
  fireEvent.change(screen.getByLabelText('Buscar'), { target: { value: 'second' } });
  await vi.advanceTimersByTimeAsync(300);
  vi.useRealTimers();
  expect(deferred).toHaveLength(2);

  // The newer ("second") request resolves first; the stale ("first") one resolves after it.
  await act(async () => deferred[1]!({ decisions: [dec({ id: 'd-second', question: 'Segunda pergunta' })], next_cursor: null }));
  expect(await screen.findByText('Segunda pergunta')).toBeInTheDocument();
  await act(async () => deferred[0]!({ decisions: [dec({ id: 'd-first', question: 'Primeira pergunta' })], next_cursor: null }));
  expect(screen.queryByText('Primeira pergunta')).toBeNull();
  expect(screen.getByText('Segunda pergunta')).toBeInTheDocument();
});

it('never updates state after unmounting while a search is still in flight', async () => {
  chatMemoryMock.mockResolvedValue({ enabled: true, available: true, count: 0, autodecide: false, codex_replies: false, notes: 0 });
  type Page = { decisions: ChatDecision[]; next_cursor: string | null };
  let resolveSearch!: (v: Page) => void;
  chatDecisionsMock.mockResolvedValueOnce({ decisions: [], next_cursor: null }); // initial load on mount
  chatDecisionsMock.mockImplementationOnce(() => new Promise<Page>((resolve) => (resolveSearch = resolve)));
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { unmount } = render(<ChatMemoryPage />, { wrapper: MemoryRouter });
  await screen.findByLabelText('Buscar');

  vi.useFakeTimers();
  fireEvent.change(screen.getByLabelText('Buscar'), { target: { value: 'worktree' } });
  await vi.advanceTimersByTimeAsync(300);
  vi.useRealTimers();

  unmount();
  // React would otherwise log "Can't perform a React state update on an unmounted component".
  await act(async () => resolveSearch({ decisions: [dec({ id: 'd1' })], next_cursor: null }));
  expect(consoleError).not.toHaveBeenCalled();
});

it("toggling, then a search that completes before the PATCH does, still shows the toggle's own result", async () => {
  // Regression: toggle/forget must not share the search's request-generation guard — a concurrent
  // search finishing first must never make the switch fall back to its pre-toggle value.
  chatMemoryMock.mockResolvedValue({ enabled: true, available: true, count: 0, autodecide: false, codex_replies: false, notes: 0 });
  chatDecisionsMock.mockResolvedValue({ decisions: [], next_cursor: null });
  let resolveToggle!: (v: { enabled: boolean; available: boolean; count: number }) => void;
  setChatMemoryMock.mockImplementationOnce(() => new Promise((resolve) => (resolveToggle = resolve)));
  render(<ChatMemoryPage />, { wrapper: MemoryRouter });

  fireEvent.click(await screen.findByRole('switch', { name: 'Sugerir respostas com base nas minhas decisões' }));
  expect(setChatMemoryMock).toHaveBeenCalledWith(false); // PATCH in flight, not yet resolved

  // A search starts and fully completes while the toggle's PATCH is still pending.
  vi.useFakeTimers();
  fireEvent.change(screen.getByLabelText('Buscar'), { target: { value: 'worktree' } });
  await vi.advanceTimersByTimeAsync(300);
  vi.useRealTimers();
  expect(chatDecisionsMock).toHaveBeenLastCalledWith('worktree');

  // Only now does the toggle's own PATCH resolve; the switch must reflect it, not the search's read.
  await act(async () => resolveToggle({ enabled: false, available: true, count: 0 }));
  expect(screen.getByRole('switch', { name: 'Sugerir respostas com base nas minhas decisões' })).toHaveAttribute('aria-checked', 'false');
});

it('a search that started before a toggle completed never flips the switch back when it resolves later', async () => {
  chatMemoryMock.mockResolvedValueOnce({ enabled: true, available: true, count: 0, autodecide: false, codex_replies: false, notes: 0 }); // initial load
  chatDecisionsMock.mockResolvedValue({ decisions: [], next_cursor: null });
  render(<ChatMemoryPage />, { wrapper: MemoryRouter });
  const sw = await screen.findByRole('switch', { name: 'Sugerir respostas com base nas minhas decisões' });

  // A search starts; its GET /memory (read before the PATCH lands) stays in flight.
  let resolveStaleMemory!: (v: { enabled: boolean; available: boolean; count: number }) => void;
  chatMemoryMock.mockImplementationOnce(() => new Promise((resolve) => (resolveStaleMemory = resolve)));
  vi.useFakeTimers();
  fireEvent.change(screen.getByLabelText('Buscar'), { target: { value: 'worktree' } });
  await vi.advanceTimersByTimeAsync(300);
  vi.useRealTimers();
  expect(chatMemoryMock).toHaveBeenCalledTimes(2);

  // The toggle goes through completely meanwhile.
  setChatMemoryMock.mockResolvedValueOnce({ enabled: false, available: true, count: 0 });
  await act(async () => fireEvent.click(sw));
  expect(sw).toHaveAttribute('aria-checked', 'false');

  // Only now does the search's stale read arrive: it must not undo the toggle.
  await act(async () => resolveStaleMemory({ enabled: true, available: true, count: 0 }));
  expect(screen.getByRole('switch', { name: 'Sugerir respostas com base nas minhas decisões' })).toHaveAttribute('aria-checked', 'false');
});

it('forgetting, then a search that completes before the DELETE does, still removes the row', async () => {
  chatMemoryMock.mockResolvedValue({ enabled: true, available: true, count: 1, autodecide: false, codex_replies: false, notes: 0 });
  chatDecisionsMock.mockResolvedValueOnce({ decisions: [dec({ id: 'd1' })], next_cursor: null }); // initial load
  let resolveForget!: () => void;
  forgetChatDecisionMock.mockImplementationOnce(() => new Promise<void>((resolve) => (resolveForget = resolve)));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<ChatMemoryPage />, { wrapper: MemoryRouter });

  fireEvent.click(await screen.findByRole('button', { name: 'Esquecer' })); // DELETE in flight
  expect(forgetChatDecisionMock).toHaveBeenCalledWith('d1');

  // A search starts and fully completes — bringing the same row right back — while the DELETE is
  // still pending.
  chatDecisionsMock.mockResolvedValueOnce({ decisions: [dec({ id: 'd1' })], next_cursor: null });
  vi.useFakeTimers();
  fireEvent.change(screen.getByLabelText('Buscar'), { target: { value: 'worktree' } });
  await vi.advanceTimersByTimeAsync(300);
  vi.useRealTimers();
  expect(await screen.findByText('Usar worktree?')).toBeInTheDocument();

  // Only now does the forget's own DELETE resolve; the row must disappear regardless of the search.
  await act(async () => resolveForget());
  await waitFor(() => expect(screen.queryByText('Usar worktree?')).toBeNull());
});

it('"Carregar mais" appears with next_cursor and appends the next page', async () => {
  chatMemoryMock.mockResolvedValue({ enabled: true, available: true, count: 2, autodecide: false, codex_replies: false, notes: 0 });
  chatDecisionsMock.mockResolvedValueOnce({ decisions: [dec({ id: 'd1' })], next_cursor: 'c2' });
  chatDecisionsMock.mockResolvedValueOnce({ decisions: [dec({ id: 'd2', question: 'Outra pergunta?' })], next_cursor: null });
  render(<ChatMemoryPage />, { wrapper: MemoryRouter });
  fireEvent.click(await screen.findByRole('button', { name: 'Carregar mais' }));
  expect(await screen.findByText('Outra pergunta?')).toBeInTheDocument();
  expect(screen.getByText('Usar worktree?')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Carregar mais' })).toBeNull();
  expect(chatDecisionsMock).toHaveBeenLastCalledWith(undefined, 'c2');
});

it('the "Responder sozinho" switch reflects autodecide and PATCHes it', async () => {
  chatMemoryMock.mockResolvedValue({ enabled: true, available: true, count: 0, autodecide: false, codex_replies: false, notes: 0 });
  chatDecisionsMock.mockResolvedValue({ decisions: [], next_cursor: null });
  setChatMemoryMock.mockResolvedValue({ enabled: true, available: true, count: 0, autodecide: true, codex_replies: false, notes: 0 });
  render(<ChatMemoryPage />, { wrapper: MemoryRouter });
  const sw = await screen.findByRole('switch', { name: 'Responder sozinho quando houver precedente' });
  expect(sw).toHaveAttribute('aria-checked', 'false');
  expect(screen.getByText(/60 segundos/)).toBeInTheDocument();
  fireEvent.click(sw);
  expect(setChatMemoryMock).toHaveBeenCalledWith({ autodecide: true });
  await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'));
});

it('shows the unavailable note and hides both switches when available is false', async () => {
  chatMemoryMock.mockResolvedValue({ enabled: false, available: false, count: 0, autodecide: false, codex_replies: false, notes: 0 });
  chatDecisionsMock.mockResolvedValue({ decisions: [], next_cursor: null });
  render(<ChatMemoryPage />, { wrapper: MemoryRouter });
  expect(await screen.findByText('Sugestões indisponíveis neste servidor')).toBeInTheDocument();
  expect(screen.queryByRole('switch', { name: 'Sugerir respostas com base nas minhas decisões' })).toBeNull();
  expect(screen.queryByText('Responder sozinho quando houver precedente')).toBeNull();
  // The Codex reply card needs no embeddings, so its switch stays.
  expect(screen.getByRole('switch', { name: 'Responder perguntas do Codex pelo chat' })).toBeInTheDocument();
});

it('the Codex reply switch is off by default, explains itself and PATCHes codex_replies', async () => {
  chatMemoryMock.mockResolvedValue({ enabled: true, available: true, count: 0, autodecide: false, codex_replies: false, notes: 0 });
  chatDecisionsMock.mockResolvedValue({ decisions: [], next_cursor: null });
  setChatMemoryMock.mockResolvedValue({ enabled: true, available: true, count: 0, autodecide: false, codex_replies: true, notes: 0 });
  render(<ChatMemoryPage />, { wrapper: MemoryRouter });
  const sw = await screen.findByRole('switch', { name: 'Responder perguntas do Codex pelo chat' });
  expect(sw).toHaveAttribute('aria-checked', 'false');
  expect(screen.getByText('Quando o Codex termina o turno com uma pergunta, abre um card no chat para você responder sem ir até a aba.')).toBeInTheDocument();
  fireEvent.click(sw);
  expect(setChatMemoryMock).toHaveBeenCalledWith({ codex_replies: true });
  await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'));
});

it('"Anotações do concierge" lists question, decision, reason and date, and "Esquecer" removes the row after confirming', async () => {
  chatMemoryMock.mockResolvedValue({ enabled: true, available: true, count: 0, autodecide: false, codex_replies: false, notes: 1 });
  chatDecisionsMock.mockResolvedValue({ decisions: [], next_cursor: null });
  chatNotesMock.mockResolvedValue({ notes: [note({ id: 'n1' })], next_cursor: null });
  forgetChatNoteMock.mockResolvedValue(undefined);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<ChatMemoryPage />, { wrapper: MemoryRouter });
  expect(await screen.findByText('Usar worktree?')).toBeInTheDocument();
  expect(screen.getByText('→ Sim')).toBeInTheDocument();
  expect(screen.getByText(/Você sempre usa worktree para isolar o trabalho/)).toBeInTheDocument();
  expect(screen.getByText(/21\/09\/2026/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Esquecer' }));
  expect(window.confirm).toHaveBeenCalled();
  await waitFor(() => expect(forgetChatNoteMock).toHaveBeenCalledWith('n1'));
  await waitFor(() => expect(screen.queryByText('Usar worktree?')).toBeNull());
});

it('"Esquecer" on a note asks nothing back when the person declines the confirm', async () => {
  chatMemoryMock.mockResolvedValue({ enabled: true, available: true, count: 0, autodecide: false, codex_replies: false, notes: 1 });
  chatDecisionsMock.mockResolvedValue({ decisions: [], next_cursor: null });
  chatNotesMock.mockResolvedValue({ notes: [note({ id: 'n1' })], next_cursor: null });
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<ChatMemoryPage />, { wrapper: MemoryRouter });
  fireEvent.click(await screen.findByRole('button', { name: 'Esquecer' }));
  expect(forgetChatNoteMock).not.toHaveBeenCalled();
  expect(screen.getByText('Usar worktree?')).toBeInTheDocument();
});

const lesson = (over: Partial<LessonItem> & { id: string }): LessonItem => ({
  project: { id: 'p1', name: 'termhub' },
  title: 'Migração quebrou o deploy',
  excerpt: 'A migração X não era compatível com o container antigo',
  origin: 'file',
  path: 'docs/lessons/2026-09-20-migration.md',
  tab_id: null,
  card: null,
  pr: null,
  evidence: 'observed',
  verified: false,
  verified_at: null,
  created_at: '2026-09-22T10:00:00.000Z',
  ...over,
});

it('"Lições" lists symptom, project, origin ("arquivo …"), evidence and no badge when unverified', async () => {
  chatMemoryMock.mockResolvedValue({ enabled: true, available: true, count: 0, autodecide: false, codex_replies: false, notes: 0 });
  chatDecisionsMock.mockResolvedValue({ decisions: [], next_cursor: null });
  chatLessonsListMock.mockResolvedValue({ lessons: [lesson({ id: 'l1' })], next_cursor: null });
  render(<ChatMemoryPage />, { wrapper: MemoryRouter });
  expect(await screen.findByText('Migração quebrou o deploy')).toBeInTheDocument();
  expect(screen.getByText(/termhub/)).toBeInTheDocument();
  expect(screen.getByText(/arquivo docs\/lessons\/2026-09-20-migration\.md/)).toBeInTheDocument();
  expect(screen.getByText(/observada/)).toBeInTheDocument();
  expect(screen.queryByText('verificada')).toBeNull();
  expect(screen.getByRole('button', { name: 'Verificar' })).toBeInTheDocument();
});

it('"Lições" shows "anotação do projeto" as the origin of a note-origin lesson', async () => {
  chatMemoryMock.mockResolvedValue({ enabled: true, available: true, count: 0, autodecide: false, codex_replies: false, notes: 0 });
  chatDecisionsMock.mockResolvedValue({ decisions: [], next_cursor: null });
  chatLessonsListMock.mockResolvedValue({ lessons: [lesson({ id: 'l1', origin: 'note', path: null })], next_cursor: null });
  render(<ChatMemoryPage />, { wrapper: MemoryRouter });
  expect(await screen.findByText(/anotação do projeto/)).toBeInTheDocument();
});

it('"Lições" shows the "verificada" badge and "Desfazer verificação" for an already-verified lesson', async () => {
  chatMemoryMock.mockResolvedValue({ enabled: true, available: true, count: 0, autodecide: false, codex_replies: false, notes: 0 });
  chatDecisionsMock.mockResolvedValue({ decisions: [], next_cursor: null });
  chatLessonsListMock.mockResolvedValue({ lessons: [lesson({ id: 'l1', verified: true, verified_at: '2026-09-23T10:00:00.000Z' })], next_cursor: null });
  render(<ChatMemoryPage />, { wrapper: MemoryRouter });
  expect(await screen.findByText('verificada')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Desfazer verificação' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Verificar' })).toBeNull();
});

it('"Verificar" calls api.chat.lessons.verify(id) and flips the badge on', async () => {
  chatMemoryMock.mockResolvedValue({ enabled: true, available: true, count: 0, autodecide: false, codex_replies: false, notes: 0 });
  chatDecisionsMock.mockResolvedValue({ decisions: [], next_cursor: null });
  const l = lesson({ id: 'l1' });
  chatLessonsListMock.mockResolvedValue({ lessons: [l], next_cursor: null });
  chatLessonsVerifyMock.mockResolvedValue({ ...l, verified: true, verified_at: '2026-09-23T10:00:00.000Z' });
  render(<ChatMemoryPage />, { wrapper: MemoryRouter });
  fireEvent.click(await screen.findByRole('button', { name: 'Verificar' }));
  expect(chatLessonsVerifyMock).toHaveBeenCalledWith('l1');
  expect(await screen.findByText('verificada')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Desfazer verificação' })).toBeInTheDocument();
});

it('"Desfazer verificação" calls api.chat.lessons.unverify(id) and flips the badge off', async () => {
  chatMemoryMock.mockResolvedValue({ enabled: true, available: true, count: 0, autodecide: false, codex_replies: false, notes: 0 });
  chatDecisionsMock.mockResolvedValue({ decisions: [], next_cursor: null });
  const l = lesson({ id: 'l1', verified: true, verified_at: '2026-09-23T10:00:00.000Z' });
  chatLessonsListMock.mockResolvedValue({ lessons: [l], next_cursor: null });
  chatLessonsUnverifyMock.mockResolvedValue({ ...l, verified: false, verified_at: null });
  render(<ChatMemoryPage />, { wrapper: MemoryRouter });
  fireEvent.click(await screen.findByRole('button', { name: 'Desfazer verificação' }));
  expect(chatLessonsUnverifyMock).toHaveBeenCalledWith('l1');
  await waitFor(() => expect(screen.queryByText('verificada')).toBeNull());
  expect(screen.getByRole('button', { name: 'Verificar' })).toBeInTheDocument();
});

it('"Esquecer" on a lesson asks "Esquecer esta lição?" and removes the row, showing the server\'s note', async () => {
  chatMemoryMock.mockResolvedValue({ enabled: true, available: true, count: 0, autodecide: false, codex_replies: false, notes: 0 });
  chatDecisionsMock.mockResolvedValue({ decisions: [], next_cursor: null });
  chatLessonsListMock.mockResolvedValue({ lessons: [lesson({ id: 'l1' })], next_cursor: null });
  chatLessonsForgetMock.mockResolvedValue({ ok: true, note: 'O arquivo continua no repositório; apague-o por um PR para sumir de vez' });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<ChatMemoryPage />, { wrapper: MemoryRouter });
  fireEvent.click(await screen.findByRole('button', { name: 'Esquecer' }));
  expect(window.confirm).toHaveBeenCalledWith('Esquecer esta lição?');
  await waitFor(() => expect(chatLessonsForgetMock).toHaveBeenCalledWith('l1'));
  await waitFor(() => expect(screen.queryByText('Migração quebrou o deploy')).toBeNull());
  expect(await screen.findByText(/O arquivo continua no repositório/)).toBeInTheDocument();
});

it('"Esquecer" on a lesson asks nothing back when the person declines the confirm', async () => {
  chatMemoryMock.mockResolvedValue({ enabled: true, available: true, count: 0, autodecide: false, codex_replies: false, notes: 0 });
  chatDecisionsMock.mockResolvedValue({ decisions: [], next_cursor: null });
  chatLessonsListMock.mockResolvedValue({ lessons: [lesson({ id: 'l1' })], next_cursor: null });
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<ChatMemoryPage />, { wrapper: MemoryRouter });
  fireEvent.click(await screen.findByRole('button', { name: 'Esquecer' }));
  expect(chatLessonsForgetMock).not.toHaveBeenCalled();
  expect(screen.getByText('Migração quebrou o deploy')).toBeInTheDocument();
});

it('the lessons search box filters, debounced', async () => {
  chatMemoryMock.mockResolvedValue({ enabled: true, available: true, count: 0, autodecide: false, codex_replies: false, notes: 0 });
  chatDecisionsMock.mockResolvedValue({ decisions: [], next_cursor: null });
  chatLessonsListMock.mockResolvedValue({ lessons: [], next_cursor: null });
  render(<ChatMemoryPage />, { wrapper: MemoryRouter });
  await screen.findByLabelText('Buscar lições');
  expect(chatLessonsListMock).toHaveBeenCalledTimes(1);

  vi.useFakeTimers();
  fireEvent.change(screen.getByLabelText('Buscar lições'), { target: { value: 'migração' } });
  expect(chatLessonsListMock).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(300);
  vi.useRealTimers();
  expect(chatLessonsListMock).toHaveBeenCalledTimes(2);
  expect(chatLessonsListMock).toHaveBeenLastCalledWith({ q: 'migração' });
});

it('"Abrir origem" links to the PR when present, else the card, else the project notes', async () => {
  chatMemoryMock.mockResolvedValue({ enabled: true, available: true, count: 0, autodecide: false, codex_replies: false, notes: 0 });
  chatDecisionsMock.mockResolvedValue({ decisions: [], next_cursor: null });
  chatLessonsListMock.mockResolvedValue({
    lessons: [
      lesson({ id: 'l-pr', pr: 'https://github.com/x/y/pull/9', card: 'TER-9' }),
      lesson({ id: 'l-card', card: 'TER-12', title: 'Card lesson' }),
      lesson({ id: 'l-note', origin: 'note', path: null, title: 'Note lesson' }),
    ],
    next_cursor: null,
  });
  render(<ChatMemoryPage />, { wrapper: MemoryRouter });
  await screen.findByText('Migração quebrou o deploy');
  const links = screen.getAllByRole('link', { name: 'Abrir origem' });
  expect(links[0]).toHaveAttribute('href', 'https://github.com/x/y/pull/9');
  expect(links[1]).toHaveAttribute('href', '/project/TER-12');
  expect(links[2]).toHaveAttribute('href', '/projects/p1/notes');
});

const MEM = { enabled: true, available: true, count: 1, autodecide: false, codex_replies: false, notes: 0 };

it('a current decision shows "Vigente"; "Errada" marks it and offers "Desfazer", which undoes it (TER-1013)', async () => {
  chatMemoryMock.mockResolvedValue(MEM);
  chatDecisionsMock.mockResolvedValue({ decisions: [dec({ id: 'd1' })], next_cursor: null });
  setDecisionStatusMock.mockResolvedValueOnce({ decision: dec({ id: 'd1', status: 'wrong' }) });
  render(<ChatMemoryPage />, { wrapper: MemoryRouter });
  expect(await screen.findByText('Vigente')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Errada' }));
  await waitFor(() => expect(setDecisionStatusMock).toHaveBeenCalledWith('d1', 'wrong', undefined));
  expect(await screen.findByRole('button', { name: 'Desfazer' })).toBeInTheDocument();
  expect(screen.getByText('Errada')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Desatualizada' })).toBeNull();

  setDecisionStatusMock.mockResolvedValueOnce({ decision: dec({ id: 'd1' }) });
  fireEvent.click(screen.getByRole('button', { name: 'Desfazer' }));
  await waitFor(() => expect(setDecisionStatusMock).toHaveBeenLastCalledWith('d1', 'current', undefined));
  expect(await screen.findByText('Vigente')).toBeInTheDocument();
});

it('"Desatualizada" on a note marks it outdated', async () => {
  chatMemoryMock.mockResolvedValue(MEM);
  chatDecisionsMock.mockResolvedValue({ decisions: [], next_cursor: null });
  chatNotesMock.mockResolvedValue({ notes: [note({ id: 'n1' })], next_cursor: null });
  setNoteStatusMock.mockResolvedValueOnce({ note: note({ id: 'n1', status: 'outdated', expires_at: '2026-10-07T00:00:00.000Z' }) });
  render(<ChatMemoryPage />, { wrapper: MemoryRouter });
  fireEvent.click(await screen.findByRole('button', { name: 'Desatualizada' }));
  await waitFor(() => expect(setNoteStatusMock).toHaveBeenCalledWith('n1', 'outdated', undefined));
  expect(await screen.findByText('Desatualizada')).toBeInTheDocument();
});

it('"Substituída por…" searches the other items, picks one and shows "Substituída por «…»"', async () => {
  chatMemoryMock.mockResolvedValue(MEM);
  chatDecisionsMock.mockResolvedValue({ decisions: [dec({ id: 'd1' })], next_cursor: null });
  memoryReplacementsMock.mockResolvedValue({
    items: [{ ref: 'note:n9', kind: 'note', title: 'Usar a main direto', detail: 'Sim', project_name: 'termhub', created_at: '2026-10-01T00:00:00.000Z' }],
  });
  setDecisionStatusMock.mockResolvedValueOnce({ decision: dec({ id: 'd1', status: 'superseded', superseded_by: { ref: 'note:n9', title: 'Usar a main direto' } }) });
  render(<ChatMemoryPage />, { wrapper: MemoryRouter });
  fireEvent.click(await screen.findByRole('button', { name: 'Substituída por…' }));
  fireEvent.change(screen.getByLabelText('Qual item substitui este?'), { target: { value: 'main' } });
  await waitFor(() => expect(memoryReplacementsMock).toHaveBeenLastCalledWith('main', 'decision:d1'));
  fireEvent.click(await screen.findByRole('button', { name: /Usar a main direto/ }));
  await waitFor(() => expect(setDecisionStatusMock).toHaveBeenCalledWith('d1', 'superseded', 'note:n9'));
  expect(await screen.findByText('Substituída por «Usar a main direto»')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Desfazer' })).toBeInTheDocument();
});

it('a refused status change shows the server\'s message', async () => {
  const { ApiError } = await import('../lib/api');
  chatMemoryMock.mockResolvedValue(MEM);
  chatDecisionsMock.mockResolvedValue({ decisions: [dec({ id: 'd1' })], next_cursor: null });
  setDecisionStatusMock.mockRejectedValueOnce(new ApiError(409, 'O item escolhido já substitui outro; desfaça aquela substituição antes'));
  render(<ChatMemoryPage />, { wrapper: MemoryRouter });
  fireEvent.click(await screen.findByRole('button', { name: 'Errada' }));
  expect(await screen.findByText('O item escolhido já substitui outro; desfaça aquela substituição antes')).toBeInTheDocument();
});
