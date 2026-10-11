// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Tab } from '../lib/types';

vi.mock('../lib/monitor', () => ({ useMonitor: () => ({ tabState: () => undefined }) }));

import { TabBar } from './TabBar';

const tab = (id: string, name: string): Tab => ({ id, name, kind: 'terminal', tmux_session: `th-${id}`, alive: true, machine_id: 'm1' }) as Tab;

function renderBar(over: Partial<Parameters<typeof TabBar>[0]> = {}) {
  const props = {
    tabs: [tab('a', 'Ana'), tab('b', 'Bia')],
    activeId: 'a',
    previewId: 'b',
    onPin: vi.fn(),
    onSelect: vi.fn(),
    onNew: vi.fn(),
    canSimulator: false,
    onRename: vi.fn(),
    onClose: vi.fn(),
    preset: 'single' as const,
    onPreset: vi.fn(),
    onScreen: () => true,
    ...over,
  };
  render(<TabBar {...props} />);
  return props;
}

afterEach(cleanup);

describe('TabBar (TER-904)', () => {
  it('shows the preview tab in italics, the pinned ones upright', () => {
    renderBar();
    expect(screen.getByText('Bia')).toHaveClass('italic');
    expect(screen.getByText('Ana')).not.toHaveClass('italic');
  });

  it('a double click on the preview tab pins it instead of renaming', () => {
    const p = renderBar();
    fireEvent.doubleClick(screen.getByText('Bia'));
    expect(p.onPin).toHaveBeenCalledWith('b');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('a double click on a pinned tab still renames it', () => {
    const p = renderBar();
    fireEvent.doubleClick(screen.getByText('Ana'));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Ana 2' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(p.onRename).toHaveBeenCalledWith('a', 'Ana 2');
    expect(p.onPin).not.toHaveBeenCalled();
  });

  it('the preview tab has a pin button (the touch path), the pinned ones do not', () => {
    const p = renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Fixar aba Bia' }));
    expect(p.onPin).toHaveBeenCalledWith('b');
    expect(p.onSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Fixar aba Ana' })).toBeNull();
  });

  it('the ✕ only asks to close the tab, saying the terminal keeps running', () => {
    const p = renderBar();
    const x = screen.getByRole('button', { name: 'Fechar aba Ana' });
    expect(x).toHaveAttribute('title', expect.stringContaining('o terminal continua rodando'));
    fireEvent.click(x);
    expect(p.onClose).toHaveBeenCalledWith('a');
    expect(p.onSelect).not.toHaveBeenCalled();
  });

  it('without a preview every tab is pinned', () => {
    renderBar({ previewId: null });
    expect(screen.queryByRole('button', { name: /Fixar aba/ })).toBeNull();
    expect(screen.getByText('Bia')).not.toHaveClass('italic');
  });
});
