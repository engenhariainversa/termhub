// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../../i18n';
import { formatTokens } from '../../lib/chat-context';
import type { ChatAction } from '../../lib/types';
import { ChatActionCard } from './ChatActionCard';
import { ChatActionGroup } from './ChatActionGroup';
import { ChatContextMeter } from './ChatContextMeter';
import { ChatHost } from './ChatHost';

beforeEach(() => {
  void i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  void i18n.changeLanguage('pt-BR');
});

const action: ChatAction = { id: 'a1', tool: 'send_input', args: { tab_id: 't1', text: 'oi' }, class: 'write', status: 'pending', machine_id: null, project_id: null, tab_id: 't1', summary: 'digitar `oi` na aba Terminal 1', created_at: '' };

describe('chat in English', () => {
  it('a pending confirmation card offers its choices in English, and keeps the summary as written', () => {
    render(<ChatActionCard action={action} deciding={false} onDecide={vi.fn()} />);
    // The summary is content (the concierge wrote it): never translated.
    expect(screen.getByText('digitar `oi` na aba Terminal 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Always allow in this tab' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow with no time limit: keys and text in tabs in this project' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeInTheDocument();
  });

  it('a decided card reads its status in English', () => {
    render(<ChatActionCard action={{ ...action, status: 'executed', grant_id: 'g1' }} deciding={false} onDecide={vi.fn()} />);
    expect(screen.getByText('Executed · trusted tab')).toBeInTheDocument();
  });

  it('a group of pending cards counts with English plurals', () => {
    render(<ChatActionGroup actions={[action, { ...action, id: 'a2' }]} deciding={false} onDecide={vi.fn()} onShowSeparately={vi.fn()} />);
    expect(screen.getByText('2 actions waiting for your confirmation')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve selected (2)' })).toBeInTheDocument();
  });

  it('the context meter abbreviates tokens the English way', () => {
    expect(formatTokens(25_258)).toBe('25K');
    expect(formatTokens(1_000_000)).toBe('1M');
    render(<ChatContextMeter tokens={25_258} window={1_000_000} compacting={false} canCompact onCompact={vi.fn()} />);
    expect(screen.getByRole('meter', { name: 'Conversation context' })).toHaveTextContent('25K / 1M · 3%');
    expect(screen.getByRole('button', { name: 'Compact' })).toBeInTheDocument();
  });

  it('the host line says where the conversation runs in English', () => {
    render(
      <MemoryRouter>
        <ChatHost
          host={{ kind: 'ready', machine: { id: 'm1', name: 'jarvis' }, configDir: null, account: { kind: 'default' }, sessionAtStake: false }}
          machines={null}
          accounts={null}
          accountsError={false}
          accountId={null}
          viewingAs={false}
          picking={false}
          changing={false}
          error={null}
          onPick={vi.fn()}
          onCancelPick={vi.fn()}
          onChoose={vi.fn()}
          onChooseAccount={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('This conversation runs on the machine jarvis, on its default Claude account.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change machine or account' })).toBeInTheDocument();
  });
});
