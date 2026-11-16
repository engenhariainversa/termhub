import { act, renderHook } from '@testing-library/react-native';
import type { TProjectReposResponse } from '@/services/api/contract';
import { ApiError } from '@/services/api/errors';
import { useProjectRepos, type ProjectReposDeps } from './use-project-repos';

const VIEW: TProjectReposResponse = { project_id: 'p1', machines: [], repos: [] };

async function setup(getProjectRepos: jest.Mock) {
  const session = { auth: () => ({}) as never, handleApiError: jest.fn(() => false) };
  const deps = { api: { getProjectRepos }, session: () => session } as unknown as ProjectReposDeps;
  const hook = await renderHook(() => useProjectRepos('p1', deps));
  await act(async () => {
    await hook.result.current.load();
  });
  return { hook, session };
}

describe('useProjectRepos (TER-1061)', () => {
  it('loads the repositories', async () => {
    const get = jest.fn(async () => VIEW);
    const t = await setup(get);
    expect(get).toHaveBeenCalledWith({}, 'p1');
    expect(t.hook.result.current.repos).toEqual(VIEW);
  });

  it('a server that predates the route (404) leaves nothing to show, with no error', async () => {
    const t = await setup(jest.fn(async () => Promise.reject(new ApiError(404, 'NOT_FOUND', 'Not Found'))));
    expect(t.hook.result.current.repos).toBeNull();
    expect(t.session.handleApiError).toHaveBeenCalled();
  });
});
