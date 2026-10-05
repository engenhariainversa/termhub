import { ApiError } from '@/services/api/errors';
import type { TFileRecentResponse } from '@/services/api/contract';
import { createFileRecentStore } from './createFileRecentStore';

const res: TFileRecentResponse = {
  items: [
    {
      machine: { id: 'm1', name: 'jarvis' },
      path: '/home/u/p/docs/a.md',
      rel_path: 'docs/a.md',
      name: 'a.md',
      size: 3,
      mtime: '2026-10-04T10:00:00.000Z',
      too_large: false,
      group: 'other',
      cited: false,
    },
  ],
  skipped: [{ machine: { id: 'm2', name: 'mac' }, reason: 'offline' }],
};

function make(answer: () => Promise<TFileRecentResponse>, handled = false) {
  const fileRecent = jest.fn(answer);
  const handleApiError = jest.fn(() => handled);
  const store = createFileRecentStore({ api: { fileRecent }, session: () => ({ auth: () => ({ accessToken: 't' }) as never, handleApiError }), projectId: 'p1' });
  return { store, fileRecent, handleApiError };
}

describe('createFileRecentStore', () => {
  it('lists the project files with the machines left out', async () => {
    const { store, fileRecent } = make(async () => res);
    await store.getState().load();
    expect(fileRecent).toHaveBeenCalledWith({ accessToken: 't' }, 'p1');
    expect(store.getState().state).toEqual({ phase: 'ok', items: res.items, skipped: res.skipped });
  });

  it('keeps the list on screen while a pull-to-refresh reloads it', async () => {
    let resolve!: (r: TFileRecentResponse) => void;
    const { store, fileRecent } = make(async () => res);
    await store.getState().load();
    fileRecent.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const pending = store.getState().load({ refresh: true });
    expect(store.getState().refreshing).toBe(true);
    expect(store.getState().state.phase).toBe('ok');
    resolve({ items: [], skipped: [] });
    await pending;
    expect(store.getState().refreshing).toBe(false);
    expect(store.getState().state).toEqual({ phase: 'ok', items: [], skipped: [] });
  });

  it('keeps only the newest answer', async () => {
    const answers: ((r: TFileRecentResponse) => void)[] = [];
    const { store } = make(() => new Promise((r) => answers.push(r)));
    const first = store.getState().load();
    const second = store.getState().load();
    answers[1]!({ items: [], skipped: [] });
    answers[0]!(res);
    await Promise.all([first, second]);
    expect(store.getState().state).toEqual({ phase: 'ok', items: [], skipped: [] });
  });

  it('says why the list failed', async () => {
    const { store } = make(async () => {
      throw new ApiError(404, 'NOT_FOUND', 'Projeto não encontrado');
    });
    await store.getState().load();
    expect(store.getState().state).toEqual({ phase: 'error', text: 'Projeto não encontrado' });
  });

  it('leaves a session-ending error to the session store, and ignores a locked session', async () => {
    const revoked = make(async () => {
      throw new ApiError(401, 'DEVICE_REVOKED', '');
    }, true);
    await revoked.store.getState().load();
    expect(revoked.handleApiError).toHaveBeenCalled();
    expect(revoked.store.getState().state).toEqual({ phase: 'loading' });
    const locked = make(async () => {
      throw new Error('LOCKED');
    });
    await locked.store.getState().load();
    expect(locked.handleApiError).not.toHaveBeenCalled();
    expect(locked.store.getState().state).toEqual({ phase: 'loading' });
  });

  it('remembers the chosen chip', () => {
    const { store } = make(async () => res);
    expect(store.getState().filter).toBe('all');
    store.getState().setFilter('cited');
    expect(store.getState().filter).toBe('cited');
  });
});
