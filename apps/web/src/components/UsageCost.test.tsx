// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../lib/types';

const usageMock = vi.fn();
vi.mock('../lib/api', () => ({ api: { automation: { usage: (...a: unknown[]) => usageMock(...a) } } }));

import { CardUsageCost, UsageCost } from './UsageCost';

const line = (input: number, cost: number | null) => ({ input_tokens: input, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: cost });
const task = (over: Partial<Task>) => ({ id: 'c1', project_id: 'p1', type: 'task', auto: true, ...over }) as Task;

beforeEach(() => {
  usageMock.mockReset();
  usageMock.mockResolvedValue({
    from: null,
    to: null,
    total: line(5000, 2),
    cards: [{ ...line(2000, 0.005), task_id: 'c1', ref: 'TER-1' }],
    epics: [{ ...line(5000, null), epic_id: 'e1', ref: 'TER-9' }],
    accounts: [],
  });
});
afterEach(cleanup);

describe('CardUsageCost', () => {
  it('shows the cost of a tagged card', async () => {
    render(<CardUsageCost task={task({})} />);
    expect(await screen.findByText('Custo do card')).toBeInTheDocument();
    expect(screen.getByText(/custo US\$\s0,0050 · 2 mil tokens/)).toBeInTheDocument();
    expect(usageMock).toHaveBeenCalledWith('p1');
  });

  it('shows an epic\'s sum, "—" when nothing was priced', async () => {
    render(<CardUsageCost task={task({ id: 'e1', type: 'epic' })} />);
    expect(await screen.findByText('Custo do épico')).toBeInTheDocument();
    expect(screen.getByText('custo — · 5 mil tokens')).toBeInTheDocument();
  });

  it('asks nothing for a card that is not automatic', async () => {
    render(<CardUsageCost task={task({ auto: false })} />);
    await Promise.resolve();
    expect(usageMock).not.toHaveBeenCalled();
    expect(screen.queryByText('Custo do card')).toBeNull();
  });

  it('a Codex-only card (no tokens read) shows "custo —"', () => {
    render(<UsageCost usage={{ tokens: 0, cost_usd: null }} />);
    expect(screen.getByText('custo —')).toBeInTheDocument();
  });
});
