import { fireEvent, render, screen } from '@testing-library/react-native';
import { setLocale } from '@/i18n';
import type { ChatAction } from '../model/types';
import { ActionCard } from './action-card';

const BASE_ACTION: ChatAction = {
  id: 'a1',
  tool: 'move_task',
  args: {},
  class: 'write',
  status: 'pending',
  machine_id: null,
  project_id: 'p-termhub',
  tab_id: null,
  grant_id: null,
  summary: 'mover a tarefa TER-12 "Revisar o login" do projeto termhub',
  created_at: new Date().toISOString(),
};

describe('ActionCard: "Permitir sempre neste projeto" (board grant, design spec 2026-09-26 §7)', () => {
  it('shows the button for a pending move_task and calls onDecide(id, approve_project)', async () => {
    const onDecide = jest.fn();
    await render(<ActionCard action={BASE_ACTION} busy={false} onDecide={onDecide} revoking={false} onRevoke={jest.fn()} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Permitir sempre neste projeto' }));
    expect(onDecide).toHaveBeenCalledWith('a1', 'approve_project');
  });

  it('does not offer it for a tool outside the board set', async () => {
    await render(<ActionCard action={{ ...BASE_ACTION, tool: 'send_input', tab_id: 't-api' }} busy={false} onDecide={jest.fn()} revoking={false} onRevoke={jest.fn()} />);
    expect(screen.queryByRole('button', { name: 'Permitir sempre neste projeto' })).toBeNull();
  });

  it('labels a call run under a project grant "executada · quadro confiado"', async () => {
    await render(<ActionCard action={{ ...BASE_ACTION, status: 'executed', grant_id: 'g1' }} busy={false} onDecide={jest.fn()} revoking={false} onRevoke={jest.fn()} />);
    expect(screen.getByText('executada · quadro confiado')).toBeTruthy();
  });

  it('shows the active project grant with "Permitido neste projeto até HH:MM" and revokes it', async () => {
    const projectGrant = { id: 'pg1', project_id: 'p-termhub', project_name: 'termhub', source_action_id: 'a1', created_at: new Date().toISOString(), expires_at: '2099-01-01T00:00:00.000Z', scope: 'board' as const };
    const onRevoke = jest.fn();
    await render(<ActionCard action={{ ...BASE_ACTION, status: 'executed', grant_id: 'g1' }} busy={false} onDecide={jest.fn()} projectGrant={projectGrant} revoking={false} onRevoke={onRevoke} />);
    expect(screen.getByText(/^Permitido neste projeto/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Revogar' }));
    expect(onRevoke).toHaveBeenCalledWith('pg1');
  });
});

describe('ActionCard: "Liberar teclas e shell nesta aba" / "Liberar tudo neste projeto" (TER-325)', () => {
  const SEND_KEY: ChatAction = { ...BASE_ACTION, tool: 'send_key', args: { tab_id: 't-api', key: '1' }, tab_id: 't-api' };

  it('offers both wider grants on a pending send_key to a tab, with their own decision words', async () => {
    const onDecide = jest.fn();
    await render(<ActionCard action={SEND_KEY} busy={false} onDecide={onDecide} revoking={false} onRevoke={jest.fn()} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Liberar teclas e shell nesta aba' }));
    expect(onDecide).toHaveBeenLastCalledWith('a1', 'approve_tab_terminal');
    await fireEvent.press(screen.getByRole('button', { name: 'Liberar tudo neste projeto' }));
    expect(onDecide).toHaveBeenLastCalledWith('a1', 'approve_project_all');
    // send_key has no narrow tab grant, and is not a board tool.
    expect(screen.queryByRole('button', { name: 'Permitir sempre nesta aba' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Permitir sempre neste projeto' })).toBeNull();
  });

  it('offers both beside "Permitir sempre nesta aba" on a send_input to a tab', async () => {
    await render(<ActionCard action={{ ...SEND_KEY, tool: 'send_input', args: { tab_id: 't-api', text: 'npm test' } }} busy={false} onDecide={jest.fn()} revoking={false} onRevoke={jest.fn()} />);
    expect(screen.getByRole('button', { name: 'Permitir sempre nesta aba' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Liberar teclas e shell nesta aba' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Liberar tudo neste projeto' })).toBeTruthy();
  });

  it('offers neither on a send_input answering a permission dialog', async () => {
    await render(
      <ActionCard action={{ ...SEND_KEY, tool: 'send_input', args: { tab_id: 't-api', text: '1', answering_permission: true } }} busy={false} onDecide={jest.fn()} revoking={false} onRevoke={jest.fn()} />,
    );
    expect(screen.queryByRole('button', { name: 'Liberar teclas e shell nesta aba' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Liberar tudo neste projeto' })).toBeNull();
  });

  it('offers only "Liberar tudo neste projeto" on a board card, and neither on run_command', async () => {
    await render(<ActionCard action={BASE_ACTION} busy={false} onDecide={jest.fn()} revoking={false} onRevoke={jest.fn()} />);
    expect(screen.queryByRole('button', { name: 'Liberar teclas e shell nesta aba' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Liberar tudo neste projeto' })).toBeTruthy();
    await render(<ActionCard action={{ ...BASE_ACTION, tool: 'run_command', args: { command: 'ls' }, tab_id: null }} busy={false} onDecide={jest.fn()} revoking={false} onRevoke={jest.fn()} />);
    expect(screen.queryByRole('button', { name: 'Liberar teclas e shell nesta aba' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Liberar tudo neste projeto' })).toBeNull();
  });

  it('shows a terminal tab grant as "Teclas e shell liberados nesta aba até HH:MM", a narrow one as "Permitido até HH:MM"', async () => {
    const grant = { id: 'g1', tab_id: 't-api', tool: 'terminal', source_action_id: 'a1', created_at: new Date().toISOString(), expires_at: '2099-01-01T00:00:00.000Z', tab_name: 'api' };
    const executed = { ...SEND_KEY, status: 'executed' as const };
    await render(<ActionCard action={executed} busy={false} onDecide={jest.fn()} grant={grant} revoking={false} onRevoke={jest.fn()} />);
    expect(screen.getByText(/^Teclas e shell liberados nesta aba até/)).toBeTruthy();
    await render(<ActionCard action={executed} busy={false} onDecide={jest.fn()} grant={{ ...grant, tool: 'send_input' }} revoking={false} onRevoke={jest.fn()} />);
    expect(screen.getByText(/^Permitido até/)).toBeTruthy();
  });

  it('shows an "all" project grant as "Tudo liberado neste projeto até HH:MM"', async () => {
    const projectGrant = { id: 'pg1', project_id: 'p-termhub', project_name: 'termhub', source_action_id: 'a1', created_at: new Date().toISOString(), expires_at: '2099-01-01T00:00:00.000Z', scope: 'all' as const };
    await render(<ActionCard action={{ ...SEND_KEY, status: 'executed' }} busy={false} onDecide={jest.fn()} projectGrant={projectGrant} revoking={false} onRevoke={jest.fn()} />);
    expect(screen.getByText(/^Tudo liberado neste projeto até/)).toBeTruthy();
  });
});

describe('ActionCard: "Liberar sem prazo" (standing grant, TER-386)', () => {
  const card = (patch: Partial<ChatAction>): ChatAction => ({ ...BASE_ACTION, ...patch });

  it.each([
    ['a board card', card({}), 'mexer no quadro'],
    ['open_tab with a project', card({ tool: 'open_tab', args: { project_id: 'p-termhub' } }), 'abrir abas'],
    ['close_tab on a tab', card({ tool: 'close_tab', args: { tab_id: 't-api' }, tab_id: 't-api', project_id: null }), 'fechar abas paradas'],
    ['start_agent with a project', card({ tool: 'start_agent', args: {} }), 'iniciar agentes'],
    ['send_key to a tab', card({ tool: 'send_key', args: { tab_id: 't-api', key: '1' }, tab_id: 't-api', project_id: null }), 'teclas e texto nas abas'],
  ])('offers it on %s, with the approve_project_always word', async (_label, action, label) => {
    const onDecide = jest.fn();
    await render(<ActionCard action={action} busy={false} onDecide={onDecide} revoking={false} onRevoke={jest.fn()} />);
    await fireEvent.press(screen.getByRole('button', { name: `Liberar sem prazo: ${label} neste projeto` }));
    expect(onDecide).toHaveBeenCalledWith('a1', 'approve_project_always');
  });

  it('does not offer it on run_command, open_tab without a project, or a send_input answering a permission', async () => {
    for (const action of [
      card({ tool: 'run_command', args: { command: 'ls' } }),
      card({ tool: 'open_tab', args: {}, project_id: null }),
      card({ tool: 'send_input', args: { tab_id: 't-api', text: '1', answering_permission: true }, tab_id: 't-api' }),
    ]) {
      await render(<ActionCard action={action} busy={false} onDecide={jest.fn()} revoking={false} onRevoke={jest.fn()} />);
      expect(screen.queryByRole('button', { name: /^Liberar sem prazo/ })).toBeNull();
    }
  });

  it('shows the standing grant this card created, "sem prazo", with Revogar', async () => {
    const standingGrant = { id: 'sg1', project_id: 'p-termhub', project_name: 'termhub', kind: 'close_tab' as const, source_action_id: 'a1', created_at: new Date().toISOString() };
    const onRevoke = jest.fn();
    await render(<ActionCard action={card({ tool: 'close_tab', tab_id: 't-api', status: 'executed' })} busy={false} onDecide={jest.fn()} standingGrant={standingGrant} revoking={false} onRevoke={onRevoke} />);
    expect(screen.getByText('Fechar abas paradas liberado neste projeto, sem prazo')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Revogar' }));
    expect(onRevoke).toHaveBeenCalledWith('sg1');
  });

  it('labels a tab-lifecycle call run under a grant "· liberado no projeto"; board and terminal keep theirs', async () => {
    for (const tool of ['open_tab', 'close_tab', 'start_agent']) {
      await render(<ActionCard action={card({ tool, status: 'executed', grant_id: 'sg1' })} busy={false} onDecide={jest.fn()} revoking={false} onRevoke={jest.fn()} />);
      expect(screen.getByText('executada · liberado no projeto')).toBeTruthy();
    }
    await render(<ActionCard action={card({ status: 'executed', grant_id: 'sg1' })} busy={false} onDecide={jest.fn()} revoking={false} onRevoke={jest.fn()} />);
    expect(screen.getByText('executada · quadro confiado')).toBeTruthy();
    await render(<ActionCard action={card({ tool: 'send_key', tab_id: 't-api', status: 'executed', grant_id: 'sg1' })} busy={false} onDecide={jest.fn()} revoking={false} onRevoke={jest.fn()} />);
    expect(screen.getByText('executada · aba confiada')).toBeTruthy();
  });

  it('labels a call run under a default allowance "· liberado por padrão" (TER-627)', async () => {
    await render(<ActionCard action={card({ tool: 'send_key', tab_id: 't-api', status: 'executed', grant_id: 'default:terminal:u1' })} busy={false} onDecide={jest.fn()} revoking={false} onRevoke={jest.fn()} />);
    expect(screen.getByText('executada · liberado por padrão')).toBeTruthy();
  });
});

// A confirmation that went stale or expired (spec 2026-09-30 §2.3): it says so, and offers to ask the
// concierge for a fresh card.
describe('ActionCard: expired or stale (TER-477)', () => {
  const renderCard = (patch: Partial<ChatAction>, onRepropose = jest.fn()) =>
    render(<ActionCard action={{ ...BASE_ACTION, ...patch }} busy={false} onDecide={jest.fn()} revoking={false} onRevoke={jest.fn()} onRepropose={onRepropose} />);

  it.each([
    [{ status: 'expired' as const }, 'expirou sem resposta'],
    [{ status: 'expired' as const, error_code: null }, 'expirou sem resposta'],
    [{ status: 'failed' as const, error_code: 'TAB_GONE' }, 'expirou: a aba foi fechada'],
    [{ status: 'failed' as const, error_code: 'WAITING_PERMISSION' }, 'expirou: a aba passou a pedir uma permissão'],
    [{ status: 'failed' as const, error_code: 'PROMPT_CHANGED' }, 'expirou: a aba está pedindo outra permissão'],
  ])('%o reads "%s" with a muted border and "Propor de novo"', async (patch, label) => {
    const onRepropose = jest.fn();
    await renderCard(patch, onRepropose);
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByTestId('action-card-a1').props.className).toContain('border-app-border');
    await fireEvent.press(screen.getByRole('button', { name: 'Propor de novo' }));
    expect(onRepropose).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1', summary: BASE_ACTION.summary }));
  });

  it.each([
    [{ status: 'failed' as const, error_code: 'MACHINE_OFFLINE' }],
    [{ status: 'failed' as const }],
  ])('any other failure keeps "falhou", the accent border and no "Propor de novo" (%o)', async (patch) => {
    await renderCard(patch);
    expect(screen.getByText('falhou')).toBeTruthy();
    expect(screen.getByTestId('action-card-a1').props.className).toContain('border-app-accent');
    expect(screen.queryByRole('button', { name: 'Propor de novo' })).toBeNull();
  });
});

// TER-641: a send the concierge made on a precedent from memory, without a click.
describe('ActionCard: "Decisão automática" (TER-641)', () => {
  const auto = { reason: 'Mesma pergunta de ontem', sources: [{ ref: 'decision:d1', question: 'Rodo os testes?', answer: 'Sim' }, { ref: 'task:tk1', question: null, answer: null }] };
  const card = (patch: Partial<ChatAction>): ChatAction => ({ ...BASE_ACTION, tool: 'send_input', tab_id: 't-api', ...patch });

  it('shows the badge beside "liberado por padrão", and the decision on tap', async () => {
    await render(<ActionCard action={card({ status: 'executed', grant_id: 'default:terminal:u1', auto_decision: auto })} busy={false} onDecide={jest.fn()} revoking={false} onRevoke={jest.fn()} />);
    expect(screen.getByText('executada · liberado por padrão')).toBeTruthy();
    expect(screen.queryByText('Motivo: Mesma pergunta de ontem')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Decisão automática' }));
    expect(screen.getByText('Motivo: Mesma pergunta de ontem')).toBeTruthy();
    expect(screen.getByText('• «Rodo os testes?» → Sim (decision:d1)')).toBeTruthy();
    expect(screen.getByText('• task:tk1 (task:tk1)')).toBeTruthy();
  });

  it('no badge while pending, after a manual approval, or from an older server', async () => {
    for (const patch of [{ auto_decision: auto }, { status: 'executed' as const, grant_id: null, auto_decision: auto }, { status: 'executed' as const, grant_id: 'g1' }]) {
      await render(<ActionCard action={card(patch)} busy={false} onDecide={jest.fn()} revoking={false} onRevoke={jest.fn()} />);
      expect(screen.queryByRole('button', { name: 'Decisão automática' })).toBeNull();
    }
  });
});

describe('ActionCard in English (i18n)', () => {
  beforeEach(() => setLocale('en'));
  afterEach(() => setLocale(null));

  it('shows the pending card, its buttons and the standing offer in English', async () => {
    const SEND_INPUT: ChatAction = { ...BASE_ACTION, tool: 'send_input', args: { tab_id: 't-api', text: 'npm test' }, tab_id: 't-api' };
    await render(<ActionCard action={SEND_INPUT} busy={false} onDecide={jest.fn()} revoking={false} onRevoke={jest.fn()} />);
    expect(screen.getByText('Confirmation request')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Always allow in this tab' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Always allow keys and text in tabs in this project' })).toBeTruthy();
    // The server-composed summary is never translated by the app.
    expect(screen.getByText(BASE_ACTION.summary)).toBeTruthy();
  });

  it('says how a granted call ended, and why an expired one did', async () => {
    await render(<ActionCard action={{ ...BASE_ACTION, status: 'executed', grant_id: 'g1' }} busy={false} onDecide={jest.fn()} revoking={false} onRevoke={jest.fn()} />);
    expect(screen.getByText('done · board trusted')).toBeTruthy();
    await render(<ActionCard action={{ ...BASE_ACTION, status: 'expired' }} busy={false} onDecide={jest.fn()} revoking={false} onRevoke={jest.fn()} onRepropose={jest.fn()} />);
    expect(screen.getByText('expired without an answer')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Propose again' })).toBeTruthy();
  });
});
