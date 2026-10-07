# Política de Privacidade do termhub

> **RASCUNHO PARA REVISÃO JURÍDICA (TER-702). Não publicar.**
> Este texto descreve o que o código do termhub faz hoje (outubro de 2026). Os fatos foram conferidos no repositório, e o mapa com as referências está em [`duvidas-advogado.md`](duvidas-advogado.md), anexo A.
> Trechos entre colchetes (`[...]`) são dados que faltam ou decisões em aberto.
> Blocos `> Nota:` são comentários para a revisão e saem da versão publicada.
> Onde o produto ainda não faz o que a política promete (exclusão de conta pelo próprio usuário, exportação, prazos de retenção), a política está escrita como deve ficar, e a lacuna está listada em `duvidas-advogado.md`, seção "Lacunas no produto". Ela só pode ser publicada depois que essas lacunas forem fechadas, ou com o texto ajustado.

**Versão:** [v1, data]
**Última atualização:** [data]

---

## 1. Resumo

- **Seu código e seus dados são seus.** Não vendemos dados pessoais e não usamos o seu conteúdo para treinar modelos de IA.
- **O conteúdo dos terminais passa pelo termhub, mas o fluxo não é gravado.** Guardamos o que o Serviço precisa para funcionar: as mensagens do chat, a última resposta de cada agente, as perguntas dos agentes, os cards, as notas e a memória dos projetos.
- **A IA é a sua.** O termhub roda o Claude Code, o Codex e outras ferramentas na sua máquina, com a sua conta. O que você envia a esses fornecedores segue os termos deles.
- **Analytics com o seu consentimento**, no site e no app web. No aplicativo móvel, [ver a seção 9].
- Você pode acessar, corrigir, exportar e apagar seus dados, e excluir sua conta pelo app, pelo site ou por e-mail.

## 2. Quem é o controlador e como falar conosco

2.1. O controlador dos dados pessoais tratados no serviço hospedado do termhub é **[RAZÃO SOCIAL]**, CNPJ [CNPJ], com sede em [ENDEREÇO] ("**termhub**", "**nós**").

2.2. **Encarregado pelo tratamento de dados pessoais (DPO):** [NOME ou "Encarregado do termhub"], e-mail **[privacidade@termhub.dev]**.

2.3. Esta Política vale para:
- o site `termhub.dev`;
- o aplicativo web `app.termhub.dev`;
- os aplicativos para iOS e Android;
- o agente do termhub (`@termhub/agent`);
- a API e o servidor MCP.

Juntos, eles formam o "**Serviço**".

2.4. **Auto-hospedagem.** O código do termhub é aberto, sob a licença MIT. Quem instala e opera a própria cópia é o controlador dos dados que ela trata, e esta Política não se aplica a essa cópia.

2.5. **Dados de terceiros no seu conteúdo.** Seus terminais, projetos, tickets e anexos podem conter dados pessoais de outras pessoas, como colegas, clientes ou usuários dos seus sistemas. Em relação a esses dados, o termhub trata as informações conforme as suas instruções, para prestar o Serviço.

> Nota: definir com o advogado se, para esses dados, o termhub é operador e o usuário é controlador. Ver o item L-2.

## 3. Que dados tratamos

### 3.1 Conta e autenticação

| Dado | Para quê | Base legal (LGPD, art. 7º) |
|---|---|---|
| E-mail, nome, foto do perfil (quando você entra com o Google), apelido público (opcional) | criar e manter sua conta, fazer login e enviar comunicações do Serviço | execução de contrato (V) |
| Senha (guardada só como hash argon2id) e códigos de login por e-mail (guardados só como hash, válidos por 10 minutos) | autenticação | execução de contrato (V) |
| Identificador da sua conta Google (login com o Google) | autenticação | execução de contrato (V) |
| Sessões (guardamos só o hash do token; a sessão dura até 30 dias) | manter você conectado | execução de contrato (V) |
| Tentativas de login por e-mail e por IP | impedir ataques de força bruta | legítimo interesse (IX) e segurança |
| Preferências da conta e do chat | personalizar o Serviço | execução de contrato (V) |

### 3.2 Máquinas e agente

| Dado | Para quê | Base legal |
|---|---|---|
| Nome da máquina, hostname, sistema operacional, arquitetura, versão do agente, ferramentas instaladas (tmux, git, claude, codex etc.) | identificar e operar suas máquinas | execução de contrato |
| Endereço, usuário e porta SSH (máquinas sem agente). Não guardamos senhas nem chaves privadas das suas máquinas | conectar por SSH | execução de contrato |
| Dados de hardware lidos quando você abre a tela da máquina: CPU, memória, discos, temperaturas, GPU e os processos que mais usam CPU. Não guardamos esses dados | mostrar o estado da máquina | execução de contrato |
| Lista de pastas, quando você navega por elas no termhub | escolher onde abrir um projeto | execução de contrato |
| Hash do token da máquina | autenticar o agente | execução de contrato |

### 3.3 Terminais e agentes de IA

- **Fluxo do terminal.** Ele passa pelo nosso servidor, em tempo real, para chegar ao seu navegador ou celular. **Não gravamos esse fluxo nem o registramos em logs.**
- **Leitura de tela.** Quando você, o chat ou um agente pede, o Serviço lê as últimas linhas de um terminal. A leitura não é guardada.
- **Eventos das ferramentas de IA.** Com os hooks instalados, as ferramentas de IA (Claude Code, Codex, Cursor) avisam o termhub quando começam a trabalhar, terminam, fazem uma pergunta ou pedem permissão. Desses eventos, **guardamos**:
  - a última resposta de cada agente em cada aba, com até 100 mil caracteres;
  - as perguntas e os pedidos de permissão, com as opções e a resposta dada;
  - um histórico dos estados da aba;
  - o caminho do arquivo de transcrição da sessão na sua máquina, mas não o conteúdo dele.
- **O que é descartado.** O texto que você digita para o agente (o prompt) chega em alguns eventos, mas é descartado.
- **Arquivos que você cola no terminal.** São gravados **na sua máquina** e apagados depois de 7 dias. No servidor ficam só os metadados: nome, tamanho e data.
- **Para quê e base legal:** operar o Serviço, mostrar o estado das abas e permitir que você responda aos agentes pelo app. Base legal: execução de contrato.

### 3.4 Chat (concierge), memória e anexos

- **Mensagens.** Guardamos as mensagens do chat, suas e do assistente, as ações que o chat propõe (com os comandos e os argumentos) e as decisões que você toma nos cartões de confirmação.
- **Onde o chat roda.** O chat roda o Claude Code **na sua máquina, com a sua conta Claude**. As mensagens, o contexto e as telas que o chat lê são enviados à Anthropic pela sua conta.
- **Memória.** Para sugerir respostas e dar contexto aos agentes, o termhub guarda decisões, mensagens do chat, cards, notas, lições e trechos de documentos dos seus repositórios. Os documentos são os arquivos `docs/superpowers` e `docs/lessons`, lidos pelo agente.
  - Esses textos viram "embeddings", representações numéricas para busca, calculadas **no nosso próprio servidor**, sem enviar o texto a terceiros.
  - Telas de terminal nunca entram na memória.
- **Anexos.** Ficam guardados no nosso servidor, com o texto extraído deles, por exemplo de PDFs. O limite é de 64 MB por arquivo e 2 GB por usuário. Anexos que não chegam a ser enviados são apagados em 24 horas.
- **Ditado por voz.** O áudio é transcrito no nosso próprio servidor (modelo Whisper), sem envio a terceiros. O áudio não é gravado e o texto transcrito fica em memória por no máximo 10 minutos.
- **Base legal:** execução de contrato.

### 3.5 Projetos, cards e integrações

| Dado | Para quê | Base legal |
|---|---|---|
| Projetos, cards, notas, configurações de projeto e pull requests vinculados | organizar o seu trabalho | execução de contrato |
| Tokens das integrações (GitHub, Linear, Jira), **guardados cifrados** (AES-256-GCM). No Jira, também o e-mail da conta | acessar essas plataformas em seu nome | execução de contrato |
| Issues e tickets sincronizados: título, descrição, URL, estado, responsável e etiquetas. Status de CI e de deploy | mostrar e atualizar seus tickets | execução de contrato |
| Tokens de API e do MCP (só o hash) e eventos de uso desses tokens, guardados por 30 dias | acesso programático e auditoria | execução de contrato e legítimo interesse |

Tickets apagados na origem também são apagados no termhub, na sincronização seguinte.

### 3.6 Contas de IA

- **O que guardamos.** O nome que você dá à conta e a pasta de configuração dela na sua máquina. **Não guardamos tokens nem senhas das suas contas de IA.**
- **Como consultamos o uso.** Para mostrar o consumo e os limites, o agente lê a credencial de login da ferramenta na sua máquina e consulta o fornecedor dali mesmo. **A credencial nunca sai da sua máquina**: nosso servidor recebe só os números de uso, que mantém em memória.
  - Nas máquinas ligadas por SSH, o servidor executa na sua máquina um comando que lê a credencial e consulta o fornecedor ali; o servidor recebe só a resposta do fornecedor, sem a credencial.
  - Os fornecedores consultados são a Anthropic, a OpenAI/ChatGPT e o Google.
  - **Você pode desligar a consulta em cada máquina** (Máquinas › a máquina › "Consultar o uso das contas de IA"). Desligada, o termhub não lê a credencial e as contas dessa máquina ficam sem as barras de uso.
  - [Ver a nota.]

> Nota: o parecer sobre o item A-1 ainda está pendente.

- **Troca de conta.** Quando a troca automática de conta está ligada, o agente pode fazer a sessão continuar em outra conta Claude sua, na mesma máquina.

### 3.7 Aplicativo móvel

| Dado | Para quê | Base legal |
|---|---|---|
| E-mail informado ao pedir acesso. Guardamos só o hash dele no pedido | vincular o aparelho à sua conta | execução de contrato |
| Modelo, sistema operacional, nome do aparelho (o nome que você deu a ele, por exemplo "iPhone do Fulano"), versão do app e chave pública do aparelho | identificar e autorizar o aparelho | execução de contrato |
| IP, cidade e país aproximados do pedido de acesso e dos eventos de segurança: PIN errado, renovação de acesso, revogação | mostrar onde o pedido foi feito e proteger a conta | legítimo interesse (segurança) |
| Segredo do PIN (cifrado no servidor). A biometria é verificada só no aparelho e nunca chega até nós | proteger o acesso | execução de contrato |
| Token de notificações (Expo) | enviar notificações | execução de contrato |
| Histórico de notificações | mostrar a lista de avisos | execução de contrato |

- **O que vai nas notificações.** Levam só nomes de projeto, aba e máquina, como em "o projeto X precisa de você", e, num pedido de aparelho, o modelo e a cidade dele. **Nunca** levam o texto do terminal, do chat ou das respostas.
- **Atualizações.** O app busca atualizações num servidor de atualizações operado por [Engenharia Inversa / RAZÃO SOCIAL]. Nessa consulta, ele informa a plataforma, a versão e um identificador de instalação.

### 3.8 Lista de espera e site

| Dado | Para quê | Base legal |
|---|---|---|
| Nome, sobrenome, e-mail, telefone, LinkedIn e GitHub (estes dois opcionais) e idioma, enviados no formulário da lista de espera | convidar você para o Serviço e para a comunidade | consentimento (I) ou procedimentos preliminares a contrato (V) [definir] |
| Dados de navegação, com consentimento (seção 9) | medir o uso do site | consentimento (I) |

### 3.9 Registros técnicos (logs) e segurança

- **O que registramos.** Nossos servidores registram, para cada requisição, a data e a hora, o endereço IP, o método e o endereço acessado.
- **O que não registramos.** Os logs não guardam o conteúdo dos terminais, as senhas nem os cabeçalhos de autenticação.
- **Por quanto tempo.** Guardamos os registros de acesso por **6 meses**, como exige o Marco Civil da Internet (art. 15).
- **Base legal:** cumprimento de obrigação legal (II) e legítimo interesse (IX).

> Nota: hoje não há política de retenção de logs configurada. Ver o item P-6.

### 3.10 Pagamentos (quando os planos forem lançados)

- **O que guardamos.** Plano, status da assinatura, datas e histórico de cobranças, e os identificadores da assinatura no intermediador de pagamentos.
- **O que não guardamos.** **Não recebemos nem guardamos os dados completos do seu cartão.** Eles são tratados pelo intermediador de pagamentos.
- **Planos de parceiros.** Se o seu plano é concedido por um parceiro (seção 9.9 dos Termos), recebemos dele o seu e-mail e um identificador externo. Ao parceiro, informamos apenas se a concessão está ativa.
- **Base legal:** execução de contrato e cumprimento de obrigação legal (fiscal).

## 4. O que não fazemos

- Não vendemos nem alugamos dados pessoais.
- Não usamos o Seu Conteúdo para treinar modelos de IA, nem os nossos nem os de terceiros.
- Não gravamos o fluxo dos seus terminais.
- Não usamos uma conta de IA do termhub para processar o seu conteúdo. A IA roda com a sua conta.
- Não fazemos publicidade comportamental com o conteúdo do Serviço.

## 5. Inteligência artificial de terceiros

5.1. O termhub abre e acompanha ferramentas de IA de terceiros nas suas máquinas. Hoje são elas:
- **Claude Code** (Anthropic);
- **Codex** (OpenAI);
- **Cursor**;
- **Gemini** (Google).

O chat do termhub também usa o Claude Code, na sua máquina.

5.2. Essas ferramentas são operadas pelos fornecedores, **com a sua conta e segundo os termos e as políticas de privacidade deles**. O que elas recebem inclui:
- o que você e os agentes enviam a elas: prompts, código, conteúdo de terminal e mensagens do chat;
- o contexto que o termhub fornece ao chat: cards, memória e telas.

Cada fornecedor pode guardar esses dados e, dependendo do seu plano e das suas configurações, usá-los para treinar modelos. Confira as configurações de privacidade de cada fornecedor. Os links estão no anexo desta Política.

5.3. Respostas automáticas: se você ligar a opção, o termhub pode responder sozinho perguntas dos agentes com base na sua memória e no histórico das suas decisões. A decisão é tomada por regras e por similaridade de texto, e você pode desligar a opção a qualquer momento.

> Nota: avaliar se o art. 20 da LGPD (revisão de decisões automatizadas) se aplica. Ver o item L-7.

## 6. Com quem compartilhamos dados

Compartilhamos dados só com quem nos ajuda a prestar o Serviço (operadores) ou com quem você mandou o termhub se conectar:

| Quem | O quê | Por quê | Onde |
|---|---|---|---|
| **Cloudflare** | todo o tráfego do site e do app (IP, cabeçalhos, conteúdo em trânsito), e o e-mail das pessoas autorizadas no controle de acesso | rede, proteção contra ataques, túnel e controle de acesso | global / EUA |
| **Google** | login com o Google (e-mail, nome, foto) | autenticação, quando você escolhe | EUA |
| **Google (Firebase / Google Analytics)** | dados de navegação e de uso do app, identificadores do aparelho e, com o seu consentimento, o identificador de publicidade | métricas de uso e medição de anúncios | EUA |
| **Expo**, e por meio dela **Apple** (APNs) e **Google** (FCM) | token do aparelho e texto das notificações | entregar notificações | EUA |
| **Provedor de e-mail** [NOME] | seu e-mail e o conteúdo das mensagens: código de login, convites, avisos de aparelho | enviar e-mails do Serviço | [PAÍS] |
| **Anthropic, OpenAI e Google** | a credencial da sua conta de IA, enviada pela sua própria máquina direto ao fornecedor na consulta de uso; o termhub recebe só os números (seção 3.6) | mostrar consumo e limites | EUA |
| **GitHub, Linear, Atlassian (Jira)** | o token que você informou e as consultas e atualizações que você pediu | integrações que você ligou | EUA / outros |
| **Type to Access (77a.it)** | o endereço da sua cidade pública e o seu apelido | criar o link curto da cidade pública, quando você a publica | [PAÍS] |
| **Intermediador de pagamentos** [NOME], quando os planos forem lançados | dados de cobrança | processar pagamentos | [PAÍS] |
| **Parceiros** (planos concedidos por parceria) | se o e-mail indicado pelo parceiro tem concessão ativa | gerir o plano concedido | Brasil |

- **Autoridades.** Também podemos compartilhar dados com autoridades públicas, quando a lei ou uma ordem judicial exigir.
- **Reorganização da empresa.** Em caso de reorganização societária, os dados podem ser transferidos ao sucessor, que continuará vinculado a esta Política.
- **Infraestrutura.** O Serviço roda em [infraestrutura própria em PAÍS/ESTADO]. Banco de dados, transcrição de voz e cálculo de embeddings rodam nessa mesma infraestrutura.

> Nota: confirmar o provedor de SMTP de produção, o país do servidor, se haverá backup externo e onde ele ficará. Itens P-4, P-5 e P-7.

## 7. Transferência internacional

Alguns operadores ficam fora do Brasil, principalmente nos Estados Unidos: Cloudflare, Google, Expo, Apple e os fornecedores de IA e de integrações.

Essas transferências são feitas para executar o contrato com você ou a seu pedido (LGPD, art. 33, V e IX). Quando aplicável, usamos as cláusulas-padrão contratuais aprovadas pela ANPD (Resolução CD/ANPD nº 19/2024) ou outras garantias previstas em lei.

> Nota: validar com o advogado o enquadramento e a necessidade das cláusulas-padrão com cada operador. Item L-4.

## 8. Por quanto tempo guardamos

| Dado | Prazo |
|---|---|
| Conta, projetos, cards, notas, chat, memória, últimas respostas dos agentes, anexos enviados | enquanto a conta existir, ou até você apagá-los. Depois da exclusão da conta: até **[30] dias** para apagar dos sistemas ativos e até **[N] dias** dos backups |
| Sessões web | até 30 dias, ou até você sair |
| Códigos de login por e-mail | 10 minutos |
| Pedidos de acesso de aparelhos | 1 dia |
| Eventos de segurança dos aparelhos (IP, cidade, país) | 90 dias |
| Histórico de notificações | 30 dias |
| Eventos de uso dos tokens de API | 30 dias |
| Anexos não enviados | 24 horas |
| Áudio de ditado | não é guardado. O texto fica até 10 minutos em memória |
| Arquivos colados no terminal (na sua máquina) | 7 dias |
| Histórico de estados das abas | [definir. Hoje não é apagado] |
| Registros de acesso (logs) | 6 meses (Marco Civil, art. 15) |
| Registro de acesso de administradores a uma conta ("ver como") | 1 ano após o fim do acesso |
| Lista de espera | até o convite ou [12 meses], o que vier primeiro, ou até você pedir a exclusão |
| Dados de cobrança e fiscais | pelo prazo da legislação fiscal (em geral, 5 anos) |

> Nota: vários desses prazos ainda não estão implementados. Ver a seção "Lacunas no produto".

## 9. Cookies e tecnologias parecidas

### 9.1 Site e aplicativo web

| Cookie / armazenamento | Tipo | Para quê |
|---|---|---|
| Cookie de sessão (httpOnly, seguro) | necessário | manter você conectado |
| `termhub_csrf` | necessário | proteger contra ataques CSRF |
| Cookie temporário do login com o Google (10 minutos) | necessário | concluir o login |
| `termhub_view_as` | necessário (só administradores) | suporte |
| Cookies da Cloudflare | necessário | segurança e controle de acesso |
| `localStorage` com as suas preferências de interface e a sua escolha de cookies (`termhub:consent`) | necessário | lembrar as suas escolhas |
| `_ga`, `_ga_*` (Google Analytics) | **analítico, só com consentimento** | medir o uso do site e do app |

O Google Analytics só é carregado depois que você clica em "Aceitar" no aviso de cookies. Você pode mudar a escolha a qualquer momento em "Preferências de cookies" (no perfil do app ou no rodapé do site). Ao recusar, apagamos os cookies do Google Analytics.

O site carrega fontes do Google Fonts, o que envia o seu IP ao Google.

> Nota: TER-583 propõe hospedar as fontes no próprio site.

### 9.2 Aplicativo móvel

- **Métricas de uso (Google Analytics for Firebase).** Registramos as telas abertas, só o tipo de tela e nunca o conteúdo, e eventos automáticos de sessão. O Firebase associa esses dados a um identificador de instalação e ao IP, que dá a localização aproximada. [Definir: consentimento ou legítimo interesse; ver item L-5.]
- **Medição de anúncios.** Só com a sua permissão:
  - no iOS, pelo pedido de "Permitir rastreamento" (ATT);
  - no Android, pelo nosso próprio pedido.

  Com a permissão, o identificador de publicidade do aparelho (IDFA/GAID) é usado para medir quais anúncios trouxeram você ao termhub. Você pode desligar em Ajustes → Privacidade → "Medição de anúncios", ou nas configurações do sistema.
- **Permissões do aparelho.** O app pede microfone (ditado), câmera e fotos (anexos), biometria (atalho para o PIN) e notificações. Todas são opcionais, e você pode revogá-las nas configurações do sistema.

## 10. Segurança

- Todas as conexões usam criptografia (HTTPS/WSS).
- Senhas, tokens e códigos são guardados só como hash.
- Os tokens das integrações e o segredo do PIN são cifrados com AES-256-GCM.
- O aplicativo móvel usa chaves guardadas no hardware do aparelho e PIN.
- O agente usa uma conexão só de saída, e o servidor só pode pedir a ele um conjunto fechado de operações.
- O acesso de administradores do termhub aos dados de uma conta (função "ver como") é restrito a suporte, segurança e cumprimento de obrigação legal. Cada acesso fica registrado (quem, qual conta, início, fim e IP) por 1 ano.
- **Incidentes.** Se houver um incidente de segurança que possa trazer risco ou dano relevante a você, avisaremos você e a ANPD, nos termos da lei (art. 48 e Resolução CD/ANPD nº 15/2024).
- **Limite do que protegemos.** Nenhum sistema é totalmente seguro. Mantenha suas máquinas, contas e credenciais protegidas.

## 11. Seus direitos

Pela LGPD (art. 18), você pode pedir:
1. confirmação de que tratamos seus dados e acesso a eles;
2. correção de dados incompletos, inexatos ou desatualizados;
3. anonimização, bloqueio ou eliminação de dados desnecessários, excessivos ou tratados em desconformidade com a lei;
4. portabilidade dos seus dados;
5. eliminação dos dados tratados com base no consentimento;
6. informação sobre com quem compartilhamos seus dados;
7. informação sobre a possibilidade de não dar consentimento e suas consequências;
8. revogação do consentimento;
9. oposição a tratamento feito com base em outras hipóteses legais, quando houver descumprimento da lei;
10. revisão de decisões tomadas só com base em tratamento automatizado.

- **Como pedir.** Você pode exercer a maioria desses direitos no próprio Serviço: perfil, configurações, preferências de cookies e exclusão de itens e da conta. Também pode escrever para [privacidade@termhub.dev].
- **Prazo.** Respondemos em até **15 dias**. Podemos pedir informações para confirmar a sua identidade.
- **Reclamação.** Você também pode reclamar à Autoridade Nacional de Proteção de Dados (ANPD), em gov.br/anpd.

## 12. Exclusão da conta

12.1. Há três formas de excluir a sua conta:
- **no aplicativo móvel:** Ajustes → "Excluir minha conta";
- **no aplicativo web:** Perfil → "Excluir minha conta";
- **sem acesso ao app:** na página [termhub.dev/excluir-conta] ou pelo e-mail [privacidade@termhub.dev].

12.2. Ao excluir a conta, apagamos:
- os seus dados de conta;
- projetos, cards, notas, chat, memória, anexos e tokens de integração;
- máquinas e aparelhos;
- últimas respostas e histórico das abas.

O prazo é de até [30] dias, mais [N] dias para os backups. Mantemos só o que a lei obriga, como os registros de acesso (6 meses) e os dados fiscais. Avisamos você por e-mail quando a exclusão terminar.

12.3. A exclusão da conta não apaga nada nas suas máquinas, como o código, os arquivos e as transcrições locais das ferramentas de IA. Também não apaga os dados que você enviou aos fornecedores de IA e às integrações. Para remover o agente, siga [instruções de desinstalação].

> Nota: a exclusão pelo próprio usuário, com janela de 30 dias, e a página `termhub.dev/excluir-conta` foram entregues no PR #285 (TER-720). Conferir os caminhos das telas e os prazos com o que foi implementado antes de publicar. A exportação dos dados (P-10) ainda não existe.

## 13. Crianças e adolescentes

O Serviço não se destina a menores de 18 anos, e não coletamos de propósito dados de crianças ou adolescentes. Se soubermos que coletamos, apagaremos.

## 14. Mudanças nesta Política

Avisaremos as mudanças relevantes com pelo menos **30 dias** de antecedência, por e-mail e no Serviço. As versões anteriores ficam em [URL do histórico].

## 15. Contato

- Encarregado: [NOME], [privacidade@termhub.dev]
- [RAZÃO SOCIAL], [ENDEREÇO]

---

### Anexo: políticas dos fornecedores de IA e de integrações

- Anthropic: https://www.anthropic.com/legal/privacy · uso de dados do Claude Code: https://code.claude.com/docs/en/data-usage
- OpenAI: https://openai.com/policies/row-privacy-policy/
- Google (Gemini): https://policies.google.com/privacy
- Cursor: https://cursor.com/privacy
- GitHub: https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement
- Linear: https://linear.app/privacy
- Atlassian (Jira): https://www.atlassian.com/legal/privacy-policy
