// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Machine, MonitorItem, Tab } from '../lib/types';

const T1 = '2026-01-01T00:00:00.000Z';
const machine = { id: 'm1', name: 'desktop-linux-escritorio-principal-segundo-andar', type: 'agent' } as Machine;
const tab = { id: 't1', project_id: 'p1', machine_id: 'm1', name: 'terminal', state: 'waiting_permission', state_text: 'Claude quer rodar: npm test', state_tool: 'claude', state_at: T1, state_seen_at: null } as Tab;
const items: MonitorItem[] = [{ tab, project: { id: 'p1', name: 'termhub' } as MonitorItem['project'], machine }];

vi.mock('../lib/monitor', () => ({ useMonitor: () => ({ items, needsYou: items, connected: true, reply: vi.fn() }) }));
const auth = vi.hoisted(() => ({ grants: new Set(['terminals:read', 'terminals:write']) }));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ can: (r: string, a = 'read') => auth.grants.has(`${r}:${a}`) }) }));
vi.mock('../lib/data', () => ({ useData: () => ({ statuses: { m1: 'online' }, machines: [machine] }) }));

import { NeedsYouList } from './NeedsYouList';

afterEach(() => {
  cleanup();
  auth.grants = new Set(['terminals:read', 'terminals:write']);
});

describe('NeedsYouList on a narrow screen', () => {
  const mount = () =>
    render(
      <MemoryRouter>
        <NeedsYouList now={Date.parse(T1) + 120_000} />
      </MemoryRouter>,
    );

  it('puts project › tab on a line of its own below sm, and back inline from sm', () => {
    mount();
    const where = screen.getByTestId('needs-you-where');
    expect(where).toHaveClass('order-last', 'w-full', 'min-w-0', 'sm:order-none', 'sm:w-auto');
    expect(where).toHaveTextContent('termhub› terminal · claude');
  });

  it('lets a long machine name truncate and moves the summary under it below sm', () => {
    mount();
    expect(screen.getByTitle('desktop-linux-escritorio-principal-segundo-andar')).toHaveClass('min-w-0', 'truncate');
    expect(screen.getByTestId('needs-you-summary')).toHaveClass('w-full', 'sm:ml-auto', 'sm:w-auto');
  });

  it('keeps the reply placeholder short and the full hint as the field name', () => {
    mount();
    const field = screen.getByRole('textbox', { name: 'Resposta (ou só Enter para aceitar)' });
    expect(field).toHaveAttribute('placeholder', 'Resposta (Enter aceita)…');
  });
});

// TER-576: replying from the list types into the terminal, which needs terminals:write.
describe('NeedsYouList without terminals:write', () => {
  it('shows the waiting tab but no reply form', () => {
    auth.grants = new Set(['terminals:read', 'terminals:update']);
    render(
      <MemoryRouter>
        <NeedsYouList now={Date.parse(T1) + 120_000} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Claude quer rodar: npm test')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Enviar/ })).not.toBeInTheDocument();
  });
});
