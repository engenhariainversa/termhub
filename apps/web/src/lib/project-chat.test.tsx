// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectChatProvider, useProjectChat } from './project-chat';

const projectsMock = vi.fn();
const useChatStreamMock = vi.fn((_r: unknown, cb: (e: unknown) => void) => ((emit = cb), { events: [], connected: true }));
let emit!: (e: unknown) => void;
// `can` defaults to true for both permissions the status feed needs, so the existing tests exercise
// the feed exactly as before; the gating test below overrides it.
let canMock = (_resource: string, _action?: string) => true;
vi.mock('./api', () => ({ api: { chatProjects: (...a: unknown[]) => projectsMock(...a) } }));
vi.mock('./chat', () => ({ useChatStream: (...a: [unknown, (e: unknown) => void]) => useChatStreamMock(...a) }));
vi.mock('./auth', () => ({ useAuth: () => ({ can: (r: string, a?: string) => canMock(r, a) }) }));

afterEach(() => {
  cleanup();
  canMock = () => true;
  projectsMock.mockReset();
  useChatStreamMock.mockClear();
});

function Probe() {
  const { openProjectId, toggle, status } = useProjectChat();
  return (
    <>
      <span data-testid="open">{openProjectId ?? 'none'}</span>
      <span data-testid="p1">{JSON.stringify(status('p1'))}</span>
      <button onClick={() => toggle('p1')}>p1</button>
      <button onClick={() => toggle('p2')}>p2</button>
    </>
  );
}

it('toggle opens, swaps and closes', () => {
  projectsMock.mockResolvedValue({ projects: [] });
  render(<ProjectChatProvider><Probe /></ProjectChatProvider>);
  // `getByRole('button', ...)`, not `getByText`: once `open` reads "p2" the plain text query would
  // also match that status span, since it shows the very string being clicked.
  act(() => screen.getByRole('button', { name: 'p1' }).click());
  expect(screen.getByTestId('open').textContent).toBe('p1');
  act(() => screen.getByRole('button', { name: 'p2' }).click());
  expect(screen.getByTestId('open').textContent).toBe('p2');
  act(() => screen.getByRole('button', { name: 'p2' }).click());
  expect(screen.getByTestId('open').textContent).toBe('none');
});

it('reads statuses on load and re-reads them on chat events', async () => {
  projectsMock.mockResolvedValueOnce({ projects: [{ project_id: 'p1', busy: false, pending_confirmations: 1 }] }).mockResolvedValue({ projects: [{ project_id: 'p1', busy: true, pending_confirmations: 0 }] });
  render(<ProjectChatProvider><Probe /></ProjectChatProvider>);
  await waitFor(() => expect(screen.getByTestId('p1').textContent).toBe('{"busy":false,"pending":1}'));
  act(() => emit({ type: 'message', conversation_id: 'c_p1', message: {} }));
  await waitFor(() => expect(screen.getByTestId('p1').textContent).toBe('{"busy":true,"pending":0}'));
});

it.each(['tab_question', 'tab_question_answered', 'tab_question_closed'])('re-reads statuses on %s: an open question counts as pending', async (type) => {
  projectsMock.mockResolvedValueOnce({ projects: [{ project_id: 'p1', busy: false, pending_confirmations: 0 }] }).mockResolvedValue({ projects: [{ project_id: 'p1', busy: false, pending_confirmations: 1 }] });
  render(<ProjectChatProvider><Probe /></ProjectChatProvider>);
  await waitFor(() => expect(screen.getByTestId('p1').textContent).toBe('{"busy":false,"pending":0}'));
  act(() => emit({ type, conversation_id: 'c_p1', question: {} }));
  await waitFor(() => expect(screen.getByTestId('p1').textContent).toBe('{"busy":false,"pending":1}'));
});

it('does not re-read on a suggestion event: suggestions are not counted', async () => {
  projectsMock.mockResolvedValue({ projects: [] });
  render(<ProjectChatProvider><Probe /></ProjectChatProvider>);
  await waitFor(() => expect(projectsMock).toHaveBeenCalledTimes(1));
  act(() => emit({ type: 'tab_suggestion', conversation_id: 'c_p1', suggestion: {} }));
  await new Promise((r) => setTimeout(r, 20));
  expect(projectsMock).toHaveBeenCalledTimes(1);
});

it('works without a provider (the sidebar in isolation): closed, no status', () => {
  render(<Probe />);
  expect(screen.getByTestId('open').textContent).toBe('none');
  expect(screen.getByTestId('p1').textContent).toBe('{"busy":false,"pending":0}');
});

it('without chat permission, neither /chat/projects nor the ws stream is touched, and status stays idle', async () => {
  // A role without `chat` (or without `terminals:read`, which the `/ws/chat` upgrade guard also
  // requires — ws/router.ts) must never open the websocket or poll the endpoint: both 403 for that
  // role, and a websocket that keeps 403ing reconnects every 5s for the life of the tab (this
  // provider is mounted for every signed-in user in Layout).
  canMock = () => false;
  render(<ProjectChatProvider><Probe /></ProjectChatProvider>);
  // Give any stray microtask a turn before asserting the negative.
  await Promise.resolve();
  expect(projectsMock).not.toHaveBeenCalled();
  expect(useChatStreamMock).not.toHaveBeenCalled();
  expect(screen.getByTestId('p1').textContent).toBe('{"busy":false,"pending":0}');
});
