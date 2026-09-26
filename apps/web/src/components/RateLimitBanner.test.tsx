// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Tab } from '../lib/types';

const swapAccountMock = vi.fn();

vi.mock('../lib/api', () => ({
  api: { tabs: { swapAccount: (...a: unknown[]) => swapAccountMock(...a) } },
  ApiError: class ApiError extends Error {
    status: number;
    code?: string;
    constructor(status: number, message: string, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));

import { ApiError } from '../lib/api';
import { RateLimitBanner } from './RateLimitBanner';

const tab = (over: Partial<Pick<Tab, 'id' | 'state' | 'rate_limited_at'>> = {}): Pick<Tab, 'id' | 'state' | 'rate_limited_at'> => ({
  id: 't1',
  state: 'error',
  rate_limited_at: '2026-09-26T00:00:00.000Z',
  ...over,
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('RateLimitBanner', () => {
  it('renders nothing when rate_limited_at is null', () => {
    const { container } = render(<RateLimitBanner tab={tab({ rate_limited_at: null })} canSwap />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the tab is working, even if rate_limited_at is set', () => {
    const { container } = render(<RateLimitBanner tab={tab({ state: 'working' })} canSwap />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the message and a button otherwise', () => {
    render(<RateLimitBanner tab={tab()} canSwap />);
    expect(screen.getByText('Limite de uso da conta atingido.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Trocar conta e retomar' })).toBeTruthy();
  });

  it('shows no button when canSwap is false', () => {
    render(<RateLimitBanner tab={tab()} canSwap={false} />);
    expect(screen.getByText('Limite de uso da conta atingido.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Trocar conta e retomar' })).toBeNull();
  });

  it('swaps: disables the button while pending, then shows the new account', async () => {
    let resolve!: (v: { from: { id: string; label: string } | null; to: { id: string; label: string } }) => void;
    swapAccountMock.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<RateLimitBanner tab={tab()} canSwap />);
    fireEvent.click(screen.getByRole('button', { name: 'Trocar conta e retomar' }));
    expect(swapAccountMock).toHaveBeenCalledWith('t1');
    expect(screen.getByRole('button', { name: 'Trocando…' })).toHaveProperty('disabled', true);
    await act(async () => {
      resolve({ from: { id: 'a1', label: 'pessoal' }, to: { id: 'a2', label: 'trabalho' } });
    });
    expect(screen.getByText('Retomando em trabalho…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Trocar conta e retomar' })).toBeNull();
  });

  it('shows the ApiError message when the swap is rejected', async () => {
    swapAccountMock.mockRejectedValue(new ApiError(409, 'Só há uma conta Claude nesta máquina.'));
    render(<RateLimitBanner tab={tab()} canSwap />);
    fireEvent.click(screen.getByRole('button', { name: 'Trocar conta e retomar' }));
    await act(async () => {});
    expect(screen.getByText('Só há uma conta Claude nesta máquina.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Trocar conta e retomar' })).toBeTruthy();
  });
});

describe('RateLimitBanner, keyed like its call site in TerminalsView', () => {
  // Mirrors `key={`${focusedLiveTab.id}:${focusedLiveTab.rate_limited_at ?? ''}`}` at the
  // TerminalsView call site: a new focused tab, or the same tab hitting the limit again (a fresh
  // rate_limited_at), must remount the banner instead of carrying over its local busy/done/error
  // state. This wrapper is test-only; production code exports nothing new for it.
  function Keyed({ t, canSwap }: { t: Pick<Tab, 'id' | 'state' | 'rate_limited_at'>; canSwap: boolean }) {
    return <RateLimitBanner key={`${t.id}:${t.rate_limited_at ?? ''}`} tab={t} canSwap={canSwap} />;
  }

  it('re-offers the button after a new rate-limit incident on the same tab, instead of a stale "Retomando em …"', async () => {
    swapAccountMock.mockResolvedValue({ from: { id: 'a1', label: 'pessoal' }, to: { id: 'a2', label: 'trabalho' } });
    const { rerender } = render(<Keyed t={tab({ rate_limited_at: '2026-09-26T00:00:00.000Z' })} canSwap />);
    fireEvent.click(screen.getByRole('button', { name: 'Trocar conta e retomar' }));
    await act(async () => {});
    expect(screen.getByText('Retomando em trabalho…')).toBeTruthy();

    // the same tab hits the limit again: a fresh rate_limited_at
    rerender(<Keyed t={tab({ rate_limited_at: '2026-09-26T00:05:00.000Z' })} canSwap />);
    expect(screen.queryByText('Retomando em trabalho…')).toBeNull();
    expect(screen.getByRole('button', { name: 'Trocar conta e retomar' })).toBeTruthy();
  });

  it('does not carry a pending/error state over to a newly focused rate-limited tab', async () => {
    swapAccountMock.mockRejectedValue(new ApiError(409, 'Só há uma conta Claude nesta máquina.'));
    const { rerender } = render(<Keyed t={tab({ id: 't1' })} canSwap />);
    fireEvent.click(screen.getByRole('button', { name: 'Trocar conta e retomar' }));
    await act(async () => {});
    expect(screen.getByText('Só há uma conta Claude nesta máquina.')).toBeTruthy();

    // focus moves to a different rate-limited tab
    rerender(<Keyed t={tab({ id: 't2' })} canSwap />);
    expect(screen.queryByText('Só há uma conta Claude nesta máquina.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Trocar conta e retomar' })).toBeTruthy();
  });
});
