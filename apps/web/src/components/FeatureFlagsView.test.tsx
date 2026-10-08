// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureFlagInfo } from '../lib/types';
import { FeatureFlagsView } from './FeatureFlagsView';

const listMock = vi.fn();
const setMock = vi.fn();
const setOverrideMock = vi.fn();
const removeOverrideMock = vi.fn();
const refresh = vi.fn(async () => {});
const authMock = { can: () => true, refresh };

vi.mock('../lib/api', () => {
  class ApiError extends Error {}
  return {
    ApiError,
    api: {
      featureFlags: {
        list: (...a: unknown[]) => listMock(...a),
        set: (...a: unknown[]) => setMock(...a),
        setOverride: (...a: unknown[]) => setOverrideMock(...a),
        removeOverride: (...a: unknown[]) => removeOverrideMock(...a),
      },
    },
  };
});
vi.mock('../lib/auth', () => ({ useAuth: () => authMock }));

const flag = (over: Partial<FeatureFlagInfo> = {}): FeatureFlagInfo => ({ key: 'subscriptions', default: false, enabled: false, updated_at: null, overrides: [], ...over });

beforeEach(() => {
  setMock.mockResolvedValue({});
  setOverrideMock.mockResolvedValue({ overrides: [] });
  removeOverrideMock.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  authMock.can = () => true;
});

describe('FeatureFlagsView', () => {
  it('shows subscriptions off for everyone, with nobody testing it', async () => {
    listMock.mockResolvedValue({ flags: [flag()] });
    render(<FeatureFlagsView />);
    const sw = await screen.findByRole('switch', { name: 'Assinaturas para todos' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('Ninguém tem um valor próprio.')).toBeTruthy();
  });

  it('turns it on for the instance, then reloads the list and the own flags', async () => {
    listMock.mockResolvedValue({ flags: [flag()] });
    render(<FeatureFlagsView />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Assinaturas para todos' }));
    await waitFor(() => expect(setMock).toHaveBeenCalledWith('subscriptions', true));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it('adds a tester by e-mail, and removes one', async () => {
    listMock.mockResolvedValue({ flags: [flag({ overrides: [{ flag: 'subscriptions', user_id: 'u2', email: 'ana@gmail.com', name: 'Ana', enabled: true, created_at: '2026-10-07T12:00:00.000Z' }] })] });
    render(<FeatureFlagsView />);
    fireEvent.change(await screen.findByLabelText('E-mail de quem vai testar'), { target: { value: 'bia@gmail.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ligar para essa pessoa' }));
    await waitFor(() => expect(setOverrideMock).toHaveBeenCalledWith('subscriptions', 'bia@gmail.com', true));
    fireEvent.click(await screen.findByRole('button', { name: 'Remover' }));
    await waitFor(() => expect(removeOverrideMock).toHaveBeenCalledWith('subscriptions', 'u2'));
  });

  it('is read-only without feature_flags:update', async () => {
    authMock.can = () => false;
    listMock.mockResolvedValue({ flags: [flag()] });
    render(<FeatureFlagsView />);
    expect((await screen.findByRole('switch', { name: 'Assinaturas para todos' })).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByLabelText('E-mail de quem vai testar')).toBeNull();
  });
});
