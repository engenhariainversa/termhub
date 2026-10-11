// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../i18n';
import type { Tab } from '../lib/types';

vi.mock('../lib/monitor', () => ({ useMonitor: () => ({ tabState: () => ({ state: 'waiting_input' }) }) }));

import { TabBar } from './TabBar';
import { PaneLayer } from './PaneLayer';
import { hooksInstallNote, monitorHealthNote } from './MonitorHooksCard';
import { buildingSignText } from '../office/scene/detail';

const tab = (id: string, name: string): Tab => ({ id, name, kind: 'terminal', tmux_session: `th-${id}`, alive: true, machine_id: 'm1' }) as Tab;

beforeEach(() => {
  void i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  void i18n.changeLanguage('pt-BR');
});

describe('terminals area in English', () => {
  it('the tab bar speaks English and keeps tab names and tmux sessions as they are', () => {
    render(
      <TabBar
        tabs={[tab('a', 'Ana')]}
        activeId="a"
        previewId="a"
        onPin={vi.fn()}
        onSelect={vi.fn()}
        onNew={vi.fn()}
        canSimulator
        onRename={vi.fn()}
        onClose={vi.fn()}
        preset="columns"
        onPreset={vi.fn()}
        onScreen={() => true}
      />,
    );
    expect(screen.getByText('Ana')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close tab Ana' })).toHaveAttribute('title', 'Close tab (⌘W) — the terminal keeps running');
    expect(screen.getByRole('button', { name: 'Pin tab Ana' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New tab' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New iOS simulator' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Pane layout' })).toBeInTheDocument();
    expect(screen.getByTitle('Two columns')).toBeInTheDocument();
    expect(screen.getByTitle('tmux session active · waiting for an answer')).toBeInTheDocument();
    expect(screen.getByText('Ana').closest('[title]')).toHaveAttribute('title', expect.stringContaining('Ana — th-a · preview (double-click pins it)'));
  });

  it('an empty pane offers a tab in English', () => {
    render(
      <PaneLayer
        preset="columns"
        rects={[{ x: 0, y: 0, w: 100, h: 100 }]}
        cells={[null]}
        focusedCell={0}
        tabs={[tab('a', 'Ana')]}
        onFocus={vi.fn()}
        onAssign={vi.fn()}
        onClear={vi.fn()}
        onNewTerminal={vi.fn()}
      />,
    );
    expect(screen.getByText('Empty pane')).toBeInTheDocument();
    expect(screen.getByText('Choose a tab')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '+ new terminal' })).toBeInTheDocument();
  });

  it('the monitor notes, with English plurals', () => {
    expect(monitorHealthNote({ tabs: 1, tabs_reporting: 0 }, false).text).toBe('This machine\'s only tab has not reported a state: without the hooks installed, it does not show in “Needs you”.');
    expect(monitorHealthNote({ tabs: 4, tabs_reporting: 2 }, true).text).toBe('2 of 4 tabs reporting their state to the monitor.');
    expect(hooksInstallNote({ claude: 'installed', codex: 'skipped', cursor: 'agent_outdated' })).toBe(
      'Claude Code: ok (~/.claude) · Codex: not found · Cursor CLI: update the agent (0.4.3 or newer). Applies to sessions opened from now on.',
    );
  });

  it('the office building sign', () => {
    expect(buildingSignText({ label: 'alpha', notice: 'silent', progress: { done: 2, total: 5 }, needsYou: 1, desks: [] })).toEqual({
      name: 'alpha',
      detail: 'no answer · 2/5 tasks · no agents right now ·',
      count: '1 needs you',
    });
  });
});
