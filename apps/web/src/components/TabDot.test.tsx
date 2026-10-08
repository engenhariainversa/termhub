// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { i18n } from '../i18n';
import type { Tab } from '../lib/types';
import { TabDot } from './TabDot';

const T1 = '2026-10-08T10:00:00.000Z';
type DotTab = Pick<Tab, 'state' | 'state_at' | 'state_seen_at'>;
const st = (state: Tab['state'], o: Partial<DotTab> = {}): DotTab => ({ state, state_at: T1, state_seen_at: null, ...o });

function dot(props: Parameters<typeof TabDot>[0]) {
  const { container } = render(<TabDot {...props} />);
  return { dot: container.querySelector('[data-dot]')!, ring: container.querySelector('[data-auto-ring]') };
}

afterEach(cleanup);

describe('TabDot (TER-1044)', () => {
  it('pulses in the working colour while the tab works, its background work included', () => {
    for (const state of ['working', 'waiting_background'] as const) {
      const { dot: d } = dot({ alive: true, tab: st(state) });
      expect(d).toHaveClass('bg-accent', 'tab-dot-working');
      cleanup();
    }
  });

  it('blinks slowly in the attention colour while the tab waits for the person, unseen', () => {
    for (const state of ['waiting_input', 'waiting_permission'] as const) {
      const { dot: d } = dot({ alive: true, tab: st(state) });
      expect(d).toHaveClass('bg-attention', 'tab-dot-blink');
      expect(d).not.toHaveClass('tab-dot-working');
      expect(screen.getByLabelText('esperando você')).toBeInTheDocument();
      cleanup();
    }
  });

  it('stands still once the tab finished, stopped or died', () => {
    const done = dot({ alive: true, tab: st('finished') }).dot;
    expect(done.getAttribute('data-icon')).toBe('check');
    expect(done.getAttribute('class')).not.toMatch(/tab-dot-/);
    cleanup();
    expect(dot({ alive: true, tab: st('idle') }).dot.className).not.toMatch(/tab-dot-/);
    cleanup();
    const dead = dot({ alive: false, tab: st('working') }).dot;
    expect(dead).toHaveClass('bg-fg-dim');
    expect(dead.className).not.toMatch(/tab-dot-/);
  });

  it('has no ring on a manual tab', () => {
    expect(dot({ alive: true, tab: st('working'), title: 'trabalhando' }).ring).toBeNull();
    expect(screen.getByTitle('trabalhando')).toBeInTheDocument();
  });

  it('rings a tab an automatic run works in, turning only while it works, and names the card', () => {
    const { ring } = dot({ alive: true, tab: st('working'), autoRef: 'TER-123', title: 'trabalhando' });
    expect(ring).toHaveClass('tab-dot-ring');
    expect(screen.getByRole('img', { name: 'trabalhando (automático, TER-123)' })).toHaveAttribute('title', 'trabalhando (automático, TER-123)');
    cleanup();
    expect(dot({ alive: true, tab: st('waiting_permission'), autoRef: 'TER-123' }).ring).not.toHaveClass('tab-dot-ring');
    cleanup();
    expect(dot({ alive: true, tab: null, autoRef: 'TER-9' }).ring).toBeInTheDocument();
    expect(screen.getByTitle('automático, TER-9')).toBeInTheDocument();
  });

  it('says it in English too', async () => {
    await i18n.changeLanguage('en');
    try {
      dot({ alive: true, tab: st('working'), autoRef: 'TER-123', title: 'working' });
      expect(screen.getByTitle('working (automatic, TER-123)')).toBeInTheDocument();
    } finally {
      await i18n.changeLanguage('pt-BR');
    }
  });
});
