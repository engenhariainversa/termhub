// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import type { AiAccount, Machine } from '../lib/types';

const updateMachineMock = vi.fn(async (_id: string, input: Partial<Machine>) => input);

vi.mock('../lib/data', () => ({ useData: () => ({ updateMachine: updateMachineMock }) }));

import { AutoSwapSettings } from './AutoSwapSettings';

const machine = (id: string, name: string, claude_auto_swap = false): Machine => ({
  id,
  name,
  subtitle: null,
  host: null,
  ssh_user: null,
  ssh_port: 22,
  type: 'agent',
  os: 'macos',
  capabilities: [],
  checked_at: null,
  agent_version: null,
  agent_last_seen_at: null,
  agent_auto_update: false,
  claude_auto_swap,
  is_local: false,
  owner_id: 'u1',
  owner_name: null,
  created_at: '',
});

const account = (id: string, machine_id: string, provider: AiAccount['provider'] = 'claude'): AiAccount => ({
  id,
  provider,
  label: id,
  machine_id,
  config_dir: null,
  created_at: '',
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  updateMachineMock.mockImplementation(async (_id: string, input: Partial<Machine>) => input);
});

describe('AutoSwapSettings', () => {
  it('renders nothing when no machine has 2+ Claude accounts', () => {
    const { container } = render(
      <AutoSwapSettings machines={[machine('m1', 'mac')]} accounts={[account('a1', 'm1'), account('a2', 'm1', 'chatgpt')]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('lists only machines with 2+ Claude accounts, with the checkbox reflecting claude_auto_swap', () => {
    render(
      <AutoSwapSettings
        machines={[machine('m1', 'mac', true), machine('m2', 'jarvis')]}
        accounts={[account('a1', 'm1'), account('a2', 'm1'), account('a3', 'm2')]}
      />,
    );
    const box = screen.getByLabelText('Trocar de conta sozinho quando o Claude atingir o limite em mac') as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(screen.queryByLabelText('Trocar de conta sozinho quando o Claude atingir o limite em jarvis')).toBeNull();
  });

  it('toggles through updateMachine', async () => {
    render(<AutoSwapSettings machines={[machine('m1', 'mac')]} accounts={[account('a1', 'm1'), account('a2', 'm1')]} />);
    fireEvent.click(screen.getByLabelText('Trocar de conta sozinho quando o Claude atingir o limite em mac'));
    await waitFor(() => expect(updateMachineMock).toHaveBeenCalledWith('m1', { claude_auto_swap: true }));
  });

  it('reverts the box and shows the message on error', async () => {
    updateMachineMock.mockRejectedValue(new ApiError(500, 'Erro ao salvar'));
    render(<AutoSwapSettings machines={[machine('m1', 'mac')]} accounts={[account('a1', 'm1'), account('a2', 'm1')]} />);
    const box = screen.getByLabelText('Trocar de conta sozinho quando o Claude atingir o limite em mac') as HTMLInputElement;
    fireEvent.click(box);
    await act(async () => {});
    expect(box.checked).toBe(false);
    expect(screen.getByText('Erro ao salvar')).toBeTruthy();
  });
});
