import type { TFileRecentItem } from '@/services/api/contract';
import { FILE_RECENT_FILTERS, fileMeta, filterFiles, folderOf, machineCount, previewPath, skippedText } from './format';

const NOW = Date.parse('2026-10-05T12:00:00.000Z');

const item = (over: Partial<TFileRecentItem> = {}): TFileRecentItem => ({
  machine: { id: 'm1', name: 'jarvis' },
  path: '/home/u/p/docs/superpowers/specs/a.md',
  rel_path: 'docs/superpowers/specs/a.md',
  name: 'a.md',
  size: 12 * 1024,
  mtime: '2026-10-05T09:00:00.000Z',
  too_large: false,
  group: 'specs',
  cited: false,
  ...over,
});

describe('file-recent format', () => {
  it('offers Todos, each group and Citados', () => {
    expect(FILE_RECENT_FILTERS.map((f) => f.label)).toEqual(['Todos', 'Specs', 'Planos', 'Lições', 'Jurídico', 'Outros', 'Citados']);
  });

  it('filters by group, by cited, or not at all', () => {
    const spec = item();
    const plan = item({ name: 'p.md', group: 'plans', cited: true });
    const other = item({ name: 'r.md', group: 'other', rel_path: null, path: '/home/u/r.md', cited: true });
    expect(filterFiles([spec, plan, other], 'all')).toHaveLength(3);
    expect(filterFiles([spec, plan, other], 'plans')).toEqual([plan]);
    expect(filterFiles([spec, plan, other], 'cited')).toEqual([plan, other]);
    expect(filterFiles([spec, plan, other], 'legal')).toEqual([]);
  });

  it('opens and shows a file relative to the project when it can, else by its absolute path', () => {
    expect(previewPath(item())).toBe('docs/superpowers/specs/a.md');
    expect(folderOf(item())).toBe('docs/superpowers/specs');
    const outside = item({ rel_path: null, path: '/home/u/relatorio.md' });
    expect(previewPath(outside)).toBe('/home/u/relatorio.md');
    expect(folderOf(outside)).toBe('/home/u');
    expect(folderOf(item({ rel_path: 'README.md' }))).toBe('');
  });

  it('names the machine only when the list spans several', () => {
    expect(machineCount([item(), item({ name: 'b.md' })])).toBe(1);
    expect(machineCount([item(), item({ machine: { id: 'm2', name: 'mac' } })])).toBe(2);
    expect(fileMeta(item(), false, NOW)).toBe('docs/superpowers/specs · 12 KB · há 3 h');
    expect(fileMeta(item({ rel_path: 'README.md', size: 300 }), true, NOW)).toBe('jarvis · 300 B · há 3 h');
  });

  it('says why a machine is missing, and a reason it does not know as a generic line', () => {
    expect(skippedText('mac', 'outdated')).toBe('Atualize o agente de mac para listar os arquivos dela');
    expect(skippedText('mac', 'offline')).toBe('mac está desconectada');
    expect(skippedText('mac', 'unsupported')).toBe('mac não usa o agente do termhub');
    expect(skippedText('mac', 'quarantined')).toBe('Não foi possível listar os arquivos de mac');
  });
});
