// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProgressResponse, Tab } from '../lib/types';

const progressMock = vi.fn();
const usageMock = vi.fn();
const live: Record<string, Tab | undefined> = {};
vi.mock('../lib/api', () => ({ api: { progress: (...a: unknown[]) => progressMock(...a), automation: { usage: (...a: unknown[]) => usageMock(...a) } } }));
vi.mock('../lib/monitor', () => ({ useMonitor: () => ({ tabState: (id: string) => live[id] }) }));

vi.mock('./PauseAutomationButton', () => ({ PauseBanner: () => null }));

import { PROGRESS_REFRESH_MS, ProgressPanel } from './ProgressPanel';

const response = (): ProgressResponse => ({
  generated_at: '2026-09-27T12:00:00.000Z',
  epics: [{
    id: 'e1', ref: 'TER-182', title: 'Visão gerencial', project: { id: 'p1', key: 'TER', name: 'termhub' },
    units: { done: 3, total: 6, backlog_total: 1 }, percent: 50,
    estimate: { kind: 'range', low_s: 1200, high_s: 2700, basis: 'agent_time', samples: 2 },
    cards_without_estimate: 1, agents: { working: 1, needs_you: 0, idle: 0 },
    cards: [{
      id: 'c1', ref: 'TER-183', title: 'Painel de progresso', type: 'story', status: 'doing', column_name: 'Fazendo',
      units: { done: 3, total: 5 }, percent: 60, started_at: null, done_at: null, active_seconds: 1800,
      estimate: { kind: 'range', low_s: 1200, high_s: 2700, basis: 'agent_time', samples: 3 },
      agents: [{ tab_id: 't1', tab_name: 'spec', machine_name: 'jarvis', subtask_ref: null, state: 'working', state_at: '2026-09-27T11:50:00.000Z', background: false, finished: false, needs_you: false, activity: 'coding', activity_verb: 'Coding', rate_limited: false, automatic: false }],
      pull_requests: [],
    }],
    ci: null, ci_error: null,
  }],
});

function mount() {
  render(<MemoryRouter><ProgressPanel projectId="p1" /></MemoryRouter>);
}

beforeEach(() => {
  progressMock.mockReset();
  progressMock.mockResolvedValue(response());
  usageMock.mockReset();
  usageMock.mockRejectedValue(new Error('none'));
  for (const k of Object.keys(live)) delete live[k];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ProgressPanel', () => {
  it('shows the epic and card progress, estimate and agent state', async () => {
    mount();
    expect(await screen.findByText('Visão gerencial')).toBeInTheDocument();
    expect(progressMock).toHaveBeenCalledWith({ project_id: 'p1', scope: 'active' });
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText('3/6 · backlog: 1')).toBeInTheDocument();
    expect(screen.getAllByText('~20–45 min de trabalho')).toHaveLength(2);
    expect(screen.getByText('1 card sem estimativa')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /TER-183/ })).toHaveAttribute('href', '/project/TER-183');
    expect(screen.getByRole('link', { name: /spec.*trabalhando/ })).toHaveAttribute('href', '/projects/p1?tab=t1');
  });

  it('scrolls inside its own region, since the layout row clips anything that leaks past it (TER-385)', async () => {
    mount();
    const heading = await screen.findByRole('heading', { name: 'Progresso' });
    const root = heading.parentElement!.parentElement!;
    expect(root.className).toContain('h-full');
    expect(root.className).toContain('overflow-y-auto');
  });

  it('shows PR badges, the epic CI line and a sync error', async () => {
    const withPr = response();
    withPr.epics[0]!.ci = { open: 1, failed: 1, running: 0, deployed: 0 };
    withPr.epics[0]!.ci_error = 'GitHub: repositório não encontrado';
    withPr.epics[0]!.cards[0]!.pull_requests = [{
      number: 12, url: 'https://github.com/acme/app/pull/12', title: 'Painel', state: 'open', draft: true,
      ci_state: 'failed', ci_summary: { total: 2, passed: 1, failed: 1, running: 0, failing: ['lint'] }, deploy_state: 'none', deploy_url: null,
    }];
    progressMock.mockResolvedValue(withPr);
    mount();
    const link = await screen.findByRole('link', { name: /PR #12/ });
    expect(link).toHaveAttribute('href', 'https://github.com/acme/app/pull/12');
    expect(link).toHaveTextContent('rascunho');
    expect(screen.getByText('CI falhou: lint')).toBeInTheDocument();
    expect(screen.getByText('PRs: 1 aberto · 1 falhou')).toBeInTheDocument();
    expect(screen.getByText('GitHub: repositório não encontrado')).toBeInTheDocument();
  });

  it('overlays the live monitor state and lists who is waiting for the user', async () => {
    live.t1 = { id: 't1', state: 'waiting_input', state_at: '2026-09-27T12:01:00.000Z', activity: null, activity_verb: null, rate_limited_at: null } as Tab;
    mount();
    expect(await screen.findByText('1 agente esperando você')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /spec.*esperando você/ })[0]).toHaveAttribute('href', '/projects/p1?tab=t1');
  });

  it('switches to every epic', async () => {
    mount();
    await screen.findByText('Visão gerencial');
    fireEvent.click(screen.getByRole('button', { name: 'Todos' }));
    await waitFor(() => expect(progressMock).toHaveBeenLastCalledWith({ project_id: 'p1', scope: 'all' }));
  });

  it('keeps the current scope when the previous scope answers last', async () => {
    let answerActive!: (r: ProgressResponse) => void;
    progressMock.mockReturnValueOnce(new Promise<ProgressResponse>((r) => (answerActive = r)));
    const all = response();
    all.epics[0]!.title = 'Épico encerrado';
    progressMock.mockResolvedValueOnce(all);
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Todos' }));
    expect(await screen.findByText('Épico encerrado')).toBeInTheDocument();
    await act(async () => answerActive(response()));
    expect(screen.getByText('Épico encerrado')).toBeInTheDocument();
    expect(screen.queryByText('Visão gerencial')).not.toBeInTheDocument();
  });

  it('says so when nothing is running', async () => {
    progressMock.mockResolvedValue({ generated_at: '', epics: [] });
    mount();
    expect(await screen.findByText('Nenhum épico em andamento')).toBeInTheDocument();
  });

  it('refreshes every 15 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount();
    await screen.findByText('Visão gerencial');
    await act(async () => {
      vi.advanceTimersByTime(PROGRESS_REFRESH_MS);
    });
    expect(progressMock).toHaveBeenCalledTimes(2);
  });

  it('shows the error when loading fails', async () => {
    progressMock.mockRejectedValue(new Error('boom'));
    mount();
    expect(await screen.findByText('Não foi possível carregar o progresso.')).toBeInTheDocument();
  });

  const ev = (over: Record<string, unknown>) => ({
    id: 'x', kind: 'run_started', created_at: '2026-09-27T11:55:00.000Z', project_id: 'p1', task_id: 'c1', run_id: 'run-abcdef123456', tab_id: 't1', ref: 'TER-183',
    epic: 'Visão gerencial', machine: 'jarvis', account: 'pessoal', branch: null, workflow: null, version: null, pr: null, url: null, until: null, reason_text: null, paused: null, ...over,
  });

  it('shows the Automático feed, newest first, with the run id and the tab link', async () => {
    progressMock.mockResolvedValue({
      ...response(),
      feed: [ev({ id: '2', kind: 'merged', branch: 'main', pr: 9, url: 'https://gh/pr/9' }), ev({ id: '1' })],
    });
    mount();
    const feed = await screen.findByRole('region', { name: 'Automático' });
    const items = within(feed).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('TER-183: merge feito na main');
    expect(items[1]).toHaveTextContent('TER-183 iniciado em jarvis (pessoal)');
    expect(within(items[0]).getByRole('link', { name: 'PR #9' })).toHaveAttribute('href', 'https://gh/pr/9');
    expect(within(items[1]).getByRole('link', { name: 'abrir aba' })).toHaveAttribute('href', '/projects/p1?tab=t1');
    expect(items[1]).toHaveTextContent('#123456');
  });

  it('shows no feed section for someone with no automatic work', async () => {
    progressMock.mockResolvedValue({ ...response(), feed: [] });
    mount();
    await screen.findByText('Visão gerencial');
    expect(screen.queryByRole('region', { name: 'Automático' })).toBeNull();
    expect(usageMock).not.toHaveBeenCalled();
  });

  it('shows the estimated cost per card, epic and account, even with no feed line; "—" when nothing was priced', async () => {
    const line = (input: number, cost: number | null) => ({ input_tokens: input, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: cost });
    const r = response();
    r.epics[0].usage = { tokens: 3000, cost_usd: 1.5 };
    r.epics[0].cards[0].usage = { tokens: 1000, cost_usd: null };
    progressMock.mockResolvedValue({ ...r, feed: [] });
    usageMock.mockResolvedValue({
      from: null,
      to: null,
      total: line(3000, 1.5),
      cards: [],
      epics: [],
      accounts: [{ ...line(3000, 1.5), account_id: 'a1', label: 'pessoal' }],
    });
    mount();
    expect(await screen.findByText('custo — · 1 mil tokens')).toBeInTheDocument();
    expect(screen.getByText(/custo US\$\s1,50 · 3 mil tokens/)).toBeInTheDocument();
    expect(await screen.findByText(/Custo estimado: US\$\s1,50 · pessoal US\$\s1,50/)).toBeInTheDocument();
    expect(usageMock).toHaveBeenCalledWith('p1');
  });

  it('badges the tab of an automatic run and writes the failures and escalations in one line', async () => {
    const r = response();
    r.epics[0].cards[0].agents![0].automatic = true;
    progressMock.mockResolvedValue({
      ...r,
      feed: [ev({ id: '3', kind: 'escalated', reason_text: 'O agente parou na confirmação.' }), ev({ id: '2', kind: 'deploy_failed', paused: true }), ev({ id: '1', kind: 'release_ok', workflow: 'npm', version: '1.2.0' })],
    });
    mount();
    const feed = await screen.findByRole('region', { name: 'Automático' });
    expect(within(feed).getByText('TER-183 precisa de você: O agente parou na confirmação.')).toBeInTheDocument();
    expect(within(feed).getByText('Deploy falhou (Visão gerencial) — automático pausado no projeto')).toBeInTheDocument();
    expect(within(feed).getByText('Publicado npm 1.2.0')).toBeInTheDocument();
    expect(screen.getAllByText('automático').length).toBeGreaterThan(0);
  });
});
