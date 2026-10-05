// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationPauseState } from '../lib/types';

const stateMock = vi.fn();
const pauseMock = vi.fn();
const resumeMock = vi.fn();
let canUpdate = true;
let seq = 0;
vi.mock('../lib/api', () => ({ api: { automation: { pauseState: () => stateMock(), pause: (...a: unknown[]) => pauseMock(...a), resume: (...a: unknown[]) => resumeMock(...a) } } }));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ can: () => canUpdate }) }));
vi.mock('../lib/monitor', () => ({ useMonitor: () => ({ automationSeq: seq }) }));

import { PAUSE_POLL_MS } from '../lib/automation-pause';
import { PauseAutomationButton, PauseBanner } from './PauseAutomationButton';

const running: AutomationPauseState = { paused_at: null, projects: [] };
const paused: AutomationPauseState = { paused_at: '2026-10-05T13:42:00.000Z', projects: [] };

beforeEach(() => {
  canUpdate = true;
  seq = 0;
  stateMock.mockReset().mockResolvedValue(running);
  pauseMock.mockReset().mockResolvedValue({ paused_at: paused.paused_at });
  resumeMock.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('PauseAutomationButton', () => {
  it('pauses everything with one click', async () => {
    render(<PauseAutomationButton />);
    stateMock.mockResolvedValue(paused);
    fireEvent.click(await screen.findByRole('button', { name: 'Pausar automático' }));
    expect(pauseMock).toHaveBeenCalledWith('all', false);
    expect(await screen.findByRole('button', { name: 'Retomar automático' })).toBeInTheDocument();
  });

  it('offers "Pausar e interromper as abas" in the menu', async () => {
    render(<PauseAutomationButton />);
    fireEvent.click(await screen.findByTitle('Mais opções'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pausar e interromper as abas' }));
    await waitFor(() => expect(pauseMock).toHaveBeenCalledWith('all', true));
  });

  it('resumes when paused', async () => {
    stateMock.mockResolvedValue(paused);
    render(<PauseAutomationButton />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retomar automático' }));
    expect(resumeMock).toHaveBeenCalledWith('all');
  });

  it('is not shown without projects:update', async () => {
    canUpdate = false;
    render(<PauseAutomationButton />);
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Pausar automático' })).toBeNull();
  });

  it('flips on its own within 5 s when another client pauses', async () => {
    vi.useFakeTimers();
    render(<PauseAutomationButton />);
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Pausar automático' })).toBeInTheDocument();
    stateMock.mockResolvedValue(paused);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAUSE_POLL_MS);
    });
    expect(screen.getByRole('button', { name: 'Retomar automático' })).toBeInTheDocument();
    expect(PAUSE_POLL_MS).toBeLessThan(5000);
  });
});

describe('PauseBanner', () => {
  it('says since when the work is paused, and is absent while it runs', async () => {
    stateMock.mockResolvedValue(paused);
    render(<PauseBanner />);
    expect(await screen.findByText(/^Automático pausado desde \d{2}:\d{2}\.$/)).toBeInTheDocument();
    cleanup();
    stateMock.mockResolvedValue({ paused_at: null, projects: [{ id: 'p1', paused_at: paused.paused_at }] });
    render(<PauseBanner projectId="p2" />);
    await act(async () => {});
    expect(screen.queryByRole('status')).toBeNull();
    cleanup();
    render(<PauseBanner projectId="p1" />);
    expect(await screen.findByRole('status')).toBeInTheDocument();
  });
});
