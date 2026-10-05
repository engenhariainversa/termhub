// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatActionCard } from './ChatActionCard';
import type { ChatAction, ChatGrant, ChatStandingGrant } from '../../lib/types';

afterEach(() => cleanup());

const base: ChatAction = { id: 'a1', tool: 'send_input', args: { tab_id: 't1', text: 'oi' }, class: 'write', status: 'pending', machine_id: null, project_id: null, tab_id: 't1', summary: 'digitar `oi` na aba Terminal 1', created_at: '' };
const grant: ChatGrant = { id: 'g1', tab_id: 't1', tool: 'send_input', source_action_id: 'a1', created_at: '', expires_at: new Date(Date.now() + 3_600_000).toISOString(), tab_name: 'Terminal 1' };
const card = (over: Partial<ChatAction> = {}): ChatAction => ({ ...base, ...over });

it('offers "Permitir sempre nesta aba" on a pending send_input to a tab', () => {
  const onDecide = vi.fn();
  render(<ChatActionCard action={base} deciding={false} onDecide={onDecide} />);
  fireEvent.click(screen.getByRole('button', { name: 'Permitir sempre nesta aba' }));
  expect(onDecide).toHaveBeenCalledWith('a1', 'approve_tab');
});
it.each([
  ['answering a permission', { ...base, args: { tab_id: 't1', text: '1', answering_permission: true } }],
  ['run_command', { ...base, tool: 'run_command', args: { tab_id: 't1', command: 'ls' } }],
  ['no tab', { ...base, tab_id: null, args: { text: 'oi' } }],
])('does not offer it for %s', (_l, action) => {
  render(<ChatActionCard action={action as ChatAction} deciding={false} onDecide={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'Permitir sempre nesta aba' })).toBeNull();
});
it('the card that granted shows until when and revokes', () => {
  const onRevoke = vi.fn();
  render(<ChatActionCard action={{ ...base, status: 'executed' }} deciding={false} onDecide={vi.fn()} grant={grant} onRevoke={onRevoke} />);
  expect(screen.getByText(/^Permitido nesta aba até/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Revogar' }));
  expect(onRevoke).toHaveBeenCalledWith('g1');
});
it('an action run under a grant reads "aba confiada"', () => {
  render(<ChatActionCard action={{ ...base, status: 'executed', grant_id: 'g1' }} deciding={false} onDecide={vi.fn()} />);
  expect(screen.getByText('Executado · aba confiada')).toBeInTheDocument();
});

it('offers "Permitir sempre neste projeto" on a pending board card only', () => {
  const onDecide = vi.fn();
  render(<ChatActionCard action={card({ tool: 'move_task', args: { task_id: 'k1' } })} deciding={false} onDecide={onDecide} />);
  fireEvent.click(screen.getByRole('button', { name: 'Permitir sempre neste projeto' }));
  expect(onDecide).toHaveBeenCalledWith('a1', 'approve_project');
  cleanup();
  render(<ChatActionCard action={card({ tool: 'delete_task', args: { task_id: 'k1' }, class: 'irreversible' })} deciding={false} onDecide={onDecide} />);
  expect(screen.queryByRole('button', { name: 'Permitir sempre neste projeto' })).toBeNull();
});

it('shows the project grant it created, with Revogar', () => {
  render(
    <ChatActionCard
      action={card({ tool: 'move_task', status: 'executed' })}
      projectGrant={{ id: 'pg1', project_id: 'p1', project_name: 'App', source_action_id: 'a1', created_at: 'x', expires_at: new Date(Date.now() + 3_600_000).toISOString() }}
      deciding={false}
      onDecide={vi.fn()}
      onRevoke={vi.fn()}
    />,
  );
  expect(screen.getByText(/Permitido neste projeto até/)).toBeInTheDocument();
});

it('labels a call run under a project grant', () => {
  render(<ChatActionCard action={card({ tool: 'update_task', status: 'executed', grant_id: 'pg1' })} deciding={false} onDecide={vi.fn()} />);
  expect(screen.getByText(/quadro confiado/)).toBeInTheDocument();
});

it('a pending send_key card offers the terminal grants but not the narrow tab one', () => {
  const onDecide = vi.fn();
  render(<ChatActionCard action={card({ tool: 'send_key', args: { tab_id: 't1', key: 'Enter' } })} deciding={false} onDecide={onDecide} />);
  expect(screen.queryByRole('button', { name: 'Permitir sempre nesta aba' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Liberar teclas e shell nesta aba' }));
  expect(onDecide).toHaveBeenCalledWith('a1', 'approve_tab_terminal');
  fireEvent.click(screen.getByRole('button', { name: 'Liberar tudo neste projeto' }));
  expect(onDecide).toHaveBeenCalledWith('a1', 'approve_project_all');
});
it('a pending agent send_input card offers all three grants', () => {
  render(<ChatActionCard action={base} deciding={false} onDecide={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Permitir sempre nesta aba' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Liberar teclas e shell nesta aba' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Liberar tudo neste projeto' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Permitir sempre neste projeto' })).toBeNull();
});
it('a send_input answering a permission offers none of the grants', () => {
  render(<ChatActionCard action={{ ...base, args: { tab_id: 't1', text: '1', answering_permission: true } }} deciding={false} onDecide={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'Permitir sempre nesta aba' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Liberar teclas e shell nesta aba' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Liberar tudo neste projeto' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Permitir sempre neste projeto' })).toBeNull();
});
it('a create_task card offers "tudo" but not the terminal level', () => {
  render(<ChatActionCard action={card({ tool: 'create_task', args: { title: 'x' } })} deciding={false} onDecide={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Permitir sempre neste projeto' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Liberar tudo neste projeto' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Liberar teclas e shell nesta aba' })).toBeNull();
});
it('a run_command card offers no grant at all', () => {
  render(<ChatActionCard action={card({ tool: 'run_command', args: { tab_id: 't1', command: 'ls' } })} deciding={false} onDecide={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'Permitir sempre nesta aba' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Permitir sempre neste projeto' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Liberar teclas e shell nesta aba' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Liberar tudo neste projeto' })).toBeNull();
});
it('a terminal tab grant reads "teclas e shell liberados"', () => {
  render(<ChatActionCard action={{ ...base, status: 'executed' }} deciding={false} onDecide={vi.fn()} grant={{ ...grant, tool: 'terminal' }} onRevoke={vi.fn()} />);
  expect(screen.getByText(/^Teclas e shell liberados nesta aba até/)).toBeInTheDocument();
});
it('a project grant with scope "all" reads "tudo liberado"', () => {
  render(
    <ChatActionCard
      action={card({ tool: 'move_task', status: 'executed' })}
      projectGrant={{ id: 'pg1', project_id: 'p1', project_name: 'App', source_action_id: 'a1', created_at: 'x', expires_at: new Date(Date.now() + 3_600_000).toISOString(), scope: 'all' }}
      deciding={false}
      onDecide={vi.fn()}
      onRevoke={vi.fn()}
    />,
  );
  expect(screen.getByText(/^Tudo liberado neste projeto até/)).toBeInTheDocument();
});

it('names the subagent that proposed the action', () => {
  render(<ChatActionCard action={{ ...base, subagent: { id: 's1', description: 'Buscar CI' } }} deciding={false} onDecide={vi.fn()} />);
  expect(screen.getByText('Pedido pelo subagente «Buscar CI»')).toBeInTheDocument();
});
it('no origin line without a subagent', () => {
  render(<ChatActionCard action={base} deciding={false} onDecide={vi.fn()} />);
  expect(screen.queryByText(/Pedido pelo subagente/)).toBeNull();
});

describe('"Liberar sem prazo" (TER-386)', () => {
  it.each([
    ['open_tab', card({ tool: 'open_tab', args: { project_id: 'p1' }, tab_id: null, project_id: 'p1' }), 'abrir abas'],
    ['close_tab', card({ tool: 'close_tab', args: { tab_id: 't1' }, tab_id: 't1', project_id: 'p1' }), 'fechar abas paradas'],
    ['start_agent', card({ tool: 'start_agent', args: { project_id: 'p1' }, tab_id: null, project_id: 'p1' }), 'iniciar agentes'],
    ['a board tool', card({ tool: 'move_task', args: { task_id: 'k1' }, tab_id: null }), 'mexer no quadro'],
    ['send_key', card({ tool: 'send_key', args: { tab_id: 't1', key: 'Enter' } }), 'teclas e texto nas abas'],
  ])('a pending %s card offers it with its label and sends approve_project_always', (_l, action, label) => {
    const onDecide = vi.fn();
    render(<ChatActionCard action={action} deciding={false} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: `Liberar sem prazo: ${label} neste projeto` }));
    expect(onDecide).toHaveBeenCalledWith('a1', 'approve_project_always');
  });
  it.each([
    ['delete_task', card({ tool: 'delete_task', args: { task_id: 'k1' }, class: 'irreversible', project_id: 'p1' })],
    ['run_command', card({ tool: 'run_command', args: { tab_id: 't1', command: 'ls' } })],
    ['open_tab without a project', card({ tool: 'open_tab', args: {}, tab_id: null, project_id: null })],
    ['a send_input answering a permission', card({ args: { tab_id: 't1', text: '1', answering_permission: true } })],
  ])('is not offered for %s', (_l, action) => {
    render(<ChatActionCard action={action} deciding={false} onDecide={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /^Liberar sem prazo/ })).toBeNull();
  });
  it('is not offered once decided', () => {
    render(<ChatActionCard action={card({ tool: 'close_tab', args: { tab_id: 't1' }, status: 'executed' })} deciding={false} onDecide={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /^Liberar sem prazo/ })).toBeNull();
  });
  it('the card that created a standing grant says so, with Revogar', () => {
    const onRevoke = vi.fn();
    const sg: ChatStandingGrant = { id: 'sg1', project_id: 'p1', project_name: 'App', kind: 'close_tab', source_action_id: 'a1', created_at: 'x' };
    render(<ChatActionCard action={card({ tool: 'close_tab', args: { tab_id: 't1' }, status: 'executed' })} standingGrant={sg} deciding={false} onDecide={vi.fn()} onRevoke={onRevoke} />);
    expect(screen.getByText('Fechar abas paradas liberado neste projeto, sem prazo')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Revogar' }));
    expect(onRevoke).toHaveBeenCalledWith('sg1');
  });
  it.each(['open_tab', 'close_tab', 'start_agent'])('a %s run under a grant reads "liberado no projeto"', (tool) => {
    render(<ChatActionCard action={card({ tool, args: {}, status: 'executed', grant_id: 'sg1' })} deciding={false} onDecide={vi.fn()} />);
    expect(screen.getByText('Executado · liberado no projeto')).toBeInTheDocument();
  });
  it.each([
    ['open_tab', 'default:open_tab:u1'],
    ['send_key', 'default:terminal:u1'],
    ['move_task', 'default:board:u1'],
  ])('a %s run under a default allowance reads "liberado por padrão" (TER-627)', (tool, grant_id) => {
    render(<ChatActionCard action={card({ tool, args: { tab_id: 't1', key: 'Enter' }, status: 'executed', grant_id })} deciding={false} onDecide={vi.fn()} />);
    expect(screen.getByText('Executado · liberado por padrão')).toBeInTheDocument();
  });
  it('a send_key run under a grant still reads "aba confiada"', () => {
    render(<ChatActionCard action={card({ tool: 'send_key', args: { tab_id: 't1', key: 'Enter' }, status: 'executed', grant_id: 'sg1' })} deciding={false} onDecide={vi.fn()} />);
    expect(screen.getByText('Executado · aba confiada')).toBeInTheDocument();
  });
});

describe('an expired or stale card (TER-477)', () => {
  it.each([
    [{ status: 'expired' as const, error_code: null }, 'Expirou sem resposta'],
    [{ status: 'failed' as const, error_code: 'TAB_GONE' }, 'Expirou: a aba foi fechada'],
    [{ status: 'failed' as const, error_code: 'WAITING_PERMISSION' }, 'Expirou: a aba passou a pedir uma permissão'],
    [{ status: 'failed' as const, error_code: 'PROMPT_CHANGED' }, 'Expirou: a aba está pedindo outra permissão'],
  ])('%o reads %s and offers Propor de novo', (over, label) => {
    const onRepropose = vi.fn();
    render(<ChatActionCard action={card(over)} deciding={false} onDecide={vi.fn()} onRepropose={onRepropose} />);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByRole('listitem')).not.toHaveClass('border-attention/40');
    fireEvent.click(screen.getByRole('button', { name: 'Propor de novo' }));
    expect(onRepropose).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1', summary: base.summary }));
  });

  it('any other failure keeps "Falhou" and offers nothing', () => {
    render(<ChatActionCard action={card({ status: 'failed', error_code: 'MACHINE_OFFLINE' })} deciding={false} onDecide={vi.fn()} onRepropose={vi.fn()} />);
    expect(screen.getByText('Falhou')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Propor de novo' })).toBeNull();
  });

  it('carries its id for the pending bar to find it', () => {
    render(<ChatActionCard action={base} deciding={false} onDecide={vi.fn()} />);
    expect(screen.getByRole('listitem')).toHaveAttribute('data-chat-card', 'a1');
  });
});

// TER-641: a send the concierge made on a precedent from memory, without a click.
describe('"Decisão automática" (TER-641)', () => {
  const auto = { reason: 'Mesma pergunta de ontem', sources: [{ ref: 'decision:d1', question: 'Rodo os testes?', answer: 'Sim' }, { ref: 'task:tk1', question: null, answer: null }] };
  it('shows the badge beside "liberado por padrão", and its detail on click', () => {
    render(<ChatActionCard action={card({ status: 'executed', grant_id: 'default:terminal:u1', auto_decision: auto })} deciding={false} onDecide={vi.fn()} />);
    expect(screen.getByText('Executado · liberado por padrão')).toBeInTheDocument();
    const badge = screen.getByRole('button', { name: 'Decisão automática' });
    expect(badge).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Motivo: Mesma pergunta de ontem')).toBeNull();
    fireEvent.click(badge);
    expect(badge).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Motivo: Mesma pergunta de ontem')).toBeInTheDocument();
    expect(screen.getByText(/«Rodo os testes\?» → Sim/)).toBeInTheDocument();
    expect(screen.getByText('(decision:d1)')).toBeInTheDocument();
    expect(screen.getByText('(task:tk1)')).toBeInTheDocument();
  });
  it.each([
    ['pending', card({ auto_decision: auto })],
    ['approved by hand', card({ status: 'executed', grant_id: null, auto_decision: auto })],
    ['with no precedent', card({ status: 'executed', grant_id: 'g1', auto_decision: null })],
    ['from an older server', card({ status: 'executed', grant_id: 'g1' })],
  ])('no badge on a card %s', (_l, action) => {
    render(<ChatActionCard action={action} deciding={false} onDecide={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Decisão automática' })).toBeNull();
  });
});

describe('a call that ran under a grant reads as one line (TER-984)', () => {
  const ran = card({ summary: 'digitar `Mensagem do Pedro\nsegunda linha comprida` na aba App', status: 'executed', grant_id: 'g1' });

  it('shows the first line of what it did and how it ended, and hides the rest until expanded', () => {
    const { container } = render(<ChatActionCard action={ran} deciding={false} onDecide={vi.fn()} />);
    expect(container.querySelector('[data-compact]')).not.toBeNull();
    expect(screen.getByText('digitar `Mensagem do Pedro')).toBeInTheDocument();
    expect(screen.getByText('Executado · aba confiada')).toBeInTheDocument();
    expect(screen.queryByText(/segunda linha comprida/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Ver detalhes' }));
    expect(container.querySelector('[data-compact]')).toBeNull();
    expect(screen.getByText(/segunda linha comprida/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Recolher' }));
    expect(container.querySelector('[data-compact]')).not.toBeNull();
  });

  it('marks a failed call with ✗', () => {
    render(<ChatActionCard action={{ ...ran, status: 'failed', error_code: 'MACHINE_OFFLINE' }} deciding={false} onDecide={vi.fn()} />);
    expect(screen.getByText('✗')).toBeInTheDocument();
    expect(screen.getByText('Falhou · aba confiada')).toBeInTheDocument();
  });

  it.each([
    ['a pending card', card({ status: 'pending' })],
    ['a card decided by a click', card({ status: 'executed', grant_id: null })],
    ['a stale granted card', card({ status: 'failed', grant_id: 'g1', error_code: 'TAB_GONE' })],
  ])('keeps %s in its full form', (_label, action) => {
    const { container } = render(<ChatActionCard action={action} deciding={false} onDecide={vi.fn()} />);
    expect(container.querySelector('[data-compact]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ver detalhes' })).toBeNull();
  });
});
