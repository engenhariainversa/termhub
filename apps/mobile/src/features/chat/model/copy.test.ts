import type { ChatErrorCode, ChatHostState } from './types';
import { accountFromProject, errorSentence, failureSentence, hostAccountLine, hostLine, isChatErrorCode } from './copy';

const KNOWN_CODES: ChatErrorCode[] = ['RUNNER_FAILED', 'TOKEN_FAILED', 'CLI_MISSING', 'CLI_REJECTED', 'MISSING_SESSION', 'RUN_FAILED', 'KILLED', 'HOST_GONE', 'AGENT_TOO_OLD', 'HOST_BUSY', 'USAGE_LIMIT', 'MODEL_UNAVAILABLE', 'AUTH_FAILED', 'SUBSCRIPTION_BLOCKED'];

describe('errorSentence', () => {
  it('returns a non-empty sentence for every known code', () => {
    for (const code of KNOWN_CODES) expect(errorSentence(code).length).toBeGreaterThan(0);
  });

  it('falls back to the generic failure line for RUNNER_FAILED', () => {
    expect(errorSentence('RUNNER_FAILED')).toBe('A resposta não terminou — tente de novo.');
  });

  it('falls back to the generic failure line for a code this bundle does not know', () => {
    expect(errorSentence('SOMETHING_A_NEWER_SERVER_INVENTED' as ChatErrorCode)).toBe('A resposta não terminou — tente de novo.');
  });

  it('gives each stored failure its own sentence, verbatim from the web', () => {
    expect(errorSentence('TOKEN_FAILED')).toBe('O servidor não conseguiu criar a credencial do concierge. Tente de novo.');
    expect(errorSentence('CLI_MISSING')).toBe('Essa máquina não tem o Claude Code instalado. Instale o claude nela e mande a mensagem de novo.');
    expect(errorSentence('CLI_REJECTED')).toBe('O Claude Code dessa máquina recusou os parâmetros do chat. Atualize o claude nela e tente de novo.');
    expect(errorSentence('MISSING_SESSION')).toBe('A sessão do Claude nessa máquina não existe mais. Mande a mensagem de novo para começar uma nova.');
    expect(errorSentence('RUN_FAILED')).toBe('O Claude parou no meio da resposta. Mande a mensagem de novo.');
    expect(errorSentence('KILLED')).toBe('A resposta foi interrompida antes de terminar. Mande a mensagem de novo.');
    expect(errorSentence('HOST_GONE')).toBe('A máquina do chat saiu do ar no meio da resposta. Ligue-a e mande a mensagem de novo.');
    expect(errorSentence('HOST_BUSY')).toBe('A máquina do chat está com terminais demais abertos e não sobrou espaço para a conversa. Feche algumas abas e mande a mensagem de novo.');
    expect(errorSentence('AGENT_TOO_OLD')).toBe('O agente dessa máquina ainda não sabe rodar o chat. Atualize o agente e tente de novo.');
  });

  it('gives every non-fallback code a sentence distinct from every other', () => {
    const nonFallback = KNOWN_CODES.filter((c) => c !== 'RUNNER_FAILED');
    const sentences = nonFallback.map(errorSentence);
    expect(new Set(sentences).size).toBe(sentences.length);
  });
});

describe('hostLine', () => {
  it('names the machine and the chosen account when ready', () => {
    const host: ChatHostState = { kind: 'ready', machine: { id: 'm1', name: 'jarvis' }, configDir: null, account: { kind: 'chosen', id: 'a1', label: 'trabalho' }, sessionAtStake: false };
    expect(hostLine(host)).toEqual({ text: 'Esta conversa roda na máquina jarvis, na conta trabalho.', tone: 'ok' });
  });

  it("says the account was set by the project when the host's account comes from it (TER-589)", () => {
    const host: ChatHostState = { kind: 'ready', machine: { id: 'm1', name: 'jarvis' }, configDir: null, account: { kind: 'chosen', id: 'a1', label: 'trabalho', via: 'project' }, sessionAtStake: false };
    expect(hostLine(host)).toEqual({ text: 'Esta conversa roda na máquina jarvis, na conta trabalho, definida pelo projeto.', tone: 'ok' });
    expect(hostAccountLine(host)).toBe('Conta definida pelo projeto: trabalho');
    expect(accountFromProject(host)).toBe(true);
    const chosen: ChatHostState = { ...host, account: { kind: 'chosen', id: 'a1', label: 'trabalho' } };
    expect(hostAccountLine(chosen)).toBe('Esta conversa roda na máquina jarvis, na conta trabalho.');
    expect(accountFromProject(chosen)).toBe(false);
  });

  it('names the machine default login when the account is the machine default', () => {
    const host: ChatHostState = { kind: 'ready', machine: { id: 'm1', name: 'jarvis' }, configDir: null, account: { kind: 'default' }, sessionAtStake: false };
    expect(hostLine(host)).toEqual({ text: 'Esta conversa roda na máquina jarvis, na conta padrão do Claude dela.', tone: 'ok' });
  });

  it('names the machine default login too when the chosen account is lost', () => {
    const host: ChatHostState = { kind: 'ready', machine: { id: 'm1', name: 'jarvis' }, configDir: null, account: { kind: 'lost' }, sessionAtStake: false };
    expect(hostLine(host).text).toBe('Esta conversa roda na máquina jarvis, na conta padrão do Claude dela.');
  });

  it('says the machine is offline, with a warn tone', () => {
    const host: ChatHostState = { kind: 'offline', machine: { id: 'm1', name: 'jarvis' } };
    expect(hostLine(host)).toEqual({ text: 'A máquina jarvis está offline agora.', tone: 'warn' });
  });

  it('asks to pick a machine when more than one exists, with an info tone', () => {
    const host: ChatHostState = { kind: 'not_chosen', machines: [{ id: 'm1', name: 'jarvis' }, { id: 'm2', name: 'macbook' }], sessionAtStake: false };
    expect(hostLine(host)).toEqual({ text: 'Você tem mais de uma máquina: escolha em qual o chat vai rodar.', tone: 'info' });
  });

  it('says no machine is registered yet, with an info tone', () => {
    const host: ChatHostState = { kind: 'no_machine' };
    expect(hostLine(host)).toEqual({ text: 'O chat roda em uma máquina sua, e você ainda não cadastrou nenhuma.', tone: 'info' });
  });

  it('says the agent needs updating, with a warn tone', () => {
    const host: ChatHostState = { kind: 'agent_too_old', machine: { id: 'm1', name: 'jarvis' }, version: '0.4.9' };
    expect(hostLine(host)).toEqual({ text: 'O agente da máquina jarvis ainda não sabe rodar o chat. Atualize o agente dessa máquina para conversar por aqui.', tone: 'warn' });
  });
});

describe('isChatErrorCode / failureSentence', () => {
  it('accepts every known code and refuses anything else', () => {
    for (const code of KNOWN_CODES) expect(isChatErrorCode(code)).toBe(true);
    expect(isChatErrorCode('SOMETHING_NEW')).toBe(false);
    expect(isChatErrorCode('')).toBe(false);
  });

  it("narrows the contract's error_code before picking the sentence, falling back to the generic one", () => {
    expect(failureSentence('HOST_GONE')).toBe('A máquina do chat saiu do ar no meio da resposta. Ligue-a e mande a mensagem de novo.');
    expect(failureSentence('SOMETHING_NEW')).toBe('A resposta não terminou — tente de novo.');
    expect(failureSentence(null)).toBe('A resposta não terminou — tente de novo.');
  });
});
