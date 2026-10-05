// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Device, User } from '../lib/types';

const listMock = vi.fn();
const devicesMock = vi.fn();
const setReviewMock = vi.fn();
const revokeDeviceMock = vi.fn();

vi.mock('../lib/api', () => {
  class ApiError extends Error {
    constructor(message: string, public code?: string) {
      super(message);
    }
  }
  return {
    ApiError,
    api: {
      users: {
        list: (...a: unknown[]) => listMock(...a),
        devices: (...a: unknown[]) => devicesMock(...a),
        setReview: (...a: unknown[]) => setReviewMock(...a),
        revokeDevice: (...a: unknown[]) => revokeDeviceMock(...a),
      },
    },
  };
});

import { ReviewAccountPanel } from './ReviewAccountPanel';

function targetUser(over: Partial<User> = {}): User {
  return {
    id: 'u2',
    email: 'ana@x.dev',
    name: 'Ana',
    avatar_url: null,
    role: 'member',
    role_info: { id: 'r-beta', name: 'BETA', label: 'Beta', is_admin: false },
    // Not read by the panel any more (finding 2 of the review): the BETA-role note follows the
    // server's own `can_enrol` (GET /users/:id/devices), never this list.
    permissions: [],
    has_password: false,
    has_google: true,
    invited_at: null,
    last_login_at: '2026-09-01T00:00:00.000Z',
    nickname: null,
    review_enabled_until: null,
    review_enabled_by: null,
    ...over,
  };
}

function adminUser(over: Partial<User> & { id: string }): User {
  return targetUser({ name: 'Pedro', role_info: { id: 'r-admin', name: 'ADMIN', label: 'Admin', is_admin: true }, ...over });
}

function dev(over: Partial<Device> & { id: string }): Device {
  return {
    id: over.id,
    user_id: 'u2',
    name: 'iPhone de Ana',
    platform: 'ios',
    model: 'iPhone 15',
    os_version: '18.1',
    app_version: '1.0.0',
    status: 'active',
    revoked_at: null,
    revoked_reason: null,
    pin_locked_until: null,
    last_seen_at: null,
    created_at: '2026-09-20T00:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  devicesMock.mockResolvedValue({ devices: [], events: [], can_enrol: true });
  listMock.mockResolvedValue({ users: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ReviewAccountPanel', () => {
  it('renders the "Modo revisão" switch off when review is not enabled', async () => {
    render(<ReviewAccountPanel user={targetUser()} onChange={() => {}} />);
    const sw = await screen.findByRole('switch', { name: 'Modo revisão' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('turning the switch on asks for a duration and confirms with Ligar, then calls setReview', async () => {
    setReviewMock.mockResolvedValue({ user: targetUser({ review_enabled_until: '2026-09-27T00:00:00.000Z', review_enabled_by: 'admin1' }) });
    render(<ReviewAccountPanel user={targetUser()} onChange={() => {}} />);
    const sw = await screen.findByRole('switch', { name: 'Modo revisão' });
    fireEvent.click(sw);

    expect(screen.getByLabelText('1 dia')).toBeTruthy();
    expect(screen.getByLabelText('3 dias')).toBeTruthy();
    expect(screen.getByLabelText('7 dias')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('3 dias'));
    fireEvent.click(screen.getByRole('button', { name: 'Ligar' }));
    await waitFor(() => expect(setReviewMock).toHaveBeenCalledWith('u2', { days: 3, revoke_devices: false }));
  });

  it('when review is on, shows "ligado até <data> por <nome>", Desligar agora and Desligar e revogar os aparelhos (through a ConfirmDialog)', async () => {
    listMock.mockResolvedValue({ users: [adminUser({ id: 'admin1', name: 'Pedro' })] });
    setReviewMock.mockResolvedValue({ user: targetUser() });
    devicesMock.mockResolvedValue({ devices: [dev({ id: 'd1' })], events: [], can_enrol: true });
    // Always in the future: a fixed date made this test fail once the clock passed it.
    const until = new Date(Date.now() + 3 * 86_400_000).toISOString();
    render(<ReviewAccountPanel user={targetUser({ review_enabled_until: until, review_enabled_by: 'admin1' })} onChange={() => {}} />);

    expect(await screen.findByText(`ligado até ${new Date(until).toLocaleString('pt-BR')} por Pedro`)).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Revogar' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Desligar agora' }));
    await waitFor(() => expect(setReviewMock).toHaveBeenCalledWith('u2', { days: null, revoke_devices: false }));

    fireEvent.click(screen.getByRole('button', { name: 'Desligar e revogar os aparelhos' }));
    const dialog = await screen.findByRole('dialog');
    // The server revokes the devices: the reload that follows must show them without Revogar.
    devicesMock.mockResolvedValue({ devices: [dev({ id: 'd1', status: 'revoked', revoked_reason: 'review' })], events: [], can_enrol: true });
    fireEvent.click(within(dialog).getByRole('button', { name: /Desligar/ }));
    await waitFor(() => expect(setReviewMock).toHaveBeenCalledWith('u2', { days: null, revoke_devices: true }));
    await waitFor(() => expect(screen.getByText(/iPhone de Ana/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Revogar' })).toBeNull();
  });

  it('shows "A conta de revisão não pode ser admin." and no switch for an admin target', async () => {
    render(<ReviewAccountPanel user={adminUser({ id: 'u3' })} onChange={() => {}} />);
    expect(await screen.findByText('A conta de revisão não pode ser admin.')).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it("lists the target's devices with Revogar", async () => {
    devicesMock.mockResolvedValue({ devices: [dev({ id: 'd1' })], events: [], can_enrol: true });
    revokeDeviceMock.mockResolvedValue({ device: dev({ id: 'd1', status: 'revoked', revoked_reason: 'admin' }) });
    render(<ReviewAccountPanel user={targetUser()} onChange={() => {}} />);
    expect(await screen.findByText(/iPhone de Ana/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Revogar' }));
    await waitFor(() => expect(revokeDeviceMock).toHaveBeenCalledWith('u2', 'd1'));
  });

  it('disables the clicked device\'s Revogar while the request is in flight, so a second click makes no second call', async () => {
    devicesMock.mockResolvedValue({ devices: [dev({ id: 'd1' })], events: [], can_enrol: true });
    let resolveRevoke!: (v: { device: Device }) => void;
    revokeDeviceMock.mockReturnValue(new Promise<{ device: Device }>((resolve) => (resolveRevoke = resolve)));
    render(<ReviewAccountPanel user={targetUser()} onChange={() => {}} />);
    const btn = await screen.findByRole('button', { name: 'Revogar' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(revokeDeviceMock).toHaveBeenCalledTimes(1);
    resolveRevoke({ device: dev({ id: 'd1', status: 'revoked', revoked_reason: 'admin' }) });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Revogar' })).toBeNull());
  });

  it('renders the BETA-role note when the server answers can_enrol: false', async () => {
    devicesMock.mockResolvedValue({ devices: [], events: [], can_enrol: false });
    render(<ReviewAccountPanel user={targetUser()} onChange={() => {}} />);
    expect(await screen.findByText('Essa conta precisa estar no role que tem Chat e Aparelhos (BETA); caso contrário os pedidos do app são ignorados.')).toBeTruthy();
  });

  it('does not render the BETA-role note when the server answers can_enrol: true', async () => {
    devicesMock.mockResolvedValue({ devices: [], events: [], can_enrol: true });
    render(<ReviewAccountPanel user={targetUser()} onChange={() => {}} />);
    await screen.findByRole('switch', { name: 'Modo revisão' });
    expect(screen.queryByText(/Essa conta precisa estar no role/)).toBeNull();
  });
});
