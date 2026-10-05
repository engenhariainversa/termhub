// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Device, DeviceEventView, DeviceRequestView } from '../lib/types';

const requestsMock = vi.fn();
const approveMock = vi.fn();
const denyMock = vi.fn();
const listMock = vi.fn();
const renameMock = vi.fn();
const revokeMock = vi.fn();
const eventsMock = vi.fn();
const testPushMock = vi.fn();

vi.mock('../lib/api', () => {
  class ApiError extends Error {
    constructor(message: string, public code?: string) {
      super(message);
    }
  }
  return {
    ApiError,
    api: {
      devices: {
        requests: (...a: unknown[]) => requestsMock(...a),
        approve: (...a: unknown[]) => approveMock(...a),
        deny: (...a: unknown[]) => denyMock(...a),
        list: (...a: unknown[]) => listMock(...a),
        rename: (...a: unknown[]) => renameMock(...a),
        revoke: (...a: unknown[]) => revokeMock(...a),
        events: (...a: unknown[]) => eventsMock(...a),
        testPush: (...a: unknown[]) => testPushMock(...a),
      },
    },
  };
});

const authMock = { can: (_resource: string, _action?: string) => true };
vi.mock('../lib/auth', () => ({ useAuth: () => authMock }));

import { DevicesView } from './DevicesView';

function req(over: Partial<DeviceRequestView> & { id: string }): DeviceRequestView {
  return {
    device_name: 'iPhone de Ana',
    model: 'iPhone 15',
    platform: 'ios',
    os_version: '17.4',
    country: 'BR',
    city: 'São Paulo',
    ip: '200.1.2.3',
    verification_code: 'K7F-2QD',
    created_at: '2026-09-24T12:00:00.000Z',
    expires_at: '2026-09-24T12:10:00.000Z',
    ...over,
  };
}

function dev(over: Partial<Device> & { id: string }): Device {
  return {
    id: over.id,
    user_id: 'u1',
    name: 'iPhone de Ana',
    platform: 'ios',
    model: 'iPhone 15',
    os_version: '17.4',
    app_version: '1.0.0',
    status: 'active',
    revoked_at: null,
    revoked_reason: null,
    pin_locked_until: null,
    last_seen_at: null,
    created_at: '2026-09-20T12:00:00.000Z',
    ...over,
  };
}

function evt(over: Partial<DeviceEventView> & { id: string }): DeviceEventView {
  return { id: over.id, kind: 'device_activated', text: 'Aparelho ativado', created_at: '2026-09-20T12:00:00.000Z', ...over };
}

beforeEach(() => {
  requestsMock.mockResolvedValue({ requests: [] });
  listMock.mockResolvedValue({ devices: [] });
  eventsMock.mockResolvedValue({ events: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  authMock.can = () => true;
  vi.useRealTimers();
});

describe('DevicesView', () => {
  it('shows the empty state when there are no requests and no devices', async () => {
    render(<DevicesView />);
    expect(await screen.findByText('Instale o app termhub no celular e entre com seu e-mail. O pedido de acesso aparece aqui.')).toBeTruthy();
  });

  it('shows a pending request; Aprovar opens the code dialog and approves; Recusar denies with no dialog', async () => {
    requestsMock.mockResolvedValue({ requests: [req({ id: 'r1' })] });
    approveMock.mockResolvedValue({ request: req({ id: 'r1' }) });
    denyMock.mockResolvedValue({ request: req({ id: 'r1' }) });
    render(<DevicesView />);

    expect(await screen.findByText('K7F-2QD')).toBeTruthy();
    expect(screen.getByText('iPhone de Ana')).toBeTruthy();
    expect(screen.getByText('iPhone 15 · iOS 17.4')).toBeTruthy();
    expect(screen.getByText('São Paulo, BR · IP 200.1.2.3')).toBeTruthy();
    expect(screen.getByText(/^Pedido em 24\/09\/2026 às \d{2}:00 · /)).toBeTruthy();
    expect(screen.getByText('Se você não pediu isso, recuse.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Aprovar' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Aprovar aparelho')).toBeTruthy();
    expect(within(dialog).getByText('O código na tela do celular é K7F-2QD?')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Aprovar' }));
    await waitFor(() => expect(approveMock).toHaveBeenCalledWith('r1'));
    expect(screen.queryByText('K7F-2QD')).toBeNull();

    // Recusar, on a fresh pending request, denies straight away — no dialog.
    requestsMock.mockResolvedValue({ requests: [req({ id: 'r2' })] });
    cleanup();
    render(<DevicesView />);
    await screen.findByText('K7F-2QD');
    fireEvent.click(screen.getByRole('button', { name: 'Recusar' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(denyMock).toHaveBeenCalledWith('r2'));
  });

  it('shows the IP even with no known place, and counts down "expira em" every minute', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-09-24T12:03:00.000Z'));
    requestsMock.mockResolvedValue({ requests: [req({ id: 'r1', city: null, country: null })] });
    const { unmount } = render(<DevicesView />);
    expect(await screen.findByText('IP 200.1.2.3')).toBeTruthy();
    expect(screen.getByText(/expira em 7 min$/)).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText(/expira em 6 min$/)).toBeTruthy();

    const clear = vi.spyOn(globalThis, 'clearInterval');
    unmount();
    expect(clear).toHaveBeenCalled();
  });

  it('disables Aprovar and warns once 5 devices are already active', async () => {
    requestsMock.mockResolvedValue({ requests: [req({ id: 'r1' })] });
    listMock.mockResolvedValue({ devices: Array.from({ length: 5 }, (_, i) => dev({ id: `d${i}` })) });
    render(<DevicesView />);
    await screen.findByText('K7F-2QD');
    const approveBtn = screen.getByRole('button', { name: 'Aprovar' }) as HTMLButtonElement;
    expect(approveBtn.disabled).toBe(true);
    expect(screen.getByText('Revogue um aparelho antes')).toBeTruthy();
  });

  it('lists devices with name, model/OS, added date, last seen and situation', async () => {
    // Far enough in the future to stay "locked" regardless of when this test actually runs. The
    // expected label is built from this same instant with the same formatter the component uses,
    // so the assertion holds under any runner timezone (verified under both TZ=UTC and
    // TZ=America/Sao_Paulo — see task-11-report.md).
    const PIN_LOCKED_UNTIL = '2099-01-01T17:30:00.000Z';
    const lockedTime = new Date(PIN_LOCKED_UNTIL).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    listMock.mockResolvedValue({
      devices: [
        dev({ id: 'd1', name: 'iPhone de Ana', model: 'iPhone 15', os_version: '17.4', created_at: '2026-09-01T10:00:00.000Z', last_seen_at: null, status: 'active' }),
        dev({ id: 'd2', name: 'Pixel', model: 'Pixel 8', os_version: '14', created_at: '2026-09-02T10:00:00.000Z', last_seen_at: '2026-09-20T09:00:00.000Z', status: 'active', pin_locked_until: PIN_LOCKED_UNTIL }),
        dev({ id: 'd3', name: 'Old phone', status: 'revoked', revoked_reason: 'pin_bruteforce', created_at: '2026-08-01T10:00:00.000Z' }),
        dev({ id: 'd4', name: 'Other phone', status: 'revoked', revoked_reason: 'user', created_at: '2026-08-02T10:00:00.000Z' }),
      ],
    });
    render(<DevicesView />);

    const row1 = (await screen.findByText('iPhone de Ana')).closest('tr')!;
    expect(within(row1).getByText(new Date('2026-09-01T10:00:00.000Z').toLocaleDateString('pt-BR'))).toBeTruthy();
    expect(within(row1).getByText('nunca')).toBeTruthy();
    expect(within(row1).getByText('ativo')).toBeTruthy();
    expect(within(row1).getByText(/iPhone 15/)).toBeTruthy();

    const row2 = screen.getByText('Pixel').closest('tr')!;
    expect(within(row2).getByText(`bloqueado por PIN até ${lockedTime}`)).toBeTruthy();

    const row3 = screen.getByText('Old phone').closest('tr')!;
    expect(within(row3).getByText('revogado (tentativas de PIN)')).toBeTruthy();
    expect(row3.className).toContain('text-fg-dim');

    const row4 = screen.getByText('Other phone').closest('tr')!;
    expect(within(row4).getByText('revogado')).toBeTruthy();
    expect(row4.className).toContain('text-fg-dim');
  });

  it('revokes a device after confirmation', async () => {
    listMock.mockResolvedValue({ devices: [dev({ id: 'd1', name: 'iPhone de Ana' })] });
    revokeMock.mockResolvedValue({ device: dev({ id: 'd1', name: 'iPhone de Ana', status: 'revoked', revoked_reason: 'user' }) });
    render(<DevicesView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revogar iPhone de Ana' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Revogar aparelho')).toBeTruthy();
    expect(within(dialog).getByText('Ele perde o acesso na hora. Isso não pode ser desfeito.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revogar' }));
    await waitFor(() => expect(revokeMock).toHaveBeenCalledWith('d1'));
    expect(await screen.findByText('revogado')).toBeTruthy();
  });

  it('renames a device from an inline input on Enter', async () => {
    listMock.mockResolvedValue({ devices: [dev({ id: 'd1', name: 'iPhone de Ana' })] });
    renameMock.mockResolvedValue({ device: dev({ id: 'd1', name: 'Meu iPhone' }) });
    render(<DevicesView />);
    fireEvent.click(await screen.findByRole('button', { name: 'iPhone de Ana' }));
    const input = screen.getByDisplayValue('iPhone de Ana');
    fireEvent.change(input, { target: { value: 'Meu iPhone' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(renameMock).toHaveBeenCalledWith('d1', 'Meu iPhone'));
    expect(await screen.findByText('Meu iPhone')).toBeTruthy();
  });

  it('lists the activity trail with each event\'s text and date', async () => {
    eventsMock.mockResolvedValue({
      events: [evt({ id: 'e1', text: 'Pedido aprovado de iPhone 15', created_at: '2026-09-20T12:00:00.000Z' }), evt({ id: 'e2', text: 'Sessão renovada', created_at: '2026-09-21T08:00:00.000Z' })],
    });
    render(<DevicesView />);
    expect(await screen.findByText('Pedido aprovado de iPhone 15')).toBeTruthy();
    expect(screen.getByText('20/09/2026')).toBeTruthy();
    expect(screen.getByText('Sessão renovada')).toBeTruthy();
    expect(screen.getByText('21/09/2026')).toBeTruthy();
  });
});

describe('DevicesView — notificação de teste (TER-913)', () => {
  it('is hidden while no active device has notifications on', async () => {
    listMock.mockResolvedValue({ devices: [dev({ id: 'd1' }), dev({ id: 'd2', status: 'revoked', push_token: 'ExponentPushToken[x]' })] });
    render(<DevicesView />);
    await screen.findByText('Aparelhos');
    expect(screen.queryByRole('button', { name: 'Enviar notificação de teste' })).toBeNull();
  });

  it('sends the chosen kind and delay to the device and says what happens next', async () => {
    listMock.mockResolvedValue({ devices: [dev({ id: 'd1', push_token: 'ExponentPushToken[a]' })] });
    testPushMock.mockResolvedValue({ scheduled_for: '2026-10-05T00:00:10.000Z', ticket: null });
    render(<DevicesView />);
    const send = await screen.findByRole('button', { name: 'Enviar notificação de teste' });
    // One device: no device picker.
    expect(screen.queryByLabelText('Aparelho')).toBeNull();
    fireEvent.change(screen.getByLabelText('Tipo de aviso'), { target: { value: 'reply' } });
    fireEvent.change(screen.getByLabelText('Quando enviar'), { target: { value: '10' } });
    fireEvent.click(send);
    await waitFor(() => expect(testPushMock).toHaveBeenCalledWith('d1', { kind: 'reply', delay_seconds: 10 }));
    expect(await screen.findByText('Enviando em 10 s. Feche o app para ver como ela chega.')).toBeTruthy();
  });

  it('picks among several devices, shows a ticket error and a server refusal', async () => {
    listMock.mockResolvedValue({ devices: [dev({ id: 'd1', push_token: 'ExponentPushToken[a]' }), dev({ id: 'd2', name: 'Pixel', push_token: 'ExponentPushToken[b]' })] });
    testPushMock.mockResolvedValueOnce({ scheduled_for: '', ticket: { status: 'error', error: 'DeviceNotRegistered' } });
    render(<DevicesView />);
    await screen.findByRole('button', { name: 'Enviar notificação de teste' });
    fireEvent.change(screen.getByLabelText('Aparelho'), { target: { value: 'd2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar notificação de teste' }));
    await waitFor(() => expect(testPushMock).toHaveBeenCalledWith('d2', { kind: 'confirmation', delay_seconds: 0 }));
    expect(await screen.findByText('A notificação de teste falhou: DeviceNotRegistered')).toBeTruthy();

    const { ApiError } = await import('../lib/api');
    testPushMock.mockRejectedValueOnce(new ApiError('Muitas notificações de teste. Espere um minuto e tente de novo.'));
    fireEvent.click(screen.getByRole('button', { name: 'Enviar notificação de teste' }));
    expect(await screen.findByText('Muitas notificações de teste. Espere um minuto e tente de novo.')).toBeTruthy();
  });

  it('needs devices:update', async () => {
    authMock.can = (_r: string, action?: string) => action !== 'update';
    listMock.mockResolvedValue({ devices: [dev({ id: 'd1', push_token: 'ExponentPushToken[a]' })] });
    render(<DevicesView />);
    await screen.findByText('Aparelhos');
    expect(screen.queryByRole('button', { name: 'Enviar notificação de teste' })).toBeNull();
  });
});
