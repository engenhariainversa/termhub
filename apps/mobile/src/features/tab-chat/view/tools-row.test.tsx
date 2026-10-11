import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { setLocale } from '@/i18n';
import type { ToolRow } from '../model/timeline';
import { ToolsRow } from './tools-row';

const tools: ToolRow[] = [
  { id: 't1', name: 'Bash', summary: 'npm test', status: 'done', preview: '842 passed' },
  { id: 't2', name: 'Read', summary: 'src/a.ts', status: 'error', preview: 'ENOENT' },
  { id: 't3', name: 'Grep', summary: 'foo', status: 'running', preview: null },
];

it('folds several tools in one line that opens to one line per tool, and a tool to its preview', async () => {
  await render(<ToolsRow tools={tools} />);
  expect(screen.getByText('3 ferramentas')).toBeTruthy();
  expect(screen.queryByText('npm test')).toBeNull();

  await fireEvent.press(screen.getByRole('button', { name: /3 ferramentas/ }));
  expect(screen.getByText('npm test')).toBeTruthy();
  expect(screen.getByText('src/a.ts')).toBeTruthy();
  expect(screen.getByLabelText('Bash: concluída')).toBeTruthy();
  expect(screen.getByLabelText('Read: erro')).toBeTruthy();
  expect(screen.getByLabelText('Grep: em andamento')).toBeTruthy();
  expect(screen.queryByText('842 passed')).toBeNull();

  await fireEvent.press(screen.getByLabelText('Bash: concluída'));
  expect(screen.getByText('842 passed')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Bash: concluída'));
  expect(screen.queryByText('842 passed')).toBeNull();
});

it('one tool alone shows its name and summary, with no count', async () => {
  await render(<ToolsRow tools={[tools[0]!]} />);
  expect(screen.getByText('Bash')).toBeTruthy();
  expect(screen.getByText('npm test')).toBeTruthy();
  expect(screen.queryByText(/ferramenta/)).toBeNull();
  await fireEvent.press(screen.getByLabelText('Bash: concluída'));
  expect(screen.getByText('842 passed')).toBeTruthy();
});

describe('in English', () => {
  afterEach(async () => {
    await act(async () => setLocale(null));
  });

  it('counts the tools and names their status in English', async () => {
    setLocale('en');
    await render(<ToolsRow tools={tools} />);
    expect(screen.getByText('3 tools')).toBeTruthy();
    expect(screen.getByText('in progress')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('3 tools'));
    expect(screen.getByLabelText('Bash: done')).toBeTruthy();
    expect(screen.getByLabelText('Read: error')).toBeTruthy();
  });
});
