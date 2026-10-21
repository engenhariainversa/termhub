// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TabAgentOptions } from '../../lib/types';

const agentOptions = vi.fn();
const startAgent = vi.fn();

vi.mock('../../lib/api', () => ({
  api: { tabChat: { agentOptions: (...a: unknown[]) => agentOptions(...a), startAgent: (...a: unknown[]) => startAgent(...a) } },
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

const { ApiError } = await import('../../lib/api');
import { TabChatStartAgent } from './TabChatStartAgent';

const claude = { account_id: 'a1', label: 'Pessoal', provider: 'claude', model: 'opus' };
const codex = { account_id: 'a2', label: 'Trabalho', provider: 'chatgpt', model: null };
const options = (o: TabAgentOptions) => agentOptions.mockResolvedValue(o);

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('TabChatStartAgent (TER-1094, TER-1104)', () => {
  it("starts the suggested account without naming it, then says the session is starting", async () => {
    options({ choices: [claude, codex], suggested: 'a1' });
    startAgent.mockResolvedValue({ tab_id: 't1', new_tab: false, account: { id: 'a1', label: 'Pessoal' }, provider: 'claude', model: 'opus' });
    const onStarted = vi.fn();
    render(<TabChatStartAgent tabId="t1" onStarted={onStarted} />);
    expect(screen.getByText('Esta aba é um terminal sem agente')).toBeTruthy();
    expect(await screen.findByText('Com Pessoal (Claude Code) · modelo opus')).toBeTruthy();
    fireEvent.click(await screen.findByTestId('tab-chat-start-agent'));
    await waitFor(() => expect(screen.getByText('Sessão iniciada. A conversa aparece aqui assim que o agente responder.')).toBeTruthy());
    // TER-1104: says with what it started
    expect(screen.getByTestId('tab-chat-started-with').textContent).toBe('Iniciado com Claude Code · conta Pessoal · modelo opus');
    expect(onStarted).toHaveBeenCalledWith({ provider: 'claude', account: 'Pessoal', model: 'opus' });
    expect(startAgent).toHaveBeenCalledWith('t1', undefined);
    expect(agentOptions).toHaveBeenCalledWith('t1');
  });

  it('"Escolher outra conta" shows the other accounts, each starting with its own id', async () => {
    options({ choices: [claude, codex], suggested: 'a1' });
    startAgent.mockResolvedValue({ tab_id: 't1', new_tab: false, account: { id: 'a2', label: 'Trabalho' }, provider: 'chatgpt' });
    render(<TabChatStartAgent tabId="t1" />);
    fireEvent.click(await screen.findByText('Escolher outra conta'));
    fireEvent.click(screen.getByTestId('tab-chat-start-agent-a2'));
    await waitFor(() => expect(startAgent).toHaveBeenCalledWith('t1', 'a2'));
  });

  it('with no suggestion (Claude and Codex, no rule) asks first: a picker on the project CLI, starting nothing until pressed', async () => {
    const claude2 = { account_id: 'a3', label: 'Outra', provider: 'claude', model: 'opus' };
    options({ choices: [claude, claude2, codex], suggested: null, provider: 'claude' });
    startAgent.mockResolvedValue({ tab_id: 't1', new_tab: false, account: { id: 'a2', label: 'Trabalho' }, provider: 'chatgpt', model: null });
    render(<TabChatStartAgent tabId="t1" />);
    await screen.findByTestId('tab-chat-choose-agent');
    expect(screen.queryByTestId('tab-chat-start-agent')).toBeNull();
    expect(startAgent).not.toHaveBeenCalled();
    expect(screen.getByTestId('tab-chat-cli-claude').getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByTestId('tab-chat-account') as HTMLSelectElement).value).toBe('a1');
    expect(screen.getByText('Modelo: opus')).toBeTruthy();
    fireEvent.change(screen.getByTestId('tab-chat-account'), { target: { value: 'a3' } });
    expect((screen.getByTestId('tab-chat-account') as HTMLSelectElement).value).toBe('a3');
    fireEvent.click(screen.getByTestId('tab-chat-cli-chatgpt'));
    expect(screen.queryByTestId('tab-chat-account')).toBeNull();
    expect(screen.getByText('Conta Trabalho')).toBeTruthy();
    expect(screen.getByText('Modelo: padrão do CLI')).toBeTruthy();
    fireEvent.click(screen.getByTestId('tab-chat-start-chosen'));
    await waitFor(() => expect(startAgent).toHaveBeenCalledWith('t1', 'a2'));
    expect((await screen.findByTestId('tab-chat-started-with')).textContent).toBe('Iniciado com Codex · conta Trabalho · modelo padrão do CLI');
  });

  it('a machine without accounts says where to add one; a refusal shows its message', async () => {
    options({ choices: [], suggested: null });
    render(<TabChatStartAgent tabId="t1" />);
    expect(await screen.findByText('Nenhuma conta de IA nesta máquina pode iniciar um agente. Cadastre uma em Contas de IA.')).toBeTruthy();
    cleanup();
    options({ choices: [claude], suggested: 'a1' });
    startAgent.mockRejectedValue(new ApiError(503, 'Máquina offline', 'MACHINE_OFFLINE'));
    render(<TabChatStartAgent tabId="t1" />);
    fireEvent.click(await screen.findByTestId('tab-chat-start-agent'));
    expect((await screen.findByRole('alert')).textContent).toBe('Máquina offline');
  });

  it('an agent started in a new tab (the pane was busy) opens that tab', async () => {
    options({ choices: [claude], suggested: 'a1' });
    startAgent.mockResolvedValue({ tab_id: 't9', new_tab: true, account: { id: 'a1', label: 'Pessoal' }, provider: 'claude' });
    const onOpenOtherTab = vi.fn();
    render(<TabChatStartAgent tabId="t1" onOpenOtherTab={onOpenOtherTab} />);
    fireEvent.click(await screen.findByTestId('tab-chat-start-agent'));
    await waitFor(() => expect(onOpenOtherTab).toHaveBeenCalledWith('t9'));
  });
});
