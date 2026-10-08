import { describe, expect, it } from 'vitest';
import { classifyTurnEnd } from './turn-end.js';

// Last messages of real turns (October 2026), trimmed where long. A finished turn reports; a waiting one
// asks, offers, or leaves something to the person. In doubt the tab keeps waiting (TER-972).

/** The shape of TER-912's last message: merge and deploy done, card in Feito, nothing asked. */
const TER_912 = [
  'O escritório está em produção: o PR #305 foi mesclado, o deploy terminou e o card TER-912 está em Feito.',
  '',
  '- **Deploy:** a cor green está ativa e saudável; `app.termhub.dev` e `termhub.dev` respondem 200 pelo proxy local.',
  '- **Escritório:** aparece quando não há aba aberta, com os bonequinhos de cada terminal e o estado ao vivo.',
  '- **Épicos em andamento:** barra de progresso, cards em andamento e esperando, e os agentes ligados aos bonequinhos.',
  '- **Testes:** web 1748 ok, typecheck e builds ok.',
].join('\n');

/** The shape of TER-851's last message: the spec is written and decisions 2 to 6 are the person's. */
const TER_851 = [
  'Escrevi o spec em `docs/superpowers/specs/2026-10-04-concierge-relayed-input-design.md`. A decisão 1 já está tomada (marcar a origem no servidor).',
  '',
  'Preciso que você decida os pontos 2 a 6 antes do plano:',
  '2. O aviso vai no começo do texto digitado ou só no hook?',
  '3. Vale também para o app?',
  '4. Guardamos a origem por quanto tempo?',
  '5. Mostramos a origem na aba?',
  '6. O agente pode recusar mesmo assim?',
].join('\n');

const DEV_LOCAL = [
  'O dev local agora usa o Postgres e o Redis do Docker, e o banco está com o schema em dia.',
  '',
  '- **`.env`:** só a linha do `DATABASE_URL` mudou; ela agora aponta para `localhost:5432/financeiro_local`. As outras variáveis não mudaram.',
  '- **Containers:** o `financeiro-db-local` foi recriado e está aceitando conexões. O `financeiro-redis-local` já estava rodando e responde ao `ping`.',
  '- **Prisma:**',
  '  - `migrate deploy`: as 133 migrations foram aplicadas.',
  '  - `migrate status`: diz "Database schema is up to date!", e a tabela `_prisma_migrations` tem 133 linhas.',
].join('\n');

const BRANCHES_DELETED = [
  'Apaguei no GitHub as branches `feat/pix-automatico` e `docs/pix-automatico-status`. Antes conferi que as duas já estavam inteiras na main, pelos PRs #32 e #34, então nada se perdeu.',
  '',
  'A única branch do Pix Automático que sobrou é `feat/pix-automatico-inter`, local e no GitHub. Ela está em uso pelo worktree `pix-auto-inter` e já entrou na main pelo PR #44.',
].join('\n');

const OFFER_INSTALL = [
  'Pronto: clonei o repositório direto em `/Volumes/Extra/projects/8020/clawmobile`. A pasta estava vazia, então os arquivos ficaram na raiz dela, sem criar uma subpasta.',
  '',
  '- **Branch:** `main`, sincronizada com `origin/main`',
  '',
  'Ainda não instalei as dependências. Se quiser, rodo o `pnpm install`.',
].join('\n');

const OFFER_DELETE = [
  'Feito.',
  '',
  '**Branches das sete histórias:** todas estavam mergeadas na `main` (conferido com `merge-base`). Apaguei as sete no remoto e no local, e removi os sete worktrees.',
  '',
  'Deixei no lugar a branch `docs/opm-1-api-keys-webhooks` e o worktree `opm-1-api-rest`, do spec e do plano (PR #36), porque não estavam na lista das sete. Se quiser, apago também.',
].join('\n');

const QUESTION_AT_END = [
  'A exploração confirmou a suspeita, e isso pesa na sua resposta à pergunta anterior.',
  '',
  '1. **Só token, aluno sem acesso ao dashboard (minha recomendação para testar).**',
  '2. **Aluno com dashboard próprio.** Só viável comprando a licença Enterprise.',
  '',
  'Então, o aluno precisa do dashboard, ou só o token com o `eoas` basta para esse teste?',
].join('\n');

const LEFT_TO_THE_PERSON = [
  'O PR 14 está em produção: o merge foi feito, o deploy terminou com sucesso e não precisei reverter nada.',
  '',
  '- **Health check:** `/api/health` responde 200 com banco e certificado `ok`.',
  '',
  'Falta só o Pedro entregar o `.pfx` e seguir o passo a passo do README.',
].join('\n');

const PENDING_SECTION = [
  'O SMTP está configurado. De dentro do container, o login no `smtp.mailgun.org:587` funcionou.',
  '',
  '**Para testar:** faça um agendamento de teste. O e-mail de confirmação deve chegar.',
  '',
  '**Ainda pendente:**',
  '- Rodar `sudo ./svc.sh install && sudo ./svc.sh start`. É o que liga o runner.',
].join('\n');

// TER-1046: last messages of the tabs that were yellow on 2026-10-08, trimmed. Most only reported.

/** A report that ends with an offer ("posso removê-lo se quiser"). */
const CI_FRONT = [
  'O #492 foi mergeado na `master` e o deploy de produção disparou; quando conferi, ainda estava no começo.',
  '',
  '- **Merge:** feito com merge commit, o padrão do repo.',
  '- **Deploy de produção:** o run 37566042829 começou às 03:17. Não acompanhei até o fim; dá para ver com `gh run watch 37566042829`.',
  '',
  'Registrei a lição como corrigida na memória do termhub. O worktree `financeiro-fonts-wt` continua lá; posso removê-lo se quiser.',
].join('\n');

/** A report with "é só me pedir". */
const PUSHED = [
  'O projeto está no GitHub, no repositório `pedrogoiania/reactnative-for-challenges`, branch `main`.',
  '',
  'O `AGENTS.md` e a pasta `.claude/` foram enviados também. Se quiser tirá-los do repositório antes do teste, é só me pedir.',
].join('\n');

/** A spike that closed its PR and lists cards to create; "posso marcar como pronto quando você quiser". */
const SPIKE_DONE = [
  'Fechei o spec do TER-1031 e o PR #449: https://github.com/engenhariainversa/termhub/pull/449. Ele continua como draft, como no pedido original; posso marcar como pronto quando você quiser.',
  '',
  '**Decisões registradas no spec:**',
  '- A run passa de `blocked` para `done` uma única vez, quando aparece um PR do branch dela.',
  '',
  '**Cards para criar:**',
  '1. Automático: adotar o PR aberto do branch de uma run que terminou blocked',
].join('\n');

/** An analysis that stops for the person's decisions. */
const NEEDS_DECISIONS = [
  'Terminei a análise do REA-3 e não alterei nada ainda. Antes de mexer, preciso de algumas decisões suas, porque as mudanças afetam produção e a ordem de deploy importa.',
  '',
  '## Plano, na ordem',
  '',
  '1. **BFF, autenticação:** parar de confiar no token só decodificado.',
].join('\n');

/** A PR left open, with a section for the person. */
const FOR_THE_PERSON = [
  'O **PR #55** está aberto e eu parei aí: sem merge e sem deploy.',
  '',
  '**Para o Pedro decidir:** autorizar o merge e o deploy.',
].join('\n');

describe('classifyTurnEnd — a turn that ends with a report is finished, not waiting for you (TER-972, TER-1046)', () => {
  it.each([
    ['TER-912: merge, deploy and card done, nothing asked', TER_912],
    ['a dev setup report', DEV_LOCAL],
    ['a cleanup report', BRANCHES_DELETED],
    ['a one-word report', 'Feito.'],
    ['an English report', 'Merged PR #312 and the deploy is healthy. The card is in Done.'],
    // TER-1046: offers, next steps and pending items are part of a report
    ['an offer ("Se quiser, rodo…")', OFFER_INSTALL],
    ['an offer after a report ("Se quiser, apago também.")', OFFER_DELETE],
    ['something left to the person, not asked', LEFT_TO_THE_PERSON],
    ['a pending section and a test to run', PENDING_SECTION],
    ['"Posso…" without a question mark', 'Os testes passam. Posso abrir o PR.'],
    ['"você pode…"', 'PR #463 aberto, CI verde. Você pode acompanhar o deploy pelo Actions.'],
    ['a failure it reports', 'O deploy falhou no healthcheck da cor blue; reverti e a green segue ativa.'],
    ['a report that ends with an offer (real, 2026-10-08)', CI_FRONT],
    ['"é só me pedir" (real, 2026-10-08)', PUSHED],
    ['a finished spike (real, 2026-10-08)', SPIKE_DONE],
    ['a question in an earlier block only', 'Por que falhava? O cache.\n\nCorrigi o cache e os testes passam.'],
    ['a report that quotes the login error', `Documentei o caso "Login expired · Please run /login" no runbook. ${'Mais detalhes no PR. '.repeat(15)}`],
  ])('%s → finished', (_label, text) => {
    expect(classifyTurnEnd(text)).toBe('finished');
  });

  it.each([
    ['TER-851: decisions 2 to 6 are the person\'s', TER_851],
    ['a question at the end', QUESTION_AT_END],
    ['"Quer que eu…" without a question mark', 'Revisão feita. Quer que eu faça o merge'],
    ['"preciso que você"', 'Preciso que você aprove o acesso ao banco.'],
    ['"você decide"', 'As duas opções funcionam; você decide.'],
    ['a blocker', 'Não consegui rodar a suíte: o Docker não está de pé.'],
    ['decisions the person owes (real, 2026-10-08)', NEEDS_DECISIONS],
    ['"Para o Pedro decidir" (real, 2026-10-08)', FOR_THE_PERSON],
    ['English: let me know', 'The draft is ready. Let me know which one you prefer.'],
    ['English: should I', 'Tests pass. Should I merge'],
    ['English: blocked', 'I am blocked on the missing API key.'],
  ])('%s → waiting_input', (_label, text) => {
    expect(classifyTurnEnd(text)).toBe('waiting_input');
  });

  it('keeps waiting when there is nothing to read: in doubt, the person decides', () => {
    expect(classifyTurnEnd(null)).toBe('waiting_input');
    expect(classifyTurnEnd('')).toBe('waiting_input');
    expect(classifyTurnEnd('   \n ')).toBe('waiting_input');
  });

  it('ignores question marks in code, inline code and URLs', () => {
    expect(classifyTurnEnd('Corrigi a regex `^a?b$` e a URL https://termhub.dev/x?tab=1 agora abre a aba.')).toBe('finished');
    expect(classifyTurnEnd('Troquei o filtro:\n\n```ts\nconst x = a ?? b;\nconst y = ok ? 1 : 2;\n```\n\nO build passa.')).toBe('finished');
  });

  it.each([
    ['Login expired · Please run /login'],
    ['Invalid API key · Please run /login'],
    ['API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}} · Please run /login'],
  ])('Claude Code\'s login error "%s" → auth_required (TER-1046)', (text) => {
    expect(classifyTurnEnd(text)).toBe('auth_required');
  });

  it('reads accents loosely: "voce decide" and "nao consegui" count too', () => {
    expect(classifyTurnEnd('voce decide qual entra primeiro.')).toBe('waiting_input');
    expect(classifyTurnEnd('nao consegui conectar no banco.')).toBe('waiting_input');
  });
});
