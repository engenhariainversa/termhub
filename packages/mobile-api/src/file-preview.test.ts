import { describe, expect, it } from 'vitest';
import { filePreviewOk, filePreviewQuery, filePreviewResponse } from './file-preview.js';

const ok = {
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

describe('file preview contract', () => {
  it('takes absolute, ~ and relative paths with an optional context', () => {
    for (const path of ['/tmp/r.md', '~/r.md', 'docs/a.md']) expect(filePreviewQuery.safeParse({ path, project_id: 'p1' }).success).toBe(true);
    expect(filePreviewQuery.safeParse({ path: 'a.md', tab_id: 't1' }).success).toBe(true);
  });
  it('refuses an empty path, a newline, a NUL and an oversized path', () => {
    for (const path of ['', 'a\n.md', 'a\0.md', 'x'.repeat(4097)]) expect(filePreviewQuery.safeParse({ path }).success).toBe(false);
  });
  it('reads a body and a refusal, including a reason this build does not know', () => {
    expect(filePreviewOk.safeParse(ok).success).toBe(true);
    expect(filePreviewResponse.parse({ status: 'too_large', machine: { id: 'm1', name: 'x' }, size: 9 })).toMatchObject({ status: 'too_large' });
    expect(filePreviewResponse.safeParse({ status: 'quarantined', machine: null }).success).toBe(true);
  });
});
