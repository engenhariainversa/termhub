import { TAB_CHAT_EMPTY_REASONS } from '@/services/api/contract';
import { emptyReasonText } from './empty-reason-text';

it.each([
  ['no_hooks', 'Sem histórico: a máquina não tem os hooks do termhub', 'Instalar hooks'],
  ['not_reported', 'O Claude desta aba ainda não informou a sessão', 'Reinstalar hooks'],
  ['transcript_missing', 'O histórico desta sessão não está mais na máquina', null],
  ['new_session', 'Nenhuma mensagem nesta sessão ainda', null],
])('%s reads "%s"', (reason, title, install) => {
  const text = emptyReasonText(reason, 'box');
  expect(text.title).toBe(title);
  expect(text.install).toBe(install);
});

it('names the machine where it matters', () => {
  expect(emptyReasonText('no_hooks', 'box').hint).toContain('em box');
});

it('every reason of the contract has its own text', () => {
  for (const reason of TAB_CHAT_EMPTY_REASONS) expect(emptyReasonText(reason, 'box').title).not.toBe('Nenhuma mensagem ainda');
});

it('no reason, or one this build does not know, reads as the generic empty conversation', () => {
  expect(emptyReasonText(null, 'box')).toEqual({ title: 'Nenhuma mensagem ainda', hint: 'Escreva abaixo para falar com o Claude nesta aba.', install: null });
  expect(emptyReasonText('something_newer', 'box').title).toBe('Nenhuma mensagem ainda');
});
