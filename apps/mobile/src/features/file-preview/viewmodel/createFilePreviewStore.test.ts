import { ApiError } from '@/services/api/errors';
import type { TFilePreviewResponse } from '@/services/api/contract';
import { createFilePreviewStore } from './createFilePreviewStore';

const ok: TFilePreviewResponse = {
  status: 'ok',
  machine: { id: 'm1', name: 'jarvis' },
  project_id: 'p1',
  path: '/home/u/p/docs/a.md',
  rel_path: 'docs/a.md',
  name: 'a.md',
  size: 3,
  mtime: '2026-10-04T10:00:00.000Z',
  content: '# a',
  github_url: null,
};

function make(answer: () => Promise<TFilePreviewResponse>, handled = false) {
  const filePreview = jest.fn(answer);
  const handleApiError = jest.fn(() => handled);
  const store = createFilePreviewStore({ api: { filePreview }, session: () => ({ auth: () => ({ accessToken: 't' }) as never, handleApiError }), query: { path: 'docs/a.md', tab_id: 't1' } });
  return { store, filePreview, handleApiError };
}

describe('createFilePreviewStore', () => {
  it('reads the file with the screen query', async () => {
    const { store, filePreview } = make(async () => ok);
    await store.getState().load();
    expect(filePreview).toHaveBeenCalledWith({ accessToken: 't' }, { path: 'docs/a.md', tab_id: 't1' });
    expect(store.getState().state).toEqual({ phase: 'ok', file: ok });
  });

  it('says why a file was refused, with the machine, and reads an unknown reason as the generic line', async () => {
    const hidden = make(async () => ({ status: 'hidden', machine: { id: 'm1', name: 'jarvis' } }));
    await hidden.store.getState().load();
    expect(hidden.store.getState().state).toEqual({ phase: 'refused', text: expect.stringContaining('pastas ocultas'), machine: 'jarvis', outdated: false });
    const unknown = make(async () => ({ status: 'quarantined', machine: null }));
    await unknown.store.getState().load();
    expect(unknown.store.getState().state).toMatchObject({ text: 'Não foi possível abrir este arquivo.' });
  });

  it('marks an old agent so the screen says to update it', async () => {
    const { store } = make(async () => {
      throw new ApiError(409, 'AGENT_OUTDATED', 'Atualize o agente desta máquina (npm i -g @termhub/agent, versão 0.16.0 ou mais nova) para ver arquivos');
    });
    await store.getState().load();
    expect(store.getState().state).toMatchObject({ phase: 'refused', outdated: true, text: expect.stringContaining('Atualize o agente') });
  });

  it('leaves a session-ending error to the session store', async () => {
    const { store, handleApiError } = make(async () => {
      throw new ApiError(401, 'DEVICE_REVOKED', '');
    }, true);
    await store.getState().load();
    expect(handleApiError).toHaveBeenCalled();
    expect(store.getState().state).toEqual({ phase: 'loading' });
  });
});
