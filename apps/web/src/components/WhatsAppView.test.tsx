// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WhatsAppSettings } from '../lib/types';
import { WhatsAppView } from './WhatsAppView';

const getMock = vi.fn();
const saveMock = vi.fn();
const testMock = vi.fn();
const messageMock = vi.fn();
vi.mock('../lib/api', () => ({
  ApiError: class extends Error {},
  api: {
    whatsapp: {
      get: (...a: unknown[]) => getMock(...a),
      save: (...a: unknown[]) => saveMock(...a),
      test: (...a: unknown[]) => testMock(...a),
      testMessage: (...a: unknown[]) => messageMock(...a),
      remove: vi.fn(),
    },
  },
}));

const empty: WhatsAppSettings = { configured: false, server_url: null, instance: null, number: null, enabled: false, notify_needs_you: true, notify_done: true, has_api_key: false, last_sent_at: null, last_error: null, last_error_at: null };
const saved: WhatsAppSettings = { ...empty, configured: true, server_url: 'https://wpp.example.com', instance: 'termhub', number: '5562999998888', enabled: true, has_api_key: true };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('WhatsAppView (TER-1201)', () => {
  beforeEach(() => saveMock.mockImplementation(async () => ({ whatsapp: saved })));

  it('first setup: asks for the key and saves the form', async () => {
    getMock.mockResolvedValue({ whatsapp: empty });
    render(<WhatsAppView />);
    fireEvent.change(await screen.findByLabelText('Endereço do servidor'), { target: { value: 'https://wpp.example.com' } });
    const key = screen.getByLabelText('API key');
    expect(key).toBeRequired();
    fireEvent.change(key, { target: { value: 'k-1' } });
    fireEvent.change(screen.getByLabelText('Instância'), { target: { value: 'termhub' } });
    fireEvent.change(screen.getByLabelText('Seu número'), { target: { value: '5562999998888' } });
    expect(screen.queryByRole('button', { name: 'Enviar mensagem de teste' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith({ server_url: 'https://wpp.example.com', api_key: 'k-1', instance: 'termhub', number: '5562999998888', enabled: true, notify_needs_you: true, notify_done: true }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Salvo.');
  });

  it('a saved setup never shows the key, and a save with the field blank keeps it', async () => {
    getMock.mockResolvedValue({ whatsapp: saved });
    render(<WhatsAppView />);
    const key = await screen.findByLabelText('API key');
    expect(key).toHaveValue('');
    expect(key).not.toBeRequired();
    fireEvent.click(screen.getByRole('checkbox', { name: /Concluído/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const sent = saveMock.mock.lastCall?.[0] as Record<string, unknown>;
    expect(sent).toMatchObject({ notify_done: false });
    expect(sent).not.toHaveProperty('api_key');
  });

  it('explains a failed connection test', async () => {
    getMock.mockResolvedValue({ whatsapp: saved });
    testMock.mockResolvedValue({ ok: false, code: 'NOT_CONNECTED' });
    render(<WhatsAppView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Testar conexão' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('o WhatsApp não está conectado');
    expect(testMock).toHaveBeenCalledWith({ server_url: 'https://wpp.example.com', instance: 'termhub', api_key: undefined });
  });

  it('sends the test message', async () => {
    getMock.mockResolvedValue({ whatsapp: saved });
    messageMock.mockResolvedValue({ ok: true });
    render(<WhatsAppView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enviar mensagem de teste' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Mensagem de teste enviada');
  });
});
