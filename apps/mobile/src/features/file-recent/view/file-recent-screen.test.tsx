import { act, fireEvent, render, screen } from '@testing-library/react-native';

const mockPush = jest.fn();
let mockParams: Record<string, string> = { project_id: 'p1' };
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), replace: jest.fn(), canGoBack: () => true }),
  useLocalSearchParams: () => mockParams,
}));
const mockFileRecent = jest.fn();
jest.mock('@/services/api', () => ({ api: { fileRecent: (...a: unknown[]) => mockFileRecent(...a) } }));
jest.mock('@/features/session/viewmodel/useSessionStore', () => ({
  useSessionStore: { getState: () => ({ auth: () => ({ accessToken: 't' }), handleApiError: () => false }) },
}));

import { FileRecentScreen } from './file-recent-screen';

const recent = (over: Record<string, unknown> = {}) => ({
  machine: { id: 'm1', name: 'jarvis' },
  path: '/home/u/p/docs/superpowers/specs/a.md',
  rel_path: 'docs/superpowers/specs/a.md',
  name: 'a.md',
  size: 12 * 1024,
  mtime: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  too_large: false,
  group: 'specs',
  cited: false,
  ...over,
});

const ITEMS = [
  recent(),
  recent({ name: 'p.md', path: '/home/u/p/docs/superpowers/plans/p.md', rel_path: 'docs/superpowers/plans/p.md', group: 'plans' }),
  recent({ name: 'relatorio.md', path: '/home/u/relatorio.md', rel_path: null, group: 'other', cited: true }),
  recent({ machine: { id: 'm2', name: 'mac' }, name: 'big.md', path: '/Users/u/p/docs/big.md', rel_path: 'docs/big.md', group: 'other', too_large: true }),
];

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = { project_id: 'p1' };
});

describe('FileRecentScreen', () => {
  it('lists the project files with folder, machine, size and date, and the badges', async () => {
    mockFileRecent.mockResolvedValue({ items: ITEMS, skipped: [] });
    await render(<FileRecentScreen />);
    expect(await screen.findByText('a.md')).toBeTruthy();
    expect(mockFileRecent).toHaveBeenCalledWith({ accessToken: 't' }, 'p1');
    expect(screen.getByText('Arquivos')).toBeTruthy();
    expect(screen.getByText('docs/superpowers/specs · jarvis · 12 KB · há 2 h')).toBeTruthy();
    expect(screen.getByText('citado')).toBeTruthy();
    expect(screen.getByText('muito grande')).toBeTruthy();
  });

  it('filters by chip', async () => {
    mockFileRecent.mockResolvedValue({ items: ITEMS, skipped: [] });
    await render(<FileRecentScreen />);
    await screen.findByText('a.md');
    await fireEvent.press(screen.getByRole('tab', { name: 'Planos' }));
    expect(screen.getByText('p.md')).toBeTruthy();
    expect(screen.queryByText('a.md')).toBeNull();
    await fireEvent.press(screen.getByRole('tab', { name: 'Citados' }));
    expect(screen.getByText('relatorio.md')).toBeTruthy();
    expect(screen.queryByText('p.md')).toBeNull();
    await fireEvent.press(screen.getByRole('tab', { name: 'Jurídico' }));
    expect(screen.getByText('Nenhum arquivo .md encontrado')).toBeTruthy();
  });

  it('opens a file in the preview on its machine, relative to the project when it can', async () => {
    mockFileRecent.mockResolvedValue({ items: ITEMS, skipped: [] });
    await render(<FileRecentScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'a.md' }));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/file-preview', params: { path: 'docs/superpowers/specs/a.md', project_id: 'p1', machine_id: 'm1' } });
    await fireEvent.press(screen.getByRole('button', { name: 'relatorio.md' }));
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/file-preview', params: { path: '/home/u/relatorio.md', project_id: 'p1', machine_id: 'm1' } });
    // over the preview's limit: listed, but it does not open
    await fireEvent.press(screen.getByRole('button', { name: 'big.md' }));
    expect(mockPush).toHaveBeenCalledTimes(2);
  });

  it('names the machine only when the list spans several', async () => {
    mockFileRecent.mockResolvedValue({ items: [ITEMS[0]], skipped: [] });
    await render(<FileRecentScreen />);
    expect(await screen.findByText('docs/superpowers/specs · 12 KB · há 2 h')).toBeTruthy();
  });

  it('says which machines were left out, and when there is nothing', async () => {
    mockFileRecent.mockResolvedValue({
      items: [],
      skipped: [
        { machine: { id: 'm2', name: 'mac' }, reason: 'outdated' },
        { machine: { id: 'm3', name: 'note' }, reason: 'offline' },
        { machine: { id: 'm4', name: 'vps' }, reason: 'unsupported' },
      ],
    });
    await render(<FileRecentScreen />);
    expect(await screen.findByText('Nenhum arquivo .md encontrado')).toBeTruthy();
    expect(screen.getByText('Atualize o agente de mac para listar os arquivos dela')).toBeTruthy();
    expect(screen.getByText('note está desconectada')).toBeTruthy();
    expect(screen.getByText('vps não usa o agente do termhub')).toBeTruthy();
  });

  it('says why the list failed', async () => {
    const { ApiError } = jest.requireActual('@/services/api/errors');
    mockFileRecent.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Projeto não encontrado'));
    await render(<FileRecentScreen />);
    expect(await screen.findByText('Projeto não encontrado')).toBeTruthy();
  });

  it('reloads on pull-to-refresh', async () => {
    mockFileRecent.mockResolvedValue({ items: ITEMS, skipped: [] });
    await render(<FileRecentScreen />);
    await screen.findByText('a.md');
    mockFileRecent.mockResolvedValue({ items: [ITEMS[1]], skipped: [] });
    await act(async () => screen.getByTestId('file-recent-list').props.refreshControl.props.onRefresh());
    expect(await screen.findByText('p.md')).toBeTruthy();
    expect(mockFileRecent).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('a.md')).toBeNull();
  });

  it('asks for a project when the route has none', async () => {
    mockParams = {};
    await render(<FileRecentScreen />);
    expect(screen.getByText('Nenhum projeto indicado.')).toBeTruthy();
    expect(mockFileRecent).not.toHaveBeenCalled();
  });
});
