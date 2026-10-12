// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Machine } from '../lib/types';

const updateMachineMock = vi.fn();
const aiMemoryMock = vi.fn();
vi.mock('../lib/data', () => ({ useData: () => ({ updateMachine: updateMachineMock }) }));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: { machines: { aiMemory: (id: string) => aiMemoryMock(id) } } };
});

import { AiMemoryCard, aiMemoryStateLine } from './AiMemoryCard';

const off = { id: 'm1', name: 'mini', type: 'agent', ai_memory_enabled: false, ai_memory_url: null } as Machine;
const on = { ...off, ai_memory_enabled: true } as Machine;
const detected = { enabled: true as const, url: 'http://127.0.0.1:49374', checked_at: '2026-10-07T12:00:00.000Z' };

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('AiMemoryCard', () => {
  it('off by default: never asks the machine and shows no URL field', () => {
    render(<AiMemoryCard machine={off} />);
    expect((screen.getByLabelText('Usar ai-memory nesta máquina') as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByLabelText('Servidor local')).toBeNull();
    expect(aiMemoryMock).not.toHaveBeenCalled();
  });

  it('turning it on saves the switch and shows what the machine detected', async () => {
    updateMachineMock.mockResolvedValue({ ...on });
    aiMemoryMock.mockResolvedValue({ ...detected, installed: true, version: '2.6.0', server_up: true });
    render(<AiMemoryCard machine={off} />);
    fireEvent.click(screen.getByLabelText('Usar ai-memory nesta máquina'));
    await waitFor(() => expect(updateMachineMock).toHaveBeenCalledWith('m1', { ai_memory_enabled: true }));
    expect(await screen.findByText('ai-memory 2.6.0 instalado · servidor no ar em http://127.0.0.1:49374')).toBeTruthy();
    expect(aiMemoryMock).toHaveBeenCalledWith('m1');
  });

  it('saves a new URL and shows the server error when it is refused', async () => {
    aiMemoryMock.mockResolvedValue({ ...detected, installed: false, version: null, server_up: false });
    const { ApiError } = await import('../lib/api');
    updateMachineMock.mockRejectedValue(new ApiError(400, 'O endereço do ai-memory precisa ser local (127.0.0.1, localhost) ou de rede privada'));
    render(<AiMemoryCard machine={on} />);
    expect(await screen.findByText('ai-memory não encontrado nesta máquina (comando ai-memory fora do PATH).')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Servidor local'), { target: { value: 'http://example.com' } });
    fireEvent.click(screen.getByText('Salvar'));
    await waitFor(() => expect(updateMachineMock).toHaveBeenCalledWith('m1', { ai_memory_url: 'http://example.com' }));
    expect(await screen.findByText('O endereço do ai-memory precisa ser local (127.0.0.1, localhost) ou de rede privada')).toBeTruthy();
  });

  it('reverts the switch when saving fails', async () => {
    updateMachineMock.mockRejectedValue(new Error('x'));
    render(<AiMemoryCard machine={off} />);
    const box = screen.getByLabelText('Usar ai-memory nesta máquina') as HTMLInputElement;
    fireEvent.click(box);
    await screen.findByText('Erro ao salvar');
    expect(box.checked).toBe(false);
  });
});

describe('aiMemoryStateLine', () => {
  it('warns when the server is down or the version is unknown', () => {
    expect(aiMemoryStateLine({ ...detected, installed: true, version: null, server_up: false })).toEqual({
      text: 'ai-memory versão desconhecida instalado · servidor fora do ar em http://127.0.0.1:49374 (rode ai-memory serve)',
      warn: true,
    });
  });
});
