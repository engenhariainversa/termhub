import { TAB_CHAT_EMPTY_REASONS } from '@/services/api/contract';
import { emptyReasonText } from './empty-reason-text';

it.each([
  ['no_hooks', 'Sem histórico: a máquina não tem os hooks do termhub', 'Instalar hooks'],
  ['not_reported', 'O agente desta aba ainda não informou a sessão', 'Reinstalar hooks'],
  ['transcript_missing', 'O histórico desta sessão não está mais na máquina', null],
  ['new_session', 'Nenhuma mensagem nesta sessão ainda', null],
  ['codex_untrusted', 'O Codex ainda não confia nos hooks do termhub', null],
  ['no_agent', 'Esta aba é um terminal sem agente', null],
])('%s reads "%s"', (reason, title, install) => {
  const text = emptyReasonText(reason, 'box');
  expect(text.title).toBe(title);
  expect(text.install).toBe(install);
});

it('names the machine where it matters', () => {
  expect(emptyReasonText('no_hooks', 'box').hint).toContain('em box');
  expect(emptyReasonText('codex_untrusted', 'box').hint).toContain('em box');
  expect(emptyReasonText('no_agent', 'box').hint).toContain('em box');
});

it('every reason of the contract has its own text', () => {
  for (const reason of TAB_CHAT_EMPTY_REASONS) expect(emptyReasonText(reason, 'box').title).not.toBe('Nenhuma mensagem ainda');
});

it('no reason, or one this build does not know, reads as the generic empty conversation', () => {
  expect(emptyReasonText(null, 'box')).toEqual({ title: 'Nenhuma mensagem ainda', hint: 'Escreva abaixo para falar com o Claude nesta aba.', install: null });
  expect(emptyReasonText('something_newer', 'box').title).toBe('Nenhuma mensagem ainda');
});

it('a tab whose CLI never reported names both CLIs, and a Claude tab keeps its own wording (TER-1118)', () => {
  expect(emptyReasonText('not_reported', 'box').hint).toContain('claude --continue ou codex resume');
  expect(emptyReasonText('no_hooks', 'box').hint).toContain('Claude Code ou do Codex');
  expect(emptyReasonText('not_reported', 'box', 'claude')).toMatchObject({ title: 'O Claude desta aba ainda não informou a sessão', install: 'Reinstalar hooks' });
  expect(emptyReasonText('no_hooks', 'box', 'claude').hint).not.toContain('codex');
});

it("a Codex tab gets Codex's wording, never Claude's (TER-1102)", () => {
  expect(emptyReasonText('not_reported', 'box', 'codex')).toMatchObject({ title: 'O Codex desta aba ainda não informou a sessão', install: 'Reinstalar hooks' });
  expect(emptyReasonText('not_reported', 'box', 'codex').hint).toContain('codex resume');
  expect(emptyReasonText('transcript_missing', 'box', 'codex').hint).toContain('sessão do Codex');
  expect(emptyReasonText('new_session', 'box', 'codex').hint).toContain('/new');
  expect(emptyReasonText(null, 'box', 'codex').hint).toBe('Escreva abaixo para falar com o Codex nesta aba.');
  // the reasons with no Codex wording of their own keep theirs
  expect(emptyReasonText('codex_untrusted', 'box', 'codex').title).toBe('O Codex ainda não confia nos hooks do termhub');
  for (const reason of TAB_CHAT_EMPTY_REASONS) expect(emptyReasonText(reason, 'box', 'codex').hint).not.toMatch(/Claude/);
});
