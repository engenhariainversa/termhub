import { describe, expect, it } from 'vitest';
import { fileRecentQuery, fileRecentResponse } from './file-recent.js';

const item = {
  machine: { id: 'm1', name: 'jarvis' },
  path: '/home/u/p/docs/superpowers/specs/a.md',
  rel_path: 'docs/superpowers/specs/a.md',
  name: 'a.md',
  size: 3,
  mtime: '2026-10-04T10:00:00.000Z',
  too_large: false,
  group: 'specs',
  cited: true,
};

describe('file recent contract', () => {
  it('needs a project id', () => {
    expect(fileRecentQuery.safeParse({ project_id: 'p1' }).success).toBe(true);
    expect(fileRecentQuery.safeParse({}).success).toBe(false);
    expect(fileRecentQuery.safeParse({ project_id: '' }).success).toBe(false);
    expect(fileRecentQuery.safeParse({ project_id: 'x'.repeat(65) }).success).toBe(false);
  });

  it('reads items and skipped machines', () => {
    const body = fileRecentResponse.parse({ items: [item, { ...item, rel_path: null, group: 'other', cited: false }], skipped: [{ machine: { id: 'm2', name: 'hulk' }, reason: 'outdated' }] });
    expect(body.items).toHaveLength(2);
    expect(body.skipped[0].reason).toBe('outdated');
  });

  it('reads a skip reason and a group this build does not know', () => {
    const body = fileRecentResponse.parse({ items: [{ ...item, group: 'reports' }], skipped: [{ machine: { id: 'm2', name: 'hulk' }, reason: 'asleep' }] });
    expect(body.items[0].group).toBe('other');
    expect(body.skipped[0].reason).toBe('asleep');
  });

  it('refuses an item without its fields', () => {
    const { cited: _cited, ...noCited } = item;
    expect(fileRecentResponse.safeParse({ items: [noCited], skipped: [] }).success).toBe(false);
  });
});
