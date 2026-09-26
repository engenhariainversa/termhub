// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => vi.unstubAllGlobals());

it('sends a chat message without waiting for the answer: the server answers 202 with the ids', async () => {
  const ids = { conversation_id: 'c1', user_message_id: 'mu', assistant_message_id: 'ma' };
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(ids), { status: 202 }));
  vi.stubGlobal('fetch', fetchMock);
  expect(await api.sendChatMessage('oi', 'p1')).toEqual(ids);
  await api.sendChatMessage('oi');
  const bodies = fetchMock.mock.calls.map((c) => JSON.parse((c as unknown as [string, RequestInit])[1].body as string));
  expect(bodies).toEqual([{ text: 'oi', project_id: 'p1', wait: false }, { text: 'oi', wait: false }]);
});
