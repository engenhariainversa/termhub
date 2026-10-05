// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SimulatorHandlers } from '../lib/simulator-connection';
import type { Tab } from '../lib/types';

// TER-576: tapping, typing and the device buttons take terminals:write; watching the stream does not.

const h = vi.hoisted(() => ({
  grants: new Set<string>(),
  conns: [] as Array<{ handlers: SimulatorHandlers; writable: boolean[] }>,
}));

vi.mock('../lib/simulator-connection', () => ({
  SimulatorConnection: class {
    writable: boolean[] = [];
    constructor(
      _tabId: string,
      public handlers: SimulatorHandlers,
    ) {
      h.conns.push(this);
    }
    setWritable(w: boolean) {
      this.writable.push(w);
    }
    connect() {}
    send() {}
    retryNow() {}
    close() {}
  },
}));
vi.mock('../lib/api', () => ({
  ApiError: class extends Error {},
  api: { machines: { simulators: () => new Promise(() => {}) }, tabs: { screenshotUrl: () => '/shot', update: vi.fn() } },
}));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ can: (r: string, a = 'read') => h.grants.has(`${r}:${a}`) }) }));
// SimulatorView only borrows the shortcut check: skip loading xterm.js
vi.mock('./Terminal', () => ({ isAppShortcut: () => false }));
vi.mock('./DropdownMenu', () => ({
  DropdownMenu: ({ items }: { items: Array<{ kind: string; label?: string; disabled?: boolean }> }) => (
    <div>
      {items
        .filter((i) => i.kind === 'item')
        .map((i) => (
          <button key={i.label} disabled={i.disabled}>
            {i.label}
          </button>
        ))}
    </div>
  ),
}));

import { SimulatorView } from './SimulatorView';

const tab = { id: 't1', simulator_udid: 'U1' } as Tab;

beforeEach(() => {
  h.conns = [];
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
});
afterEach(cleanup);

function mountReady() {
  render(<SimulatorView tab={tab} machineId="m1" active onTabChange={() => {}} />);
  act(() => h.conns[0].handlers.onStatus('ready'));
}

describe('SimulatorView and terminals:write', () => {
  it('a writer gets the device buttons and no badge', () => {
    h.grants = new Set(['terminals:read', 'terminals:write']);
    mountReady();
    expect(h.conns[0].writable.at(-1)).toBe(true);
    for (const label of ['Home', 'Bloquear', 'Girar']) expect(screen.getByRole('button', { name: label })).toBeEnabled();
    expect(screen.queryByText('Somente leitura')).not.toBeInTheDocument();
  });

  it('a reader watches: the connection stops acting, the device buttons are off, a badge says why', () => {
    h.grants = new Set(['terminals:read', 'terminals:update']);
    mountReady();
    expect(h.conns[0].writable.at(-1)).toBe(false);
    for (const label of ['Home', 'Bloquear', 'Girar']) expect(screen.getByRole('button', { name: label })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Screenshot' })).toBeEnabled(); // looking is fine
    expect(screen.getByText('Somente leitura')).toBeInTheDocument();
  });
});
