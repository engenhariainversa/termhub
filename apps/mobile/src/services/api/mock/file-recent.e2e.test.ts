// End-to-end: `HttpMobileApi.fileRecent` over `MockTransport`'s file-recent route — the signed client
// listing the mock project's recent Markdown files (spec 2026-10-04 recent Markdown files D7).
import { enrol, setupSession } from '../../../../test/helpers/enrolled-session';
import { ApiError } from '../errors';

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

it('fileRecent lists every group, the cited file and the machine left out through the signed client', async () => {
  const ctx = setupSession();
  await enrol(ctx);
  const auth = ctx.store.getState().auth();
  const res = await ctx.api.fileRecent(auth, 'p-termhub');
  expect(new Set(res.items.map((f) => f.group))).toEqual(new Set(['specs', 'plans', 'lessons', 'legal', 'other']));
  expect(res.items.find((f) => f.cited && f.rel_path === null)).toMatchObject({ name: 'relatorio-termhub-10-dias.md', machine: { name: 'jarvis' } });
  expect(res.items.some((f) => f.too_large)).toBe(true);
  expect(res.skipped).toEqual([{ machine: { id: 'm-antigo', name: 'notebook-antigo' }, reason: 'outdated' }]);
  // the cited report opens in the preview by the absolute path the list gave
  const cited = res.items.find((f) => f.cited && f.rel_path === null)!;
  const preview = await ctx.api.filePreview(auth, { path: cited.path, project_id: 'p-termhub', machine_id: cited.machine.id });
  expect(preview).toMatchObject({ status: 'ok', name: 'relatorio-termhub-10-dias.md' });
});

it('fileRecent refuses a project the person does not have', async () => {
  const ctx = setupSession();
  await enrol(ctx);
  await expect(ctx.api.fileRecent(ctx.store.getState().auth(), 'p-nope')).rejects.toBeInstanceOf(ApiError);
});
