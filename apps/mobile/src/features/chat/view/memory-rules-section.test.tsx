import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));
jest.mock('@/features/chat/viewmodel/useMemoryRulesStore', () => ({ useMemoryRulesStore: require('../../../../test/helpers/ui-stores').stores.memoryRules }));

import type { TMemoryRule } from '@/services/api/contract';
import { setLocale } from '@/i18n';
import { enrolStores, stores } from '../../../../test/helpers/ui-stores';
import { useMemoryRulesStore } from '../viewmodel/useMemoryRulesStore';
import { MemoryRulesSection } from './memory-rules-section';

/** The first load of a file signs its first P-256 proof, slow while other suites share the CPU. */
const LOAD = { timeout: 15_000 };

function rule(over: Partial<TMemoryRule> & { id: string; text: string }): TMemoryRule {
  return {
    kind: 'rule',
    status: 'proposed',
    project: null,
    policy: null,
    sources: [
      { ref: 'decision:d1', title: 'Usar worktree?', statement: 'Sim, numa worktree', project_name: 'termhub' },
      { ref: 'note:n1', title: 'Isolar?', statement: 'Worktree própria', project_name: 'opapingou' },
    ],
    created_at: new Date().toISOString(),
    decided_at: null,
    ...over,
  };
}

const policy = rule({
  id: 'p1',
  kind: 'policy',
  text: 'Merge sozinho com CI verde',
  policy: {
    autonomy: 'merge',
    max_parallel: 2,
    projects: [
      { id: 'p-termhub', name: 'termhub', applied: false },
      { id: 'p-opapingou', name: 'opapingou', applied: false },
    ],
  },
});

beforeAll(async () => {
  await enrolStores();
});

afterEach(() => {
  jest.restoreAllMocks();
  useMemoryRulesStore.setState({ rules: null, proposals: null, busyId: null, error: null, notice: null });
});

describe('Regras vigentes', () => {
  it('no rules and no proposals shows the empty state', async () => {
    jest.spyOn(stores.api, 'chatRules').mockResolvedValue({ rules: [], proposals: [] });
    await render(<MemoryRulesSection />);
    expect(await screen.findByText('Nenhuma regra vigente nem proposta por enquanto.', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText('Regras vigentes')).toBeTruthy();
    expect(screen.getByText('Decisões e anotações que dizem a mesma coisa viram uma regra só. Nada muda até você aprovar.')).toBeTruthy();
  });

  it('a rule proposal shows its text, "Todos os projetos", its sources and the two buttons', async () => {
    jest.spyOn(stores.api, 'chatRules').mockResolvedValue({ rules: [], proposals: [rule({ id: 'r1', text: 'Sempre numa worktree' })] });
    await render(<MemoryRulesSection />);
    expect(await screen.findByText('Sempre numa worktree', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText('Propostas')).toBeTruthy();
    expect(screen.getByText('Todos os projetos')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Aprovar' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Recusar' })).toBeTruthy();

    // The sources open on a tap.
    expect(screen.queryByText('Sim, numa worktree · termhub')).toBeNull();
    await act(async () => fireEvent.press(screen.getByRole('button', { name: '2 origens' })));
    expect(screen.getByText('Sim, numa worktree · termhub')).toBeTruthy();
    expect(screen.getByText('Worktree própria · opapingou')).toBeTruthy();
  });

  it('a single source reads "1 origem"; a project rule shows the project name', async () => {
    const one = rule({ id: 'r1', text: 'Usar pnpm', project: { id: 'p-termhub', name: 'termhub' } });
    jest.spyOn(stores.api, 'chatRules').mockResolvedValue({ rules: [{ ...one, status: 'approved', sources: one.sources.slice(0, 1) }], proposals: [] });
    await render(<MemoryRulesSection />);
    expect(await screen.findByText('Usar pnpm', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText('termhub')).toBeTruthy();
    expect(screen.getByRole('button', { name: '1 origem' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remover' })).toBeTruthy();
  });

  it('a policy proposal shows what it changes, its projects and the note about the chat', async () => {
    jest.spyOn(stores.api, 'chatRules').mockResolvedValue({ rules: [], proposals: [policy] });
    await render(<MemoryRulesSection />);
    expect(await screen.findByText('Merge sozinho com CI verde', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText('Mudar o nível para «Merge com CI verde»')).toBeTruthy();
    expect(screen.getByText('Máximo em paralelo: 2')).toBeTruthy();
    expect(screen.getByText('Projetos: termhub, opapingou')).toBeTruthy();
    expect(screen.getByText('Política do trabalho automático')).toBeTruthy();
    expect(screen.getByText('Cada projeto pede a sua confirmação no chat.')).toBeTruthy();
  });

  it('a proposal awaiting confirmation shows that instead of the buttons', async () => {
    jest.spyOn(stores.api, 'chatRules').mockResolvedValue({ rules: [], proposals: [{ ...policy, status: 'awaiting_confirmation' }] });
    await render(<MemoryRulesSection />);
    expect(await screen.findByText('Aguardando a confirmação no chat', undefined, LOAD)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Aprovar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Recusar' })).toBeNull();
  });

  it('"Aprovar" approves and reloads the list', async () => {
    const proposal = rule({ id: 'r1', text: 'Sempre numa worktree' });
    const list = jest
      .spyOn(stores.api, 'chatRules')
      .mockResolvedValueOnce({ rules: [], proposals: [proposal] })
      .mockResolvedValueOnce({ rules: [{ ...proposal, status: 'approved' }], proposals: [] });
    const approve = jest.spyOn(stores.api, 'approveChatRule').mockResolvedValue({ ...proposal, status: 'approved' });
    await render(<MemoryRulesSection />);
    await screen.findByText('Sempre numa worktree', undefined, LOAD);

    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Aprovar' })));

    expect(approve).toHaveBeenCalledWith(expect.anything(), 'r1');
    expect(await screen.findByRole('button', { name: 'Remover' }, LOAD)).toBeTruthy();
    expect(screen.queryByText('Propostas')).toBeNull();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('"Recusar" rejects, reloads and says it will not come back for 180 days', async () => {
    const proposal = rule({ id: 'r1', text: 'Sempre numa worktree' });
    jest
      .spyOn(stores.api, 'chatRules')
      .mockResolvedValueOnce({ rules: [], proposals: [proposal] })
      .mockResolvedValueOnce({ rules: [], proposals: [] });
    const reject = jest.spyOn(stores.api, 'rejectChatRule').mockResolvedValue({ ...proposal, status: 'rejected' });
    await render(<MemoryRulesSection />);
    await screen.findByText('Sempre numa worktree', undefined, LOAD);

    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Recusar' })));

    expect(reject).toHaveBeenCalledWith(expect.anything(), 'r1');
    expect(await screen.findByText('Recusada, ela não volta por 180 dias.', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText('Nenhuma regra vigente nem proposta por enquanto.')).toBeTruthy();
  });

  it('"Remover" asks a native confirm, then removes the rule and reloads', async () => {
    const approved = rule({ id: 'r1', text: 'Sempre numa worktree', status: 'approved' });
    jest
      .spyOn(stores.api, 'chatRules')
      .mockResolvedValueOnce({ rules: [approved], proposals: [] })
      .mockResolvedValueOnce({ rules: [], proposals: [] });
    const remove = jest.spyOn(stores.api, 'removeChatRule').mockResolvedValue(undefined);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((title, _msg, buttons) => {
      expect(title).toBe('Remover a regra «Sempre numa worktree»? As decisões e anotações de origem voltam a valer.');
      buttons?.find((b) => b.style === 'destructive')?.onPress?.();
    });
    await render(<MemoryRulesSection />);
    await screen.findByText('Sempre numa worktree', undefined, LOAD);

    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Remover' })));

    expect(alert).toHaveBeenCalled();
    await waitFor(() => expect(remove).toHaveBeenCalledWith(expect.anything(), 'r1'), LOAD);
    await waitFor(() => expect(screen.queryByText('Sempre numa worktree')).toBeNull(), LOAD);
  });

  it('cancelling the confirm keeps the rule', async () => {
    jest.spyOn(stores.api, 'chatRules').mockResolvedValue({ rules: [rule({ id: 'r1', text: 'Sempre numa worktree', status: 'approved' })], proposals: [] });
    const remove = jest.spyOn(stores.api, 'removeChatRule');
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await render(<MemoryRulesSection />);
    await screen.findByText('Sempre numa worktree', undefined, LOAD);

    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Remover' })));

    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByText('Sempre numa worktree')).toBeTruthy();
  });
});

describe('Regras vigentes in English (i18n)', () => {
  beforeEach(() => setLocale('en'));
  afterEach(() => setLocale(null));

  it('shows the section, a policy proposal and the plural in English', async () => {
    jest.spyOn(stores.api, 'chatRules').mockResolvedValue({ rules: [], proposals: [policy, rule({ id: 'r1', text: 'Sempre numa worktree' })] });
    await render(<MemoryRulesSection />);
    expect(await screen.findByText('Current rules', undefined, LOAD)).toBeTruthy();
    expect(await screen.findByText('Proposals', undefined, LOAD)).toBeTruthy();
    expect(screen.getByText('Change the level to «Merge on green CI»')).toBeTruthy();
    expect(screen.getByText('At most in parallel: 2')).toBeTruthy();
    expect(screen.getByText('All projects')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '2 sources' }).length).toBe(2);
    expect(screen.getAllByRole('button', { name: 'Approve' }).length).toBe(2);
    expect(screen.getAllByRole('button', { name: 'Deny' }).length).toBe(2);
  });
});
