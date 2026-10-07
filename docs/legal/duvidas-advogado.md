# Pontos em aberto: advogado, decisões do Pedro e lacunas do produto

> Acompanha os rascunhos [`termos-de-uso.md`](termos-de-uso.md) e [`politica-de-privacidade.md`](politica-de-privacidade.md) (TER-702). O estudo dos concorrentes está em [`comparativo.md`](comparativo.md).
>
> Prefixos dos itens:
> - **A**: IA e contas de terceiros;
> - **L**: LGPD;
> - **J**: Termos de Uso;
> - **S**: assinaturas;
> - **D**: decisões do Pedro;
> - **P**: lacunas no produto, que precisam virar cards antes da publicação;
> - **E**: lojas de aplicativos.
>
> No fim estão os anexos: o rascunho das declarações das lojas e o mapa de dados com as referências do código.

## Para o advogado

### A. IA e contas de terceiros

**A-1. Credenciais do Claude e o tráfego pelo servidor (prioridade máxima).**

O que diz a Anthropic: a [página de compliance do Claude Code](https://code.claude.com/docs/en/legal-and-compliance) proíbe que terceiros "collect, store, or intermediate Claude.ai credentials or session tokens". Ela permite que o usuário final entre "to the unmodified Claude Code binary with their own Claude subscription".

O que o termhub faz hoje:
- roda o binário oficial na máquina do usuário, que faz login pelo fluxo da Anthropic;
- para mostrar o consumo das contas, o agente lê `~/.claude*/.credentials.json` (ou o Keychain do macOS) e envia a credencial ao servidor;
- o servidor usa a credencial uma vez em `api.anthropic.com/api/oauth/usage` e a descarta;
- o mesmo vale para o Codex (`auth.json`, endpoint `chatgpt.com/backend-api/wham/usage`) e para o Gemini.

Perguntas:
1. Isso caracteriza "intermediar" a credencial?
2. O risco muda se a consulta for feita pelo agente, na própria máquina, de modo que a credencial nunca chegue ao servidor? Essa é a recomendação técnica, ver P-8.
3. O endpoint `oauth/usage` não é documentado publicamente. Consultá-lo é um problema por si só?

**A-2. Commercial Terms da Anthropic.** A mesma página diz que produtos que pré-instalam ou rodam o Claude Code "in hosted sandboxes or other agent infrastructure" precisam aceitar os Commercial Terms. No termhub, o binário roda na máquina do usuário, e não na infraestrutura do termhub. O termhub se enquadra nessa regra? Deve aceitar os Commercial Terms por precaução?

**A-3. Uso "automatizado" de assinaturas de consumidor.** Os Consumer Terms da Anthropic proíbem o acesso "through automated or non-human means" (exceto por API key). A página do Claude Code diz que os limites dos planos Pro e Max pressupõem uso "ordinary, individual". O termhub tem recursos que agem sem o humano:
- `start_agent`;
- o concierge disparando agentes;
- respostas automáticas a perguntas;
- troca automática de conta quando o limite acaba.

Os Termos do termhub devem alertar para isso de forma mais explícita? Algum desses recursos deve ser desligado por padrão?

**A-4. Troca automática de conta.** Com `claude_auto_swap`, ligado por padrão, a sessão passa para outra conta Claude do mesmo usuário quando o limite de uma acaba. Isso pode ser visto como forma de contornar limites de uso (OpenAI: "circumvent any rate limits"). Precisa de aviso nos Termos ou de mudar o padrão?

**A-5. Marca.** A Anthropic permite dizer "runs Claude Code" em texto simples, mas não usar o nome ou o logo como parte do nome do produto, nem sugerir parceria. É preciso revisar o site e o app (textos que citam Claude, Codex e Cursor)?

**A-6. OpenAI e compartilhamento.** A OpenAI proíbe "make your account available to anyone else". Se um dia houver planos de equipe, em que membros usam a mesma máquina ou a mesma conta de IA, como os Termos devem tratar isso?

### L. LGPD

**L-1. Pessoa jurídica controladora.** Qual entidade assina como controladora? Ver D-1.

**L-2. Controlador ou operador.** Para os dados de conta, o termhub é controlador. E para os dados de terceiros que aparecem no conteúdo do usuário (terminais, tickets, anexos com dados de clientes dele)?
- O termhub seria operador e o usuário, controlador?
- No caso de empresas, é preciso um DPA (acordo de tratamento de dados)?

O rascunho da Política (2.5) fala em tratar os dados "conforme as suas instruções", sem fixar o papel.

**L-3. Bases legais.** Validar as bases propostas na Política, seção 3:
- execução de contrato para quase tudo;
- legítimo interesse para os logs de segurança e o IP dos aparelhos;
- consentimento para analytics e medição de anúncios.

O legítimo interesse precisa de um relatório (LIA) documentado?

**L-4. Transferência internacional.** Os operadores ficam nos EUA: Cloudflare, Google, Expo, Apple e os provedores de IA e de integrações.
- O art. 33, V e IX (execução de contrato e pedido do titular) basta?
- Ou é preciso assinar as cláusulas-padrão da Resolução CD/ANPD nº 19/2024 com cada operador?

**L-5. Analytics do app móvel sem consentimento.** No app, o Google Analytics for Firebase registra telas e eventos de sessão desde a primeira abertura, com identificador de instalação e IP. Na web e no site, o analytics só começa depois do "Aceitar". Pode ser legítimo interesse no app, ou é preciso pedir consentimento também para analytics? (Ver D-5 e o card TER-583.)

**L-6. Encarregado (DPO).** O termhub pode se enquadrar como agente de tratamento de pequeno porte (Resolução CD/ANPD nº 2/2022) e ficar dispensado de indicar encarregado? Mesmo dispensado, deve indicar um canal? A Política já prevê um e-mail.

**L-7. Decisões automatizadas (art. 20).** As respostas automáticas a perguntas dos agentes usam a memória e a similaridade de texto. A calibração por usuário está em discussão no TER-642. Isso é "decisão tomada unicamente com base em tratamento automatizado" que afeta os interesses do titular? É preciso garantir revisão?

**L-8. Marco Civil, art. 15.** Confirmar a obrigação de guardar os registros de acesso a aplicações (IP, data e hora) por 6 meses, e se os logs atuais do servidor atendem a ela. Ver P-6.

**L-9. Lista de espera.** A lista guarda nome, e-mail, telefone, LinkedIn e GitHub. A base legal é o consentimento ou os procedimentos preliminares de contrato? A mesma lista é usada para convidar pessoas para a comunidade do WhatsApp: isso precisa de consentimento à parte? O aviso atual diz só "Usamos seus dados só para o acesso ao beta".

**L-10. "Ver como" (administrador).** Um administrador do termhub pode ver todos os dados de um usuário, para suporte. Que salvaguardas a Política deve prometer, e o que o produto precisa ter? Por exemplo: registro de auditoria, aviso ao usuário, consentimento para suporte. Ver P-9.

**L-11. Cidade pública.** O usuário pode publicar projetos e um apelido numa página pública, e o servidor cria um link curto num serviço de terceiros (`api.typetoaccess.it`). Isso precisa de aviso específico ou de consentimento no momento da publicação?

**L-12. Leitura de documentos do repositório.** O agente lê `docs/superpowers/**` e `docs/lessons/**` dos repositórios do usuário para a memória. Esses arquivos podem conter dados de terceiros. Basta o aviso na Política?

**L-14. Registros de segurança na exclusão de conta.** A exclusão de conta pelo próprio usuário (TER-720, PR #285) apaga junto com a conta os eventos de segurança dos aparelhos (`device_events`: IP, cidade, país, falhas de PIN), e mantém só os logs do servidor (IP e URL, fora do banco). Isso basta para a guarda de 6 meses do Marco Civil (art. 15), ou esses eventos também precisam ficar guardados pelo prazo legal depois da exclusão?

**L-13. Anthropic: seção para o Brasil.** A Política da Anthropic tem uma seção para o Brasil, com as cláusulas-padrão da ANPD. Vale usá-la como modelo para a nossa seção de transferência?

### J. Termos de Uso

**J-1. Código aberto e serviço hospedado.** O código é MIT. A separação feita nos Termos (1.4) e na Política (2.4) é suficiente? É preciso tratar de marca, para que forks não usem o nome "termhub"?

**J-2. Idade mínima de 18 anos.** Cursor, Anthropic e Termius usam 18; GitHub e OpenAI usam 13. O rascunho usa 18. Está adequado?

**J-3. Forma do aceite.** Clique ("Li e aceito") no cadastro e no checkout, com a versão e a data guardadas (P-12). Hoje, o cadastro acontece por convite e por login com Google ou e-mail. Que forma de aceite vale para os usuários atuais, que já usam o produto sem termos?

**J-4. Consumidor ou profissional.** O termhub é uma ferramenta profissional, mas uma pessoa física que assina é consumidora (CDC).
- O rascunho limita a responsabilidade só quando não há relação de consumo (12.3). Isso é defensável?
- É melhor ter termos separados para empresas (B2B)?

**J-5. Responsabilidade pelas ações dos agentes.** A cláusula 6.2 põe no usuário a responsabilidade pelos comandos executados por agentes de IA nas máquinas dele. Ela é válida diante do CDC (art. 51, I), considerando que é o termhub quem envia os comandos e as respostas automáticas? E quando o comando sai de uma resposta automática do termhub (TER-642) e não de um clique do usuário?

**J-6. Foro.** Para não consumidores, Goiânia/GO (D-10)? Para consumidores, o domicílio do consumidor.

**J-7. Suspensão imediata.** Em caso de ataque, malware ou mineração, a suspensão pode ser imediata, com aviso depois. A redação (11.3) e o canal de recurso (11.4) estão adequados?

**J-8. Inatividade.** O rascunho prevê encerrar contas gratuitas sem uso por mais de 12 meses, com 30 dias de aviso, a exemplo de Cursor e Anthropic. Isso é aceitável?

**J-9. Agente instalado e mudanças na máquina.** O agente altera arquivos de configuração do usuário (`~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.cursor/hooks.json`), pode instalar pacotes com `sudo` e se atualizar sozinho quando essa opção está ligada. Basta a informação na seção 6, ou é preciso um aceite específico no momento da instalação?

### S. Assinaturas

> Os planos ainda não foram lançados. Os rascunhos falam deles de forma genérica. As decisões já tomadas estão no épico TER-645 e servem de contexto para as perguntas abaixo:
> - plano padrão e plano de API, com valores definidos no card;
> - nível de teste sem prazo, com limites de projetos, máquinas e terminais, e sem o chat;
> - os usuários atuais terão um período de teste até uma data definida antes do início da cobrança;
> - o pagamento é processado pelo Opa Pingou, que escolhe o gateway;
> - planos podem ser concedidos por parceiros, como a Engenharia Inversa.

**S-1. Arrependimento de 7 dias (art. 49).** Ele vale mesmo depois do período de teste? Ou seja, a contagem começa na primeira cobrança? O reembolso é integral mesmo com uso intenso nesses 7 dias? A Anthropic adota 7 dias com reembolso integral para o Brasil.

**S-2. Teste sem prazo e com limites.** Isso é "período de teste" ou "plano gratuito limitado"? Que cuidados tomar para que a passagem ao plano pago não pareça venda casada ou prática abusiva? A conversão nunca acontece sem a ação do usuário.

**S-3. Usuários atuais.** Eles terão aviso por banner e por e-mail antes do início da cobrança. Que antecedência e que forma de comunicação são necessárias? É preciso um novo aceite?

**S-4. Opa Pingou.** Quem é o fornecedor perante o consumidor, e quem emite a nota fiscal? O Opa Pingou é o intermediador (*merchant of record*)? Os termos do Opa Pingou precisam aparecer no checkout? Há relação societária entre o termhub e o Opa Pingou que precise ser informada?

**S-5. Falta de pagamento.** Qual é a carência razoável antes de bloquear? O que acontece com os dados de quem não paga: por quanto tempo ficam guardados, e com que aviso antes de serem apagados?

**S-6. Planos de parceiros.**
- Quais dados podemos trocar com o parceiro? Hoje a proposta é: o parceiro informa o e-mail, e o termhub diz se a conta está ativa.
- Quando o parceiro revoga a concessão, que aviso e que carência devemos ao usuário?
- É preciso um contrato com cada parceiro, como controladores independentes ou na relação controlador-operador?

**S-7. Mudança de preço.** O rascunho prevê 30 dias de aviso, com o novo preço valendo na renovação seguinte. Isso está adequado ao CDC?

**S-8. Compras dentro dos apps (Apple e Google).** Se o app móvel vender a assinatura, as regras das lojas exigem o sistema de compras delas (In-App Purchase / Play Billing), com comissão e regras próprias de reembolso e cancelamento. Se o app só der acesso a uma assinatura comprada na web, é preciso seguir as regras de "reader app" e de links externos. Isso muda os Termos? Ver D-11.

**S-9. Reembolso proporcional.** É devido quando o termhub encerra uma conta sem violação do usuário, ou quando remove um recurso relevante de um plano pago (10.2)?

## Decisões do Pedro

| # | Decisão | Onde aparece | Sugestão |
|---|---|---|---|
| D-1 | Razão social, CNPJ e endereço do controlador. O GitHub e a conta do Expo estão em nome da "Engenharia Inversa", que nos cards aparece como **parceiro** e não como o próprio termhub. Quem assina? | Termos 1.1; Política 2.1 | definir antes da revisão |
| D-2 | E-mails de contato e do encarregado | Termos 17; Política 2.2 | `contato@termhub.dev` e `privacidade@termhub.dev` (criar) |
| D-3 | País e estado onde o servidor fica, e se haverá mudança de hospedagem antes do lançamento | Política 6 e 7 | declarar "Brasil, [estado]" |
| D-4 | Provedor de SMTP de produção | Política 6 | — |
| D-5 | Analytics no app móvel: pedir consentimento, como na web, ou ficar com legítimo interesse? | Política 9.2; L-5 | pedir consentimento: alinha com a web e com o TER-583, e simplifica as declarações das lojas |
| D-6 | Prazos de retenção que faltam: dados após a exclusão (30 dias?), backups, histórico das abas, lista de espera | Política 8 | 30 dias; **decidido no TER-743**: histórico das abas 90 dias, lista de espera 12 meses (da inscrição ou do último convite); chat, respostas e memória enquanto a conta existir. Backups seguem em aberto (D-7) |
| D-7 | Backup do banco: hoje não há. Haverá? Onde e por quanto tempo? | Política 6 e 8 | — |
| D-8 | URLs públicas: `/termos`, `/privacidade` e `/excluir-conta` em `termhub.dev`. O card usa `/termos` e `/privacidade`, e o código da landing menciona "terms and privacy" | Termos; Política 12; E-1 | `termhub.dev/termos`, `/privacidade` e `/excluir-conta` |
| D-9 | Recursos que agem sozinhos (troca automática de conta, respostas automáticas): manter ligados por padrão? | A-3, A-4 | aguardar o parecer de A-3 |
| D-10 | Foro para não consumidores | Termos 15.2 | Goiânia/GO |
| D-11 | O app móvel vai vender a assinatura, ou só dar acesso a uma compra feita na web? | S-8 | vender só na web no lançamento, e o app não mostrar preço nem link de compra no iOS |
| D-12 | Exclusão de conta com período para desfazer (Termius: 30 dias) ou imediata? | Política 12 | 30 dias para desfazer e depois exclusão definitiva |
| D-13 | Versão em inglês dos documentos: a landing tem i18n, e há um card de tradução | — | depois da versão em pt-BR aprovada |

## Lacunas no produto (viram cards antes de publicar)

A Política foi escrita como **deve ficar**. Ela só pode ser publicada quando estes itens existirem, ou quando o texto for ajustado.

| # | Lacuna | Hoje | Evidência no código | Bloqueia |
|---|---|---|---|---|
| P-1 | ~~**Exclusão de conta pelo próprio usuário** (web e app)~~ | **entregue no PR #285 (TER-720)**, com janela de 30 dias para desfazer | `apps/server/src/routes/account.ts`; `apps/server/src/routes/m-account.ts` | — |
| P-2 | ~~**Exclusão em cascata completa**~~ | **entregue no PR #285 (TER-720)**: máquinas, projetos, integrações, tickets e as tabelas por e-mail saem junto com a conta | `apps/server/src/db/repositories/account-deletion.ts` | — |
| P-3 | ~~**Página web para pedir a exclusão sem o app**~~ | **entregue no PR #285 (TER-720)**: `termhub.dev/excluir-conta` | `apps/landing/src/delete-account/DeleteAccountPage.tsx` | — |
| P-4 | Provedor de SMTP de produção documentado, e **e-mail fora do log**: sem `SMTP_HOST`, o e-mail inteiro, com o código de login, vai para o log | `apps/server/src/email/mailer.ts:32-42` | — | segurança |
| P-5 | País da hospedagem declarado | não está escrito em lugar nenhum | — | Política |
| P-6 | ~~**Retenção dos logs** (6 meses, Marco Civil) e rotação~~ | **entregue no TER-744**: registros de acesso (data e hora, IP, usuário, rota e status; sem query, corpo nem conteúdo) na tabela `access_logs`, apagados após 190 dias | `apps/server/src/access-log/recorder.ts`; `docs/security-and-network.md` | — |
| P-7 | Backup do banco | não há backup automatizado | `README.md:237` (só um `pg_dump` manual) | continuidade |
| P-8 | **Consulta de uso das contas de IA sem a credencial sair da máquina**, e uma opção para desligar a leitura | **em andamento no TER-735**: a consulta passa a ser feita na própria máquina (agente 0.20.0+, script via SSH, ou o próprio servidor quando a máquina é ele mesmo) e o servidor recebe só os números; chave por máquina para desligar | `packages/machine-ops/src/ai-usage*.ts`; `apps/agent/src/rpc/ai.ts`; `apps/server/src/ai/` | A-1 |
| P-9 | Registro de auditoria do "ver como" do administrador | não existe | `apps/server/src/auth/scope.ts:11-39` | L-10 |
| P-10 | **Exportação dos dados** (portabilidade) | não existe | — | LGPD, art. 18, V |
| P-11 | ~~Prazos de retenção automáticos para chat, `tab_last_answers`, `tab_events`, memória e lista de espera~~ | **entregue no TER-743**: histórico das abas 90 dias, lista de espera 12 meses (da inscrição ou do último convite), expurgo de hora em hora; chat, últimas respostas e memória ficam enquanto a conta existir, e o usuário apaga uma conversa inteira em "Apagar conversa" | `apps/server/src/retention/purge.ts`; `apps/server/src/chat/service.ts` (`deleteConversation`) | — |
| P-12 | **Aceite dos Termos e da Política**: versão e data por usuário, no cadastro e no checkout, e novo aceite quando houver mudança relevante | não existe | — | lançamento (TER-717) |
| P-13 | **Links para os Termos e a Política** no rodapé do site, no login do app web, em Ajustes e na tela inicial do app móvel | não existem; as páginas `/termos` e `/privacidade` também não | `apps/landing/vite.config.ts:13-17`; `apps/landing/src/Site.tsx:10`; `apps/landing/src/i18n.ts:190` | lojas |
| P-14 | Google Fonts carregado antes do consentimento | fontes do Google na landing | `apps/landing/index.html:11-13` | TER-583 |
| P-15 | Analytics do app móvel com consentimento (se D-5 = consentimento) | `analytics_storage` liberado por padrão | `apps/mobile/firebase.json`; `apps/mobile/src/services/analytics.ts` | D-5 |
| P-16 | `docs/security-and-network.md:28` diz que o app web não tem scripts de terceiros, mas ele carrega o Google Analytics depois do consentimento | doc desatualizado | `apps/web/src/lib/analytics.ts` | coerência |
| P-17 | Serviço `concierge` no `docker-compose.yml` monta o diretório de conta Claude do mantenedor, mas não é mais usado | configuração morta | `docker-compose.yml:146-165`; `apps/server/src/config.ts:135-141` | A-1 (evitar a aparência de conta compartilhada) |
| P-18 | Histórico do que mudou nos Termos e na Política (versões anteriores publicadas) | — | — | Termos 13.3 |

## Lojas de aplicativos

**E-1. O que falta para a revisão:**
1. **URL pública da Política de Privacidade.** É obrigatória nas duas lojas (Apple 5.1.1(i); Google Play) e precisa ter link **dentro do app** (P-13).
2. **Exclusão de conta dentro do app** (Apple 5.1.1(v); Google Play). Pode começar no app e terminar na web. "Fale com o suporte" não é aceito (P-1).
3. **URL web para pedir a exclusão sem reinstalar o app.** É exigência do Google Play, informada no formulário Data safety (P-3).
4. **Privacy manifest do iOS** (`expo.ios.privacyManifests`). O app usa frameworks estáticos, e a Apple não lê bem os manifests dos pods nesse modo. Exige um build nativo novo, com bump de `expo.version`.
5. **Declaração do "Advertising ID" no Play Console.** O Firebase Analytics acrescenta a permissão `AD_ID` ao manifest do Android. Conferir no build.
6. **A Política deve citar a IA de terceiros** (Anthropic), conforme a diretriz 5.1.2(i) da Apple. Isso já está na Política, seção 5.
7. **Conta para a equipe de revisão.** Usar o modo de revisão (`review_enabled_until`), que aprova sozinho os aparelhos da conta de teste, e explicar isso nas notas da revisão.
8. A tela inicial do app pede o e-mail sem dizer para quê e sem link para a Política. Acrescentar uma linha com o link.

**E-2. Respostas das declarações.** Só podem dizer "o usuário pode pedir a exclusão" depois de P-1 e P-3 entregues. Rascunho no anexo B.

---

## Anexo A: mapa de dados (código em 01/10/2026, `origin/main` 4035521f)

| Área | O que o código faz | Referência |
|---|---|---|
| Banco | Postgres + pgvector, no servidor próprio; volumes Docker `pgdata` e `chat-files` | `docker-compose.yml:24-91` |
| Cifra em repouso | AES-256-GCM (`ENCRYPTION_KEY`), aplicada só a `integrations.secret` e `devices.pin_secret_enc`; o resto fica em claro | `apps/server/src/lib/crypto.ts:8-27` |
| Login | código por e-mail (hash, 10 min); senha argon2id; Google OAuth com PKCE (`openid email profile`), com cadastro automático pelo Google desligado | `apps/server/src/auth/service.ts:69-97,135`; `auth/google.ts:37`; `config.ts:23-29,100` |
| Cookies | sessão httpOnly/Lax/Secure (30 dias), `termhub_csrf`, `termhub_view_as`, cookie OAuth de 600 s | `apps/server/src/auth/routes.ts:30-34,112,186-191` |
| Terminal | stream pelo WebSocket, sem persistência; logs só com ids | `apps/server/src/terminal/ws.ts:133-241`; `docs/security-and-network.md:160` |
| Saída dos agentes | guarda a última resposta (até 100 mil caracteres), perguntas e permissões, `state_text` (2 mil caracteres) e `tab_events`; o prompt é descartado | `apps/server/src/monitor/state.ts:12,87,136-178`; `schema.prisma:256-348` |
| Hooks | o script envia os eventos por `curl` para `/api/hooks/events`; os eventos de ferramenta vão reduzidos ao nome dela; Stop vai com a última resposta | `packages/machine-ops/src/hooks.ts`; `apps/agent/src/rpc/hooks.ts:145-268` |
| Agente | `hello` com hostname, SO, arquitetura e ferramentas; sonda de hardware com o top 7 de processos; listagem de pastas; leitura de docs do repositório; busca de `CLAUDE_CONFIG_DIR` nos arquivos do shell | `apps/agent/src/run.ts:49-56`; `packages/machine-ops/src/hardware-script.ts:7-40`; `apps/agent/src/claude-dirs.ts:13,57-70` |
| Execução | lista fechada de RPCs; `run_command` e o envio de texto passam pelo chat ou MCP, com confirmação | `apps/agent/src/rpc/index.ts:23-54`; `apps/server/src/mcp/tools.ts:124,166` |
| Credenciais de IA | lidas na máquina e enviadas ao servidor; usadas em memória para consultar o uso | `packages/machine-ops/src/ai-credentials.ts:22-38`; `apps/server/src/ai/index.ts:37-77` |
| Chat | o Claude Code roda na máquina do usuário, com a conta dele; mensagens, ações e decisões ficam no banco | `apps/agent/src/claude/run.ts:33,144`; `schema.prisma:750-900` |
| Memória | decisões, mensagens, cards, notas, lições e docs; embeddings locais (`paraphrase-multilingual-MiniLM-L12-v2`) | `apps/server/src/memory/docs.ts:145`; `docker/embed/server.py:18` |
| Anexos | disco do servidor; 64 MB por arquivo, 2 GB por usuário; não enviados saem em 24 h | `apps/server/src/chat/attachments/upload.ts:14`; `sweep.ts:5` |
| Colar no terminal | arquivo gravado na máquina do usuário, apagado em 7 dias | `packages/machine-ops/src/paste.ts:7,66` |
| Voz | Whisper local; áudio não gravado; job em memória por 10 min | `apps/server/src/terminal/transcription.ts:6-66`; `docker/whisper/server.py` |
| Integrações | tokens pessoais cifrados (GitHub, Linear, Jira), ou `gh auth token` lido com confirmação | `apps/server/src/routes/integrations.ts:18-35`; `apps/agent/src/rpc/secret.ts` |
| Mobile | e-mail (hash no pedido), modelo, SO, nome do aparelho, push token, IP, cidade e país; prazos: 1 dia (pedidos), 90 dias (eventos), 30 dias (notificações) | `apps/mobile/src/features/session/model/device-info.ts:21-32`; `apps/server/src/mobile/purge.ts:7-11` |
| Push | Expo → APNs/FCM; só nomes de projeto, aba e máquina | `apps/server/src/mobile/push.ts:25-150`; `push-text.ts` |
| Analytics | GA4/Firebase: web e landing só com consentimento; app com `screen_view` liberado por padrão e medição de anúncios (ATT) com consentimento | `apps/web/src/lib/analytics.ts`; `apps/landing/src/analytics.ts`; `apps/mobile/firebase.json` |
| OTA | servidor xprem (`ota.engenhariainversa.com.br`) | `apps/mobile/app.config.js:9-38` |
| Lista de espera | nome, e-mail (só Gmail), telefone, LinkedIn, GitHub | `apps/server/src/routes/waitlist.ts:20-27`; `schema.prisma:586-609` |
| Tokens de API | hash; eventos guardados por 30 dias | `apps/server/src/auth/api-tokens.ts:14` |
| Hosts externos do servidor | Google OAuth, GitHub, Linear, Jira, `api.anthropic.com`, `chatgpt.com`, `cloudcode-pa.googleapis.com`, `exp.host`, `api.cloudflare.com`, `api.typetoaccess.it`, `registry.npmjs.org`, SMTP | `docs/security-and-network.md:242`; `apps/server/src/public/typetoaccess.ts:9-34` |
| Cobrança | nada implementado | — |
| Aceite de termos | não existe | — |

## Anexo B: rascunho das declarações das lojas

Valem depois de D-5, P-1 e P-3. Se D-5 for consentimento, "Product Interaction" e "App interactions" continuam declarados, mas passam a depender do consentimento.

**Apple, App Privacy.** Rastreamento: **sim** (IDFA, só com ATT autorizado).

| Tipo | Coletado | Vinculado ao usuário | Usado para rastreamento | Finalidade |
|---|---|---|---|---|
| Contact Info: Email Address | sim | sim | não | App Functionality |
| Contact Info: Name | sim | sim | não | App Functionality |
| User Content: Other User Content (chat, comandos, respostas) | sim | sim | não | App Functionality |
| User Content: Photos or Videos | sim | sim | não | App Functionality |
| User Content: Audio Data | sim (escolha conservadora; o áudio não é guardado) | sim | não | App Functionality |
| Identifiers: User ID | sim | sim | não | App Functionality |
| Identifiers: Device ID | sim | sim | **sim** | App Functionality, Analytics, medição de anúncios |
| Usage Data: Product Interaction | sim | sim | **sim** | Analytics, Developer's Advertising or Marketing |
| Location: Coarse Location | sim | sim | não | App Functionality (segurança), Analytics |
| Diagnostics, Sensitive Info (biometria fica no aparelho), Contacts, Health, Financial, Browsing, Purchases | não | — | — | — |

**Google Play, Data safety.** Respostas gerais:
- coleta dados: sim;
- compartilha dados: sim (Advertising ID e uso com o Google, com consentimento);
- criptografia em trânsito: sim;
- o usuário pode pedir a exclusão: sim, **só depois de P-1 e P-3**.

| Tipo | Coletado | Compartilhado | Opcional | Finalidade |
|---|---|---|---|---|
| Personal info: Email, Name, User IDs | sim | não | obrigatório | Account management, App functionality |
| Location: Approximate | sim | não | obrigatório | Fraud prevention / security, Analytics |
| Messages: Other in-app messages | sim | não | obrigatório | App functionality |
| Photos and videos | sim | não | opcional | App functionality |
| Audio: Voice recordings | sim (processamento efêmero) | não | opcional | App functionality |
| Files and docs | sim | não | opcional | App functionality |
| App activity: App interactions | sim | sim (Google, com consentimento) | [D-5] | Analytics, Advertising or marketing |
| Device or other IDs (inclui o Advertising ID, com consentimento) | sim | sim (Advertising ID) | Advertising ID opcional | App functionality, Analytics, Advertising |

Mais no Play Console: declaração **Advertising ID** = sim; URL de exclusão de conta = D-8; URL da Política = D-8.
