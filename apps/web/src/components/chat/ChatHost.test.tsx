// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatHost } from './ChatHost';
import type { ChatHostMachine, ChatHostState } from '../../lib/types';

const machine = (id: string, name: string): ChatHostMachine => ({ id, name });

/** Every prop the page owns, defaulted, so each test names only the one it is about. */
function show(host: ChatHostState, over: Partial<Parameters<typeof ChatHost>[0]> = {}) {
  const props = {
    host,
    machines: null,
    accounts: null,
    accountsError: false,
    accountId: null,
    viewingAs: false,
    picking: false,
    changing: false,
    error: null,
    onPick: vi.fn(),
    onCancelPick: vi.fn(),
    onChoose: vi.fn(),
    onChooseAccount: vi.fn(),
    ...over,
  };
  render(
    <MemoryRouter>
      <ChatHost {...props} />
    </MemoryRouter>,
  );
  return props;
}

afterEach(() => cleanup());

it('names the machine and the account running the conversation', async () => {
  show({ kind: 'ready', machine: machine('m1', 'jarvis'), configDir: '/home/u/.claude-work', account: { kind: 'chosen', id: 'acc1', label: 'trabalho' }, sessionAtStake: false });

  // Nobody should have to guess whose computer is thinking, or on whose Claude account.
  expect(screen.getByText(/máquina jarvis/i)).toBeTruthy();
  expect(screen.getByText(/conta trabalho/i)).toBeTruthy();
});

it('says which model the concierge runs on, and when the concierge models setting chose it (TER-1145)', async () => {
  show({ kind: 'ready', machine: machine('m1', 'jarvis'), configDir: null, account: { kind: 'default' }, sessionAtStake: false, model: 'opus', modelSteered: true, lastModel: 'claude-opus-5-5' });
  expect(screen.getByText('Modelo do concierge: opus, pela sua configuração de modelos do concierge. Última resposta em claude-opus-5-5.')).toBeTruthy();
  cleanup();
  show({ kind: 'ready', machine: machine('m1', 'jarvis'), configDir: null, account: { kind: 'default' }, sessionAtStake: false });
  expect(screen.getByText('Modelo do concierge: o padrão da CLI.')).toBeTruthy();
});

it('says the login is the machine default when no account was chosen', async () => {
  show({ kind: 'ready', machine: machine('m1', 'jarvis'), configDir: null, account: { kind: 'default' }, sessionAtStake: false });

  expect(screen.getByText(/conta padrão do Claude/i)).toBeTruthy();
  expect(screen.queryByText(/não serve/i)).toBeNull(); // nothing was lost: nothing to report
});

it('says so when the chosen account no longer serves this machine, instead of degrading in silence', async () => {
  show({ kind: 'ready', machine: machine('m1', 'jarvis'), configDir: null, account: { kind: 'lost' }, sessionAtStake: false });

  expect(screen.getByText(/conta de IA que você escolheu não serve/i)).toBeTruthy();
  expect(screen.getByText(/conta padrão do Claude/i)).toBeTruthy(); // …and what is running instead
  // …and it sends the person to the picker below, the only place that can set this conversation's
  // account — not to "Contas de IA", which manages a machine's logins and cannot choose the chat's.
  expect(screen.getByText(/use “trocar máquina ou conta”/i)).toBeTruthy();
  expect(screen.queryByText(/escolha outra em contas de IA/i)).toBeNull();
});

const READY_M1: ChatHostState = { kind: 'ready', machine: machine('m1', 'macbook'), configDir: null, account: { kind: 'default' }, sessionAtStake: false };
const BOTH_MACHINES = [machine('m1', 'macbook'), machine('m2', 'jarvis')];

it('offers the host machine accounts beside the machines, with its default login as an option of its own', async () => {
  const props = show(READY_M1, { picking: true, machines: BOTH_MACHINES, accounts: [{ id: 'acc1', label: 'trabalho' }], accountId: null });

  // Both halves of the pair in one place (spec §3). Without this list `ai_account_id` could only ever
  // be null, and the `chosen`/`lost` states the header renders were unreachable in the product.
  expect(screen.getByText(/conta do Claude em macbook/i)).toBeTruthy();
  // The default login is shown as the current *option*, not as an absence of one.
  expect(screen.getByText(/conta padrão da máquina \(atual\)/i)).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: /trocar para trabalho/i }));
  expect(props.onChooseAccount).toHaveBeenCalledWith('acc1');
  // Choosing an account never moves the machine.
  expect(props.onChoose).not.toHaveBeenCalled();
});

it('offers the way back to the machine default login, as a choice and not as an absence', async () => {
  const props = show(
    { kind: 'ready', machine: machine('m1', 'macbook'), configDir: '/home/u/.claude-work', account: { kind: 'chosen', id: 'acc1', label: 'trabalho' }, sessionAtStake: false },
    { picking: true, machines: BOTH_MACHINES, accounts: [{ id: 'acc1', label: 'trabalho' }], accountId: 'acc1' },
  );

  expect(screen.getByText(/trabalho \(atual\)/i)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /trocar para conta padrão da máquina/i }));
  expect(props.onChooseAccount).toHaveBeenCalledWith(null);
});

it('marks nothing as current when the stored account is the lost one, so every option is a change', async () => {
  show({ kind: 'ready', machine: machine('m1', 'macbook'), configDir: null, account: { kind: 'lost' }, sessionAtStake: false }, { picking: true, machines: BOTH_MACHINES, accounts: [{ id: 'acc1', label: 'trabalho' }], accountId: 'acc9' });

  // The stored id names nothing on this machine: keeping it is not an option, and pretending the
  // default login was chosen would hide that the pick was lost.
  expect(screen.queryByText(/conta padrão da máquina \(atual\)/i)).toBeNull();
  expect(screen.queryByText(/trabalho \(atual\)/i)).toBeNull();
  expect(screen.getByRole('button', { name: /trocar para conta padrão da máquina/i })).toBeTruthy();
  expect(screen.getByRole('button', { name: /trocar para trabalho/i })).toBeTruthy();
});

it('says the accounts are still being read instead of claiming the machine has none', async () => {
  show(READY_M1, { picking: true, machines: BOTH_MACHINES, accounts: null, accountId: null });

  expect(screen.getByText(/carregando as contas dessa máquina/i)).toBeTruthy();
  expect(screen.queryByText(/não tem outra conta/i)).toBeNull();
});

it('with a single machine and nothing else to run on, the picker is not a dead end dressed as a choice', async () => {
  show(READY_M1, { picking: true, machines: [machine('m1', 'macbook')], accounts: [], accountId: null });

  // No *other* machine is the same nothing as no machine at all, and there is no second account
  // either: so no list, and no warning about a change that cannot be made here.
  expect(screen.getByText(/nenhuma outra máquina com o agente do termhub/i)).toBeTruthy();
  expect(screen.getByText(/não tem outra conta do Claude/i)).toBeTruthy();
  expect(screen.queryByText(/memória do modelo começa de novo/i)).toBeNull();
  expect(screen.queryByRole('button', { name: /trocar para/i })).toBeNull();
  // The way out is still there.
  expect(screen.getByRole('button', { name: /cancelar/i })).toBeTruthy();
});

it('under “ver como” says so, instead of reporting someone else empty lists as your own', async () => {
  show(READY_M1, { picking: true, viewingAs: true, machines: BOTH_MACHINES, accounts: [{ id: 'acc1', label: 'trabalho' }], accountId: null });

  // The machines and logins on screen belong to the person being viewed, while the conversation belongs
  // to the admin viewing: nothing here can be offered, and an empty list would read as a fact about
  // their own machines — which may be several.
  expect(screen.getByText(/saia de “ver como”/i)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /trocar para/i })).toBeNull();
  expect(screen.queryByText(/nenhuma outra máquina/i)).toBeNull();
  expect(screen.queryByText(/não tem outra conta do Claude/i)).toBeNull();
  expect(screen.queryByText(/memória do modelo começa de novo/i)).toBeNull();
  expect(screen.getByRole('button', { name: /cancelar/i })).toBeTruthy();
});

it('says the accounts could not be read, and still offers the machines', async () => {
  const props = show(READY_M1, { picking: true, machines: BOTH_MACHINES, accountsError: true, accountId: null });

  // `ai_accounts` is its own permission: a role without it must not lose the machine picker too —
  // that is the only way off an offline host.
  expect(screen.getByText(/não foi possível ler as contas de IA/i)).toBeTruthy();
  expect(screen.queryByText(/não tem outra conta do Claude/i)).toBeNull(); // never a claim about the machine
  fireEvent.click(screen.getByRole('button', { name: /trocar para jarvis/i }));
  expect(props.onChoose).toHaveBeenCalledWith('m2');
});

it('still warns with one machine when the account can change, because the session goes either way', async () => {
  show(READY_M1, { picking: true, machines: [machine('m1', 'macbook')], accounts: [{ id: 'acc1', label: 'trabalho' }], accountId: null });

  // The CLI session lives in one config dir: changing the login starts it over exactly as moving
  // machine does, so the sentence is owed here too.
  expect(screen.getByText(/histórico desta conversa fica, mas a memória do modelo começa de novo/i)).toBeTruthy();
  expect(screen.getByRole('button', { name: /trocar para trabalho/i })).toBeTruthy();
});

it('says the host moved under a live session, instead of losing the model memory without a word', async () => {
  show({ kind: 'ready', machine: machine('m2', 'jarvis'), configDir: null, account: { kind: 'default' }, sessionAtStake: true });

  // The machine this conversation ran on is gone and the only one left was picked for the person: the
  // failed resume and the fresh session that follows are both invisible from here, so this is the one
  // place it can be said — and it is said before the next message, not after the memory is gone.
  // Where it is going, and what that costs. And nothing about where it was: a conversation from before
  // this feature ran in the operator's container and has no machine recorded at all, so "a máquina que
  // rodava esta conversa" would be a sentence about something that never existed.
  expect(screen.getByText(/continua em jarvis/i)).toBeTruthy();
  expect(screen.getByText(/não é onde a sessão anterior rodou/i)).toBeTruthy();
  expect(screen.getByText(/histórico fica, mas a memória do modelo começa de novo/i)).toBeTruthy();
  expect(screen.queryByText(/não está mais disponível/i)).toBeNull();
});

it('says nothing of the sort on a host that has its own session', async () => {
  show({ kind: 'ready', machine: machine('m2', 'jarvis'), configDir: null, account: { kind: 'default' }, sessionAtStake: false });

  // The ordinary conversation: a warning shown here too would be false every day, and then the true
  // one above would be invisible.
  expect(screen.queryByText(/memória do modelo/i)).toBeNull();
});

it('with no machine, states the product shape and offers the way to enrol one', async () => {
  show({ kind: 'no_machine' });

  // Not an error: the conversation runs on a machine of their own, and there is none yet.
  expect(screen.getByText(/roda em uma máquina sua/i)).toBeTruthy();
  expect(screen.getByText(/cadastre uma máquina com o agente do termhub/i)).toBeTruthy();
  const link = screen.getByRole('link', { name: /cadastrar máquina/i });
  expect(link.getAttribute('href')).toBe('/');
});

it('lists the machines to choose between, and picking one sets the host', async () => {
  const props = show({ kind: 'not_chosen', machines: [machine('m1', 'macbook'), machine('m2', 'jarvis')], sessionAtStake: false });

  expect(screen.getByText(/escolha em qual/i)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'jarvis' }));

  expect(props.onChoose).toHaveBeenCalledWith('m2');
});

it('picking the first machine warns about nothing: there is no session to lose', async () => {
  show({ kind: 'not_chosen', machines: [machine('m1', 'macbook'), machine('m2', 'jarvis')], sessionAtStake: false });

  // A warning that is usually false is a warning nobody reads — so this one is not shown here.
  expect(screen.queryByText(/memória do modelo/i)).toBeNull();
  expect(screen.getByRole('button', { name: 'jarvis' })).toBeTruthy();
});

it('warns before the pick when a session is at stake, because the machine that held it is no longer chosen', async () => {
  const props = show({ kind: 'not_chosen', machines: [machine('m1', 'macbook'), machine('m2', 'jarvis')], sessionAtStake: true });

  // On screen before any machine is picked: this is the case where the model's memory really does go.
  expect(screen.getByText(/já tem uma sessão/i)).toBeTruthy();
  expect(screen.getByText(/memória do modelo começa de novo/i)).toBeTruthy();
  expect(props.onChoose).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'jarvis' }));
  expect(props.onChoose).toHaveBeenCalledWith('m2');
});

it('names the offline machine and offers to change the host, without reading as a bug in the chat', async () => {
  const props = show({ kind: 'offline', machine: machine('m2', 'jarvis') });

  expect(screen.getByText(/máquina jarvis está offline/i)).toBeTruthy();
  expect(screen.getByText(/ligue-a/i)).toBeTruthy();
  // Nothing here blames the person, and nothing calls it a failure of the chat.
  expect(screen.queryByText(/erro|falha|não foi possível/i)).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: /trocar máquina/i }));
  expect(props.onPick).toHaveBeenCalled();
});

it('reads as an instruction when the agent is too old, naming the version', async () => {
  show({ kind: 'agent_too_old', machine: machine('m1', 'macbook'), version: '0.4.9' });

  expect(screen.getByText(/versão 0\.4\.9/)).toBeTruthy();
  expect(screen.getByText(/atualize o agente/i)).toBeTruthy();
  // …and where the update button is, since it does not live on this screen.
  expect(screen.getByRole('link', { name: /atualizar o agente/i }).getAttribute('href')).toBe('/');
});

it('drops the version when the agent never said which one it is', async () => {
  show({ kind: 'agent_too_old', machine: machine('m1', 'macbook'), version: '' });

  expect(screen.getByText(/ainda não sabe rodar o chat/i)).toBeTruthy();
  expect(screen.queryByText(/versão/i)).toBeNull(); // never an invented "(versão )"
});

it('warns that the session starts over before changing anything, and does nothing until it is confirmed', async () => {
  const props = show({ kind: 'ready', machine: machine('m1', 'macbook'), configDir: null, account: { kind: 'default' }, sessionAtStake: false }, { picking: true, machines: [machine('m1', 'macbook'), machine('m2', 'jarvis')] });

  // The warning is on screen while nothing has been changed yet.
  expect(screen.getByText(/histórico desta conversa fica, mas a memória do modelo começa de novo/i)).toBeTruthy();
  expect(props.onChoose).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: /trocar para jarvis/i }));
  expect(props.onChoose).toHaveBeenCalledWith('m2');
});

it('does not offer the current host as something to change to', async () => {
  show({ kind: 'ready', machine: machine('m1', 'macbook'), configDir: null, account: { kind: 'default' }, sessionAtStake: false }, { picking: true, machines: [machine('m1', 'macbook'), machine('m2', 'jarvis')] });

  expect(screen.getByText(/macbook \(atual\)/i)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /trocar para macbook/i })).toBeNull();
});

it('says the machines are still being read while the picker has none yet', async () => {
  show({ kind: 'offline', machine: machine('m2', 'jarvis') }, { picking: true, machines: null });

  expect(screen.getByText(/carregando suas máquinas/i)).toBeTruthy();
});

it('shows what a failed host change failed with, in the server words', async () => {
  show({ kind: 'not_chosen', machines: [machine('m1', 'macbook')], sessionAtStake: false }, { error: 'O chat só roda em uma máquina com o agente do termhub instalado' });

  expect(screen.getByText(/só roda em uma máquina com o agente/i)).toBeTruthy();
});

it('cannot be clicked twice while the change is in flight', async () => {
  show({ kind: 'not_chosen', machines: [machine('m1', 'macbook'), machine('m2', 'jarvis')], sessionAtStake: false }, { changing: true });

  for (const name of ['macbook', 'jarvis']) expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
});

it("a project chat picks among the project's accounts, not the machine's (TER-1144)", () => {
  const host: ChatHostState = { kind: 'ready', machine: machine('m1', 'jarvis'), configDir: null, account: { kind: 'chosen', id: 'a2', label: 'trabalho', via: 'project' }, sessionAtStake: false };
  const onChooseProjectAccount = vi.fn();
  show(host, { picking: true, accounts: [{ id: 'a1', label: 'pessoal', machine_id: 'm1' } as never], projectAccounts: [{ id: 'a2', label: 'trabalho', machine_name: 'jarvis' }, { id: 'h1', label: 'Claude', machine_name: 'hulk' }], setupHref: '/projects/p1/settings', onChooseProjectAccount });
  expect(screen.getByText('Esta conversa roda na máquina jarvis, na conta trabalho, definida pelo projeto.')).toBeTruthy();
  expect(screen.queryByText('Conta do Claude em jarvis')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Trocar para Claude · hulk' }));
  expect(onChooseProjectAccount).toHaveBeenCalledWith('h1');
  expect(screen.getByRole('link', { name: 'Contas e máquina do concierge no Setup do projeto' }).getAttribute('href')).toBe('/projects/p1/settings');
});

it('says why a project chat is on its account, and when the concierge machine is not the one running (TER-1144)', () => {
  const host: ChatHostState = { kind: 'ready', machine: machine('m1', 'jarvis'), configDir: null, account: { kind: 'chosen', id: 'a2', label: 'trabalho', via: 'project', source: 'auto', chat_machine: { id: 'm2', name: 'hulk' } }, sessionAtStake: false };
  show(host);
  expect(screen.getByText('A máquina do concierge (hulk) está offline ou sem conta com limite livre: o chat usa a próxima conta do projeto.')).toBeTruthy();
  cleanup();
  show({ ...host, account: { kind: 'chosen', id: 'a2', label: 'trabalho', via: 'project', source: 'conversation' } });
  expect(screen.getByText('Esta conversa roda na máquina jarvis, na conta trabalho, escolhida para esta conversa.')).toBeTruthy();
});
