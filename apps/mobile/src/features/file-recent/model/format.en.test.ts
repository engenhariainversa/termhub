import { setLocale, t } from '@/i18n';
import type { TFileRecentItem } from '@/services/api/contract';
import { FILE_RECENT_FILTERS, fileMeta, skippedText } from './format';

afterEach(() => setLocale(null));

const NOW = Date.parse('2026-10-05T12:00:00.000Z');

it('shows the chips, the row line and the skipped machines in English', () => {
  setLocale('en');
  expect(FILE_RECENT_FILTERS.map((f) => t(f.label))).toEqual(['All', 'Specs', 'Plans', 'Lessons', 'Legal', 'Other', 'Cited']);
  const item: TFileRecentItem = {
    machine: { id: 'm1', name: 'jarvis' },
    path: '/home/u/p/docs/a.md',
    rel_path: 'docs/a.md',
    name: 'a.md',
    size: 1536,
    mtime: '2026-10-05T09:00:00.000Z',
    too_large: false,
    group: 'other',
    cited: false,
  };
  expect(fileMeta(item, false, NOW)).toBe('docs · 1.5 KB · 3 h ago');
  expect(skippedText('mac', 'offline')).toBe('mac is offline');
  expect(skippedText('mac', 'outdated')).toBe('Update the agent on mac to list its files');
});
