# Comparativo: termos de uso e políticas de privacidade de concorrentes e referências

> Insumo para o TER-702. Pesquisa feita em 01/10/2026 nas páginas oficiais. Algumas foram lidas por ferramenta que resume o texto, e as da OpenAI foram lidas em cópias do Wayback Machine de set/2026, porque o site bloqueia acesso automatizado.
> **Antes de reaproveitar qualquer cláusula, confira o texto na fonte.** Itens marcados *n/e* não foram encontrados; *n/v* foram encontrados só em fonte secundária, sem confirmação na fonte oficial.

## 1. Fontes

| Empresa | Termos | Privacidade | Outros | Atualização |
|---|---|---|---|---|
| **Warp** | [warp.dev/terms-of-service](https://www.warp.dev/terms-of-service) | [warp.dev/privacy-policy](https://www.warp.dev/privacy-policy) | [privacidade nos docs](https://docs.warp.dev/support-and-community/privacy-and-security/privacy), [subprocessadores](https://www.warp.dev/legal/subprocessors), [DPA](https://www.warp.dev/legal/data-processing-addendum) | ToS 07/10/2025; privacidade 18/08/2026 |
| **Termius** | [termius.com/terms-of-use](https://termius.com/terms-of-use) | [termius.com/privacy-policy](https://termius.com/privacy-policy) | [segurança](https://termius.com/security), [criptografia](https://docs.termius.com/security/encryption-overview), [exclusão](https://docs.termius.com/administration/account-management) | 30/01/2025 |
| **Cursor** | [cursor.com/terms-of-service](https://cursor.com/terms-of-service) | [cursor.com/privacy](https://cursor.com/privacy) | [uso de dados](https://cursor.com/data-use), [segurança](https://cursor.com/security), [cookies](https://cursor.com/cookie-policy), [exclusão](https://cursor.com/help/account-and-billing/delete-account) | ToS 03/09/2026; privacidade 29/09/2026 |
| **Replit** | [replit.com/terms-of-service](https://replit.com/terms-of-service) | [replit.com/privacy-policy](https://replit.com/privacy-policy) | [DPA](https://replit.com/dpa), [subprocessadores](https://replit.com/subprocessors), [treino de modelos](https://docs.replit.com/legal-and-security-info/model-improvement) | 03/08/2026 |
| **GitHub** (incl. Codespaces e Copilot) | [GitHub Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service) | [General Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement) | [produtos adicionais](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features), [uso aceitável](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies), [subprocessadores](https://docs.github.com/en/site-policy/privacy-policies/github-subprocessors) | 27/04/2026 (produtos: 27/08/2026) |
| **Anthropic** (Claude Code) | [Consumer Terms](https://www.anthropic.com/legal/consumer-terms), [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) | [Privacy Policy](https://www.anthropic.com/legal/privacy) | [Usage Policy](https://www.anthropic.com/legal/aup), [Claude Code: legal e compliance](https://code.claude.com/docs/en/legal-and-compliance), [Claude Code: uso de dados](https://code.claude.com/docs/en/data-usage) | Consumer 08/10/2025; privacidade 10/09/2026 |
| **OpenAI** (Codex) | [Terms of Use](https://openai.com/policies/terms-of-use/), [Services Agreement](https://openai.com/policies/services-agreement/) | [Privacy Policy (resto do mundo)](https://openai.com/policies/row-privacy-policy/) | [Usage Policies](https://openai.com/policies/usage-policies/), [Codex: autenticação](https://learn.chatgpt.com/docs/auth) | ToU 01/01/2026; privacidade 06/02/2026 |
| **Linear** | [linear.app/terms](https://linear.app/terms) | [linear.app/privacy](https://linear.app/privacy) | [adendo de IA](https://linear.app/legal/ai-addendum), [DPA](https://linear.app/dpa) | ToS 09/06/2026; privacidade 17/03/2025 |
| **Vercel** | [vercel.com/legal/terms](https://vercel.com/legal/terms) | [vercel.com/legal/privacy-policy](https://vercel.com/legal/privacy-policy) | [uso aceitável](https://vercel.com/legal/acceptable-use-policy), [DPA](https://vercel.com/legal/dpa), [mudança de 03/2026](https://vercel.com/changelog/updates-to-terms-of-service-march-2026) | 01/06/2026 |

## 2. Quadro por tema

### 2.1 Conteúdo do usuário, treino de modelos e IA de terceiros

| | Quem é dono do conteúdo e da saída da IA | Treina modelos com o conteúdo? | Provedores de IA e retenção |
|---|---|---|---|
| Warp | usuário; licença ampla à Warp (§2.7) | ToS permite treino ("train its algorithms"); docs prometem que Business/Enterprise não coletam | Anthropic, OpenAI, Google, Fireworks; ZDR (sem retenção) com os LLMs; *Secret Redaction* sempre ligada |
| Termius | não trata | *n/e* | IA em beta, confirma antes de executar; provedor *n/e* |
| Cursor | usuário; Anysphere cede os direitos sobre as sugestões | não por padrão; *Privacy Mode* garante | ZDR com OpenAI, Anthropic, Meta e outros; mesmo com chave própria (BYO key) o pedido passa pelo backend |
| Replit | usuário; licença ampla; feedback vira propriedade do Replit | **sim por padrão**; opt-out só no Pro; Enterprise não | Anthropic, OpenAI, Google, OpenRouter |
| GitHub | usuário; não reivindica entradas nem saídas da IA | entradas e saídas de IA, com opt-out (J.3); **não compartilha com provedores terceiros** | OpenAI, Anthropic, Azure; Copilot: retenção varia por superfície (*n/v*) |
| Anthropic | Anthropic cede ao usuário as saídas | consumidor: só se o usuário permitir (5 anos ligado / 30 dias desligado); comercial: nunca | — |
| OpenAI | usuário dono de entradas e saídas | consumidor: sim, com opt-out; empresas/API: não | — |
| Linear | cliente | **não**, nem a Linear nem os provedores (adendo de IA); ZDR quando disponível | Anthropic, OpenAI, Cohere, Fireworks etc. |
| Vercel | usuário; licença ampla | Hobby e trial: **sim por padrão** e compartilha com terceiros; Pro: não; Enterprise: nunca | lista no Trust Center (*n/v*) |

### 2.2 Retenção, exclusão e exportação

| | Retenção | Exclusão de conta | Exportação |
|---|---|---|---|
| Warp | sem prazos; job diário de exclusão | no app (página de gestão de dados) | por pedido |
| Termius | "pelo necessário" | self-service; **30 dias para desfazer**; iOS no app, Android só pela web | *n/e* |
| Cursor | variável | self-service, concluída em até 30 dias | por e-mail |
| Replit | sem prazos; DPA: 90 dias | botão no app ou e-mail | por e-mail |
| GitHub | apaga em até 90 dias após o encerramento | self-service | **self-service** (arquivo .tar.gz por e-mail) |
| Anthropic | conversas apagadas saem do backend em 30 dias | por pedido / configurações | por pedido |
| OpenAI | apagados em 30 dias | self-service | **self-service** (Data Controls) |
| Linear | 30 dias após o encerramento; logs de auditoria por 3 meses | pelo workspace | formato legível por máquina |
| Vercel | "mínimo necessário" | self-service, com pré-requisitos | Privacy Request Center |

### 2.3 Subprocessadores, transferência internacional, lei e foro

| | Lista pública de subprocessadores | Aviso de novo subprocessador | Lei e foro | Arbitragem | LGPD |
|---|---|---|---|---|---|
| Warp | sim, com país | 10 dias para objeção | Nova York | não | *n/e* |
| Termius | citados na política, sem país | *n/e* | "EUA" (genérico) | *n/e* | *n/e* |
| Cursor | sim (Trust Center) | *n/e* | Texas | não; **renúncia a ação coletiva** | *n/e* |
| Replit | sim | *n/e* | Califórnia | **sim**, com opt-out em 30 dias | *n/e* |
| GitHub | sim | **30 dias antes** | Califórnia (São Francisco) | não | *n/e* |
| Anthropic | sim | *n/v* | Califórnia | não | **sim**: seção para o Brasil, com cláusulas-padrão da ANPD (*n/v* no texto exato) |
| OpenAI | categorias | *n/e* | Califórnia | **sim** (NAM), com opt-out em 30 dias | não menciona |
| Linear | sim | **30 dias** | Delaware | não | não menciona |
| Vercel | sim (Trust Center) | 5 dias para objeção | Califórnia | **sim** (JAMS), com opt-out em 30 dias | *n/e* |

### 2.4 Responsabilidade, uso aceitável e ações de agentes de IA

| | Teto de responsabilidade | Mineração de cripto / ataques | Responsabilidade pelas ações da IA |
|---|---|---|---|
| Warp | valor pago em 12 meses | proíbe DoS e malware; mineração *n/e*; **canal de recurso contra suspensão** | "não responde pela saída" |
| Termius | sem teto | sem política de uso aceitável | IA pede confirmação antes de executar (blog) |
| Cursor | maior entre 6 meses pagos e US$ 100 | engenharia reversa, scraping, extração de modelo | execução automática: "**YOU ARE SOLELY RESPONSIBLE**" |
| Replit | sem teto em valor | **proíbe mineração**, ataques e scraping | saída "pode ser errada" |
| GitHub | sem teto em valor | **proíbe mineração** (regra geral, Codespaces e Actions); processo de reintegração | "Output may be inaccurate"; o usuário revisa |
| Anthropic | maior entre 6 meses pagos e US$ 100 | malware, invasão, acesso não autorizado | "You are responsible for all Inputs ... and all **Actions**" |
| OpenAI | maior entre 12 meses pagos e US$ 100 | atividade cibernética maliciosa | uso da saída "at your sole risk"; revisão humana |
| Linear | 12 meses | acesso não autorizado, engenharia reversa | "CUSTOMER IS SOLELY RESPONSIBLE FOR REVIEWING ... ALL AI OUTPUTS" |
| Vercel | maior entre US$ 100 e 6 meses | scraping, **proxy/VPN**, ataques; mineração *n/e* | o usuário monitora as ações dos agentes de IA feitas em seu nome |

### 2.5 Assinaturas

| | Renovação | Reembolso | Aviso de mudança de preço | Teste grátis | Pagamento |
|---|---|---|---|---|---|
| Warp | automática (mensal ou anual *n/v*) | nenhum | publicado no site | *n/e* | Stripe |
| Termius | automática | caso a caso | "razoável" | **exige cartão e cobra no fim** | Stripe, PayPal, lojas |
| Cursor | automática; cancelar 24 h antes | não, salvo lei | aviso prévio | *n/e* | Stripe |
| Replit | automática | **30 dias, integral** (uso avulso fora) | ao fim do período | *n/e* | Stripe |
| GitHub | automática | não reembolsável | ao fim do período | *n/e* | — |
| Anthropic | automática | não, **exceto Brasil: 7 dias de arrependimento**, reembolso em até 14 dias | **30 dias** | — | *n/v* |
| OpenAI | automática | não, salvo lei | **30 dias** | — | *n/e* |
| Linear | automática | só por violação da Linear | a critério da Linear, com direito de não renovar | — | Stripe |
| Vercel | automática | não (exceto proporcional) | próximo período, com aviso | **14 dias de Pro** | *n/e* |

### 2.6 Idade mínima, mudança nos termos e cookies

| | Idade | Mudança nos termos | Cookies e analytics |
|---|---|---|---|
| Warp | 13 (privacidade) | só por escrito (estilo B2B); privacidade: e-mail | RudderStack, Sentry |
| Termius | 18 | "tentaremos" 30 dias | GA, Firebase, Hotjar, Mixpanel; ignora *Do Not Track* |
| Cursor | 18 | e-mail; continuar usando = aceite | banner; GA e pixels de anúncio |
| Replit | 13 (13–18 com os pais) | "revise regularmente" | GA; opt-out |
| GitHub | 13 | **30 dias** | não essenciais só com consentimento onde a lei exige |
| Anthropic | 18 | consumidor: continuar usando = aceite; comercial: 30 dias | política de cookies própria |
| OpenAI | 13 (menores de 18 com os pais) | **30 dias** para mudanças adversas | aviso de cookies próprio |
| Linear | 13 (privacidade) | **30 dias** | essenciais e analytics |
| Vercel | 16 | efeito imediato | política de 2020 (desatualizada) |

### 2.7 Credenciais de assinatura de IA usadas por ferramentas de terceiros

Este é o ponto mais sensível para o termhub, porque o termhub roda o Claude Code e o Codex com as contas pessoais dos usuários.

- **Anthropic.** A página [Legal and compliance do Claude Code](https://code.claude.com/docs/en/legal-and-compliance) diz:
  - terceiros não podem oferecer login do Claude.ai, nem "route requests through Free, Pro, or Max plan credentials on behalf of their users";
  - "developers may not **collect, store, or intermediate** Claude.ai credentials or session tokens";
  - por outro lado, é permitido "an end user ... signing in to the **unmodified Claude Code binary with their own Claude subscription**, including where a platform hosts Claude Code";
  - produtos que pré-instalam ou rodam o Claude Code "in hosted sandboxes or other agent infrastructure" precisam aceitar os Commercial Terms, não modificar o binário e não revender o uso;
  - os Consumer Terms proíbem acesso "through automated or non-human means" (exceto via API key) e o compartilhamento de conta.
- **OpenAI.** Os Terms of Use proíbem compartilhar credenciais ou "make your account available to anyone else" e extrair saída "automatically or programmatically". A documentação do Codex pede que `~/.codex/auth.json` seja tratado como senha. Não foi encontrada uma cláusula equivalente à da Anthropic sobre ferramentas de terceiros (*n/v*).
- **Para o termhub.** O termhub roda o binário oficial, sem modificação, na máquina do próprio usuário, e o login acontece pelo fluxo do fornecedor. Isso se encaixa na exceção da Anthropic. **Porém**, para mostrar o consumo das contas, o agente envia ao servidor a credencial OAuth (`.credentials.json`, `auth.json`, `oauth_creds.json`), que é usada uma vez e descartada. Isso pode ser lido como "intermediar" credenciais. Ver `duvidas-advogado.md`, item A-1.

## 3. O que levar para o termhub

**Adotar:**
1. **Página de uso de dados em linguagem simples**, separada da política (Cursor *Data Use*, documentação do Warp), dizendo o que passa pelo servidor e o que fica na máquina.
2. **Não treinar modelos com o conteúdo do usuário** e dizer isso de forma explícita (Linear, Cursor *Privacy Mode*, GitHub J.3). O termhub não treina nada, então é um diferencial fácil.
3. **Responsabilidade do usuário pelas ações dos agentes** (Anthropic "Actions", Cursor "solely responsible", Vercel), com a ressalva de que o CDC não aceita exoneração total (art. 51, I).
4. **Aviso de 30 dias** para mudanças nos termos e no preço (GitHub, OpenAI, Linear, Anthropic).
5. **Arrependimento de 7 dias** expresso para o Brasil (Anthropic), conforme o art. 49 do CDC.
6. **Lista pública de operadores (subprocessadores)** com finalidade e país (Warp, GitHub, Linear).
7. **Exclusão de conta self-service** dentro do app e pela web, com prazo definido (GitHub, Cursor; Termius com 30 dias para desfazer).
8. **Exportação self-service** (GitHub, OpenAI). Atende à portabilidade da LGPD.
9. **Política de uso aceitável específica**: mineração (GitHub, Replit), ataques, proxy/VPN (Vercel), multicontas para ganhar teste grátis (Warp).
10. **Canal de recurso contra suspensão** (Warp, GitHub).
11. **Cookies analíticos só com consentimento** (o termhub já faz isso na web).

**Evitar:**
1. Foro estrangeiro, arbitragem obrigatória e renúncia a ação coletiva: inaplicáveis ao consumidor (CDC, arts. 51, VII, e 101, I).
2. "Não reembolsável" absoluto (GitHub, Warp, Cursor, Vercel): conflita com o art. 49 do CDC.
3. "Continuar usando = aceite" sem aviso efetivo (Cursor, Replit, Vercel).
4. Opt-in de treino por padrão (Replit, Vercel Hobby): repercussão ruim e sem necessidade.
5. Teste grátis que cobra no fim sem aviso (Termius): risco com o CDC.
6. Política genérica que ignora o produto (Termius): a nossa precisa falar de terminal, agente e IA.
7. Política de privacidade desatualizada em relação aos termos de IA (Linear, Vercel cookies).

## 4. Onde o termhub difere dos concorrentes

- **Compute do usuário.** Warp, Termius e Cursor rodam no computador do usuário. Replit, Codespaces e Vercel rodam na infraestrutura deles. O termhub tem o compute no usuário e o controle no servidor, e o fluxo do terminal passa pelo servidor. Isso pede:
  - proibições de uso voltadas a **máquinas de terceiros** (acesso sem autorização), mais do que ao abuso da nossa infraestrutura;
  - transparência sobre o que trafega e o que fica guardado.
- **IA com a conta do usuário.** O termhub não tem conta de IA própria. Ninguém entre os estudados funciona exatamente assim: Warp, Cursor e Replit usam as contas de IA deles. Os termos precisam remeter ao contrato do usuário com o fornecedor de IA, e o produto precisa ficar dentro das regras de credenciais da Anthropic.
- **Código aberto (MIT).** É preciso separar a licença do software do contrato do serviço hospedado. Warp tem cliente aberto (AGPL) e termos de serviço à parte.
