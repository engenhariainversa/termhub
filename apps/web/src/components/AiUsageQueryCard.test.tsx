// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import type { AiAccount, Machine } from '../lib/types';

const updateMachineMock = vi.fn(async (_id: string, input: Partial<Machine>) => input);
const canMock = vi.fn((_resource: string, _action?: string) => true);

vi.mock('../lib/data', () => ({ useData: () => ({ updateMachine: updateMachineMock }) }));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ can: canMock }) }));

import { AiUsageQueryCard, AiUsageQuerySettings } from './AiUsageQueryCard';

const machine = (id: string, name: string, ai_usage_query = true, type: Machine['type'] = 'agent') =>
  ({ id, name, type, ai_usage_query }) as Machine;

const account = (id: string, machine_id: string): AiAccount => ({ id, provider: 'claude', label: id, machine_id, config_dir: null, created_at: '' });

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  updateMachineMock.mockImplementation(async (_id: string, input: Partial<Machine>) => input);
  canMock.mockImplementation(() => true);
});

describe('AiUsageQueryCard', () => {
  it.each(['agent', 'ssh', 'local'] as const)('shows the value on a %s machine and saves the toggle', async (type) => {
    render(<AiUsageQueryCard machine={machine('m1', 'mini', true, type)} />);
    const box = screen.getByLabelText('Consultar o uso das contas de IA') as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    await waitFor(() => expect(updateMachineMock).toHaveBeenCalledWith('m1', { ai_usage_query: false }));
    expect(box.checked).toBe(false);
  });

  it('reverts the toggle and shows the server message when saving fails', async () => {
    updateMachineMock.mockRejectedValue(new ApiError(403, 'Sem permissão'));
    render(<AiUsageQueryCard machine={machine('m1', 'mini', false)} />);
    const box = screen.getByLabelText('Consultar o uso das contas de IA') as HTMLInputElement;
    fireEvent.click(box);
    await screen.findByText('Sem permissão');
    expect(box.checked).toBe(false);
  });
});

describe('AiUsageQuerySettings', () => {
  it('lists every machine with an AI account, with the checkbox reflecting ai_usage_query', async () => {
    render(
      <AiUsageQuerySettings
        machines={[machine('m1', 'mac', true), machine('m2', 'jarvis', false, 'ssh'), machine('m3', 'hulk')]}
        accounts={[account('a1', 'm1'), account('a2', 'm2')]}
      />,
    );
    expect(screen.getByLabelText('Consultar o uso das contas de IA em mac')).toBeChecked();
    expect(screen.getByLabelText('Consultar o uso das contas de IA em jarvis')).not.toBeChecked();
    expect(screen.queryByLabelText('Consultar o uso das contas de IA em hulk')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Consultar o uso das contas de IA em jarvis'));
    await waitFor(() => expect(updateMachineMock).toHaveBeenCalledWith('m2', { ai_usage_query: true }));
  });

  it('renders nothing for who cannot update machines', () => {
    canMock.mockImplementation(() => false);
    const { container } = render(<AiUsageQuerySettings machines={[machine('m1', 'mac')]} accounts={[account('a1', 'm1')]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
