// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HealthItem, ProjectHealthSetup } from '../lib/types';

const healthMock = vi.fn();
vi.mock('../lib/api', () => ({ api: { automation: { health: (...a: unknown[]) => healthMock(...a) } } }));

import { ProjectHealthPanel } from './ProjectHealthPanel';
import { HealthSetup } from './HealthSetup';

afterEach(() => {
  cleanup();
  healthMock.mockReset();
});

const item = (patch: Partial<HealthItem> = {}): HealthItem => ({
  id: 'h1', signal: 'pr_ready', level: 'needs_you', name: 'PR pronto parado', text: 'PR #526 (TER-1) verde e sem merge há 2 h: Branch base vermelha',
  url: 'https://github.com/o/r/pull/526', subject: 'https://github.com/o/r/pull/526', since_at: '2026-10-27T10:00:00Z', opened_at: '2026-10-27T12:00:00Z', woken: true, ...patch,
});

describe('ProjectHealthPanel (TER-1121)', () => {
  it('lists the open alerts with what needs the person and a link', async () => {
    healthMock.mockResolvedValue({ enabled: true, items: [item(), item({ id: 'h2', signal: 'tab_stuck', level: 'concierge', name: 'Aba travada trabalhando', text: 'Aba x', url: null, subject: 'tab1' })] });
    render(<MemoryRouter><ProjectHealthPanel projectId="p1" /></MemoryRouter>);
    expect(await screen.findByRole('region', { name: 'Saúde do projeto' })).toBeInTheDocument();
    expect(healthMock).toHaveBeenCalledWith('p1');
    expect(screen.getByText('precisa de você')).toBeInTheDocument();
    expect(screen.getByText('com o concierge')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'abrir' })).toHaveAttribute('href', 'https://github.com/o/r/pull/526');
    expect(screen.getByRole('link', { name: 'abrir aba' })).toHaveAttribute('href', '/projects/p1?tab=tab1');
  });

  it('shows nothing while the project is healthy, or when the server cannot tell', async () => {
    healthMock.mockResolvedValue({ enabled: true, items: [] });
    const { container } = render(<MemoryRouter><ProjectHealthPanel projectId="p1" /></MemoryRouter>);
    await vi.waitFor(() => expect(healthMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});

describe('HealthSetup (TER-1121)', () => {
  const signals = Object.fromEntries(
    ['pr_ready', 'base_red', 'queue_stalled', 'tab_stuck', 'tab_waiting', 'card_orphan', 'run_blocked', 'machine_offline', 'delivery_failed', 'agent_outdated'].map((k) => [k, { enabled: true, minutes: 30 }]),
  ) as ProjectHealthSetup['signals'];

  it('switches a sign off and changes its minutes', () => {
    const onChange = vi.fn();
    render(<HealthSetup value={{ enabled: true, signals }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /PR verde sem merge/ }));
    expect(onChange).toHaveBeenLastCalledWith({ enabled: true, signals: { ...signals, pr_ready: { enabled: false, minutes: 30 } } });
    fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '180' } });
    expect(onChange).toHaveBeenLastCalledWith({ enabled: true, signals: { ...signals, pr_ready: { enabled: true, minutes: 180 } } });
  });

  it('turning the watcher off hides the signs', () => {
    render(<HealthSetup value={{ enabled: false, signals }} onChange={() => {}} />);
    expect(screen.queryAllByRole('spinbutton')).toHaveLength(0);
  });
});
