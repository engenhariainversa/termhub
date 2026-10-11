// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  announceTerminalEnded,
  closeEditorTab,
  editorTabsKey,
  fileOfTab,
  filePathOf,
  fileTabId,
  isFileTabId,
  getEditorTabs,
  onTerminalEnded,
  pinTab,
  previewTab,
  pruneEditorTabs,
  resetEditorTabsCache,
  seedEditorTabs,
  updateEditorTabs,
  type EditorTabs,
} from './editor-tabs';

const s = (open: string[], preview: string | null = null): EditorTabs => ({ open, preview });

describe('editor tab transitions', () => {
  it('a single click opens a preview tab, and the next one reuses it in place', () => {
    expect(previewTab(s([]), 'a')).toEqual(s(['a'], 'a'));
    expect(previewTab(s(['x', 'a', 'y'], 'a'), 'b')).toEqual(s(['x', 'b', 'y'], 'b'));
  });

  it('a single click on an open tab changes nothing (a pinned tab stays pinned)', () => {
    const state = s(['x', 'a'], 'a');
    expect(previewTab(state, 'x')).toBe(state);
  });

  it('with no preview, a single click adds the preview at the end', () => {
    expect(previewTab(s(['x']), 'a')).toEqual(s(['x', 'a'], 'a'));
  });

  it('pinning turns the preview into a pinned tab, or opens a closed terminal pinned', () => {
    expect(pinTab(s(['x', 'a'], 'a'), 'a')).toEqual(s(['x', 'a']));
    expect(pinTab(s(['x'], 'x'), 'b')).toEqual(s(['x', 'b'], 'x'));
    const pinned = s(['x']);
    expect(pinTab(pinned, 'x')).toBe(pinned);
  });

  it('after pinning, the next single click opens a new preview instead of replacing it', () => {
    const pinned = pinTab(previewTab(s([]), 'a'), 'a');
    expect(previewTab(pinned, 'b')).toEqual(s(['a', 'b'], 'b'));
  });

  it('closing a tab removes it, and the preview with it', () => {
    expect(closeEditorTab(s(['x', 'a'], 'a'), 'a')).toEqual(s(['x']));
    expect(closeEditorTab(s(['x', 'a'], 'a'), 'x')).toEqual(s(['a'], 'a'));
  });

  it('prune drops terminals that no longer exist', () => {
    expect(pruneEditorTabs(s(['x', 'gone'], 'gone'), new Set(['x']))).toEqual(s(['x']));
    const ok = s(['x']);
    expect(pruneEditorTabs(ok, new Set(['x', 'y']))).toBe(ok);
  });

  it("keeps a terminal's conversation tab while the terminal is known (TER-1003)", () => {
    expect(pruneEditorTabs(s(['x', 'chat:x', 'chat:gone']), new Set(['x']))).toEqual(s(['x', 'chat:x']));
  });
});

describe('editor tab store', () => {
  beforeEach(() => {
    localStorage.clear();
    resetEditorTabsCache();
  });

  it('remembers the open tabs per project across reloads', () => {
    updateEditorTabs('p1', (st) => previewTab(st, 'a'));
    updateEditorTabs('p2', (st) => pinTab(st, 'b'));
    resetEditorTabsCache(); // a reload
    expect(getEditorTabs('p1')).toEqual(s(['a'], 'a'));
    expect(getEditorTabs('p2')).toEqual(s(['b']));
  });

  it('is null until seeded, and seeding never overwrites what was stored', () => {
    expect(getEditorTabs('p1')).toBeNull();
    expect(seedEditorTabs('p1', s(['a']))).toEqual(s(['a']));
    expect(seedEditorTabs('p1', s(['b']))).toEqual(s(['a']));
  });

  it('survives garbage in storage', () => {
    localStorage.setItem(editorTabsKey('p1'), '{"open":[1,"a","a"],"preview":"zz"}');
    expect(getEditorTabs('p1')).toEqual(s(['a']));
    localStorage.setItem(editorTabsKey('p2'), 'not json');
    expect(getEditorTabs('p2')).toBeNull();
  });

  it('works in memory when storage throws', () => {
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      updateEditorTabs('p1', (st) => pinTab(st, 'a'));
      expect(getEditorTabs('p1')).toEqual(s(['a']));
    } finally {
      set.mockRestore();
    }
  });

  it('a terminal ended from the sidebar closes its tab and tells the listeners', () => {
    updateEditorTabs('p1', () => s(['a', 'b'], 'b'));
    const listener = vi.fn();
    const off = onTerminalEnded(listener);
    announceTerminalEnded('p1', 'b');
    expect(getEditorTabs('p1')).toEqual(s(['a']));
    expect(listener).toHaveBeenCalledWith('p1', 'b');
    off();
    announceTerminalEnded('p1', 'a');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('file tabs (TER-941)', () => {
  it('a file id is told apart from a terminal id and gives its path back', () => {
    const id = fileTabId('docs/a.md');
    expect(isFileTabId(id)).toBe(true);
    expect(isFileTabId('t1')).toBe(false);
    expect(filePathOf(id)).toBe('docs/a.md');
  });

  it('a file read on a machine carries it in its id (TER-973)', () => {
    const onM1 = fileTabId('~/relatorio.md', 'm1');
    const onM2 = fileTabId('~/relatorio.md', 'm2');
    expect(isFileTabId(onM1)).toBe(true);
    expect(onM1).not.toBe(onM2);
    expect(fileOfTab(onM1)).toEqual({ path: '~/relatorio.md', machineId: 'm1' });
    expect(filePathOf(onM2)).toBe('~/relatorio.md');
    // a path with colons keeps them
    expect(fileOfTab(fileTabId('/tmp/a:b.md', 'm1'))).toEqual({ path: '/tmp/a:b.md', machineId: 'm1' });
    // no machine: the id from before TER-973, still read as "any machine of the project"
    expect(fileTabId('docs/a.md', null)).toBe('file:docs/a.md');
    expect(fileOfTab('file:docs/a.md')).toEqual({ path: 'docs/a.md', machineId: null });
    expect(fileOfTab('file:@x:y.md')).toEqual({ path: '@x:y.md', machineId: null });
  });

  it('a stored tab bar with a machine-bound file survives pruning and reload', () => {
    const f = fileTabId('~/r.md', 'm1');
    expect(pruneEditorTabs(s(['t1', f], f), new Set(['t1']))).toEqual(s(['t1', f], f));
  });

  it('previews and pins a file like a terminal', () => {
    const f = fileTabId('~/r.md');
    const previewed = previewTab(s(['t1']), f);
    expect(previewed).toEqual(s(['t1', f], f));
    expect(pinTab(previewed, f)).toEqual(s(['t1', f]));
    // the next single click replaces the preview, file or terminal
    expect(previewTab(previewed, 't2')).toEqual(s(['t1', 't2'], 't2'));
  });

  it('pruning against the terminal list keeps the file tabs', () => {
    const f = fileTabId('docs/a.md');
    expect(pruneEditorTabs(s(['t1', f, 'gone'], f), new Set(['t1']))).toEqual(s(['t1', f], f));
  });
});
