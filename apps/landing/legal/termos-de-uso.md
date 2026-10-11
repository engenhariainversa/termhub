# Termos de Uso do termhub

> **RASCUNHO PARA REVISÃO JURÍDICA (TER-702). Não publicar.**
> Este texto foi escrito a partir do estudo em [`comparativo.md`](comparativo.md) e do que o código do termhub faz hoje (outubro de 2026). Não substitui o parecer do advogado. Trechos entre colchetes (`[...]`) são dados que faltam ou decisões em aberto, listados em [`duvidas-advogado.md`](duvidas-advogado.md). Notas para a revisão aparecem em blocos `> Nota:` e saem da versão publicada.

**Versão:** [v1, data de publicação]
**Vigência:** [data]

---

## 1. Quem somos e o que estes Termos regulam

1.1. O termhub é um serviço oferecido por **[RAZÃO SOCIAL]**, inscrita no CNPJ sob o nº [CNPJ], com sede em [ENDEREÇO] ("**termhub**", "**nós**").

1.2. Estes Termos de Uso ("**Termos**") regulam o uso do serviço hospedado pelo termhub, que inclui:
- o aplicativo web em `app.termhub.dev`;
- os aplicativos móveis para iOS e Android;
- o agente instalado nas máquinas (`@termhub/agent`);
- a API e o servidor MCP;
- o site `termhub.dev`.

Juntos, eles formam o "**Serviço**".

1.3. A [Política de Privacidade](politica-de-privacidade.md) faz parte destes Termos. Ela explica quais dados pessoais tratamos e como.

1.4. O código-fonte do termhub é aberto, sob a licença MIT. Quem instala e opera a própria cópia do termhub ("auto-hospedagem") usa o software nos termos da licença MIT, e não destes Termos. Nesse caso, é o próprio operador quem responde pelos dados que a cópia dele trata.

> Nota: confirmar com o advogado se a separação entre "software aberto (MIT)" e "serviço hospedado" fica clara assim, e se é preciso dizer algo sobre marcas.

## 2. Aceite e quem pode usar

2.1. Ao criar uma conta, você declara que leu e aceita estes Termos e a Política de Privacidade. O mesmo vale ao aceitar um convite, ao contratar um plano ou ao usar o Serviço. Guardamos a versão aceita e a data do aceite.

2.2. Para usar o Serviço, você precisa ter **18 anos ou mais** e capacidade civil plena. O Serviço é uma ferramenta profissional, e não se destina a crianças nem a adolescentes.

2.3. Ao usar o Serviço em nome de uma empresa ou de outra pessoa jurídica, você declara que tem poderes para aceitar estes Termos em nome dela. Nesse caso, "você" passa a incluir também essa pessoa jurídica.

## 3. Como o termhub funciona

Pedimos que você leia esta seção com atenção: ela explica o que o Serviço faz nas suas máquinas.

3.1. **Agente na sua máquina.** Para controlar um computador pelo termhub, você instala o agente do termhub nele.
- O agente roda com o seu usuário do sistema operacional e abre uma conexão de saída com o nosso servidor.
- Por essa conexão, ele transmite os terminais que você abre pelo termhub, em tempo real, e recebe o que você digita.
- Ele também executa, a seu pedido, um conjunto fechado de operações: listar pastas, ler dados de hardware, instalar ou atualizar o próprio agente e instalar os "hooks" de monitoramento das ferramentas de IA, entre outras.

3.2. **Máquinas por SSH.** Também é possível ligar uma máquina sem agente, por SSH.
- Nesse caso, você autoriza na sua máquina uma chave pública do servidor do termhub.
- O servidor então executa comandos nela pela conexão SSH.

3.3. **Conteúdo que passa pelo termhub.** O conteúdo dos terminais e as respostas dos agentes de IA passam pelos nossos servidores para chegar ao seu navegador ou ao seu celular.
- Não gravamos o fluxo contínuo do terminal.
- Guardamos algumas informações para que o Serviço funcione: a última resposta de cada agente, as perguntas e os pedidos de permissão que os agentes fazem, as mensagens do chat e os cards, as notas e a memória dos projetos.
- A Política de Privacidade descreve o que guardamos e por quanto tempo.

3.4. **Agentes de IA e chat.** O termhub abre e acompanha ferramentas de IA de terceiros nas suas máquinas, como Claude Code, Codex e Cursor.
- O chat do termhub (o "concierge") também roda na sua máquina, usando a sua conta de IA.
- O termhub não fornece modelos de IA e não usa conta de IA própria para atender você.

3.5. **Memória.** O termhub guarda decisões, mensagens do chat, cards e documentos dos seus projetos para sugerir respostas e dar contexto aos agentes.
- Com a sua configuração, ele pode também responder automaticamente perguntas dos agentes, com base nessa memória.
- Você pode apagar itens da memória.

## 4. Sua conta

4.1. Você deve informar dados verdadeiros e manter seu e-mail atualizado. O e-mail é o canal oficial das nossas comunicações com você.

4.2. Você é responsável por manter em sigilo o que dá acesso à sua conta: senha, códigos de login, PIN do aplicativo, aparelhos aprovados, tokens de API e tokens das máquinas. Também responde pelo que for feito com eles.
- Se perder um aparelho ou desconfiar de acesso indevido, revogue o aparelho ou o token na área de configurações e nos avise.

4.3. Cada conta é pessoal. Não compartilhe a sua conta com outras pessoas. [Se houver planos para equipes, descrever aqui como funcionam os membros.]

## 5. Suas contas de IA e serviços de terceiros

5.1. As contas de IA que você usa com o termhub são suas: Anthropic (Claude), OpenAI (Codex/ChatGPT), Google (Gemini), Cursor e outras. O uso delas é regido pelos termos e pelas políticas desses fornecedores, e não por estes Termos.
- Cabe a você verificar se o seu plano com cada fornecedor permite o uso que você faz pelo termhub e cumprir esses termos.
- Isso inclui eventuais regras sobre uso automatizado, compartilhamento de conta e limites de uso.

5.2. O termhub não é afiliado à Anthropic, à OpenAI, ao Google, à Cursor, ao GitHub, à Atlassian ou à Linear, nem é endossado por elas. Os nomes e as marcas citados pertencem aos seus titulares.

5.3. Para mostrar o consumo e os limites das suas contas de IA, o agente lê na sua máquina a credencial de login da ferramenta e a envia ao servidor do termhub.
- O servidor usa essa credencial só para consultar o uso junto ao fornecedor e não a armazena.
- Você pode deixar de usar esse recurso [como desligar].

> Nota: **ponto crítico.** A página de compliance do Claude Code proíbe terceiros de "collect, store, or intermediate Claude.ai credentials or session tokens". O termhub não armazena a credencial, mas ela trafega pelo servidor. A recomendação técnica é mover a consulta de uso para o próprio agente, de modo que a credencial nunca saia da máquina, e então reescrever esta cláusula como "a credencial nunca sai da sua máquina". Também não existe hoje uma opção para desligar esse recurso. Ver `duvidas-advogado.md`, itens A-1 e P-8.

5.4. O que você envia a um fornecedor de IA pela sua conta, como prompts, código e conteúdo de terminal, é tratado por esse fornecedor segundo os termos dele. Isso inclui o uso para treinar modelos, quando o seu plano permitir. Não controlamos esse tratamento.

5.5. **Integrações.** Ao ligar uma integração (GitHub, Linear, Jira ou outras), você nos autoriza a usar o token informado para ler e atualizar os dados que o recurso usa, como issues, tickets, pull requests e status de CI, sempre em seu nome. Você pode remover a integração a qualquer momento.

## 6. Suas máquinas e o que os agentes fazem nelas

6.1. Você só pode ligar ao termhub máquinas que lhe pertencem ou que você tem autorização para administrar. Isso inclui instalar o agente, executar comandos e deixar agentes de IA agirem nelas.

6.2. Comandos digitados por você, executados por agentes de IA ou disparados pelo chat do termhub rodam **na sua máquina, com as permissões do seu usuário**.
- Agentes de IA agem com autonomia, podem errar e podem executar comandos que apagam, alteram ou publicam dados.
- Também podem gerar custos com terceiros, por exemplo em nuvem, APIs e lojas de aplicativos.
- **Você é o único responsável** por revisar o que os agentes fazem, pelas permissões que concede a eles e às ferramentas, pelas confirmações que aprova no termhub e pelas consequências dos comandos executados nas suas máquinas.

6.3. Os recursos de confirmação do termhub ajudam você a acompanhar o que os agentes fazem. São eles: os cartões de confirmação do chat, as ações liberadas por padrão e as respostas automáticas.
- Esses recursos não garantem que um comando seja seguro.
- Ações que você configurar para rodar sem confirmação, como as respostas automáticas a perguntas, são executadas sob a sua responsabilidade.

6.4. O agente do termhub altera arquivos de configuração na sua máquina para funcionar, como os hooks em `~/.claude`, `~/.codex` e `~/.cursor` e a pasta `~/.termhub`. Ele também pode instalar dependências, como o tmux, quando você pede. A remoção do agente desfaz [o que for documentado].

6.5. Mantenha cópias de segurança dos seus dados. O termhub não faz backup das suas máquinas nem do seu código.

## 7. Uso aceitável

7.1. Você se compromete a não usar o Serviço, nem permitir que outras pessoas usem, para:
1. acessar, controlar ou monitorar máquinas, contas ou redes sem autorização do titular;
2. atacar ou testar a segurança de sistemas de terceiros sem autorização por escrito, incluindo varreduras, negação de serviço, força bruta e exploração de vulnerabilidades;
3. criar, distribuir ou operar malware, botnets, ransomware, phishing ou infraestrutura de comando e controle;
4. minerar criptomoedas em máquinas de terceiros ou em qualquer infraestrutura do termhub;
5. enviar spam ou fazer raspagem abusiva de dados pessoais;
6. armazenar ou transmitir conteúdo ilegal, que viole direitos de terceiros ou que explore crianças e adolescentes;
7. contornar limites do plano, criar várias contas para ganhar períodos de teste ou benefícios, ou revender o acesso ao Serviço sem autorização;
8. sobrecarregar, interferir ou tentar burlar a segurança, a autenticação ou os limites do Serviço, inclusive do servidor MCP e da API;
9. descompilar ou fazer engenharia reversa do Serviço hospedado com o fim de atacá-lo. O código aberto continua disponível sob a licença MIT;
10. violar os termos dos fornecedores de IA ou das integrações que você usa pelo termhub.

7.2. A **cidade pública** e outros recursos de publicação mostram a qualquer pessoa os dados dos projetos que você escolher tornar públicos. Você responde pelo que publicar.

## 8. Seu conteúdo e propriedade intelectual

8.1. **O seu código, os seus dados e o seu conteúdo são seus.** Isso inclui o que você digita, os arquivos que anexa, os cards, as notas, as mensagens do chat e as respostas que os agentes de IA produzem para você ("**Seu Conteúdo**"). O termhub não reivindica propriedade sobre o Seu Conteúdo.

8.2. Para prestar o Serviço, você nos concede uma licença limitada, não exclusiva, gratuita e restrita ao tempo de uso para armazenar, copiar, processar, transmitir e exibir o Seu Conteúdo. Ela vale **só para operar, proteger e dar suporte ao Serviço para você**. A licença termina quando o Seu Conteúdo é apagado, salvo o que precisarmos guardar por lei.

8.3. **Não usamos o Seu Conteúdo para treinar modelos de IA** e não o vendemos.

8.4. O termhub, a marca, o site, os aplicativos e o Serviço hospedado pertencem a [RAZÃO SOCIAL]. O código-fonte aberto segue a licença MIT.

8.5. Se você nos mandar sugestões ou feedback, podemos usá-los para melhorar o Serviço, sem obrigação de pagamento. Isso não transfere a propriedade do Seu Conteúdo.

## 9. Planos, período de teste e pagamento

> Nota: os planos ainda não foram lançados. Esta seção é genérica de propósito. Valores, limites e prazos ficam na página de preços e no checkout. Pontos concretos em `duvidas-advogado.md`, seção "Assinaturas".

9.1. **Planos.** O Serviço pode ser oferecido em planos pagos e em um período ou nível de teste com limites de uso. Os recursos, os limites e o preço de cada plano estão na página de preços e são mostrados antes da contratação.

9.2. **Teste.** O período ou nível de teste pode ter limites, como de projetos, máquinas, terminais abertos ou acesso ao chat, e pode ter prazo. Avisaremos antes de qualquer cobrança. Nenhuma cobrança será feita sem que você contrate um plano.

9.3. **Renovação automática.** Planos pagos são renovados automaticamente ao fim de cada período, mensal ou outro informado na contratação, pelo mesmo meio de pagamento, até que você cancele.

9.4. **Cancelamento.** Você pode cancelar a qualquer momento nas configurações da conta.
- O cancelamento impede a próxima renovação, e o plano continua ativo até o fim do período já pago.
- [Definir se haverá reembolso proporcional em algum caso.]

9.5. **Direito de arrependimento.** Na contratação pela internet, você pode desistir em até **7 (sete) dias** contados da contratação, com devolução integral do valor pago, nos termos do art. 49 do Código de Defesa do Consumidor.

9.6. **Pagamento por terceiro.**
- Os pagamentos são processados por um intermediador de pagamentos contratado pelo termhub, que pode usar outros provedores (gateways) para isso.
- O termhub não recebe nem guarda os dados completos do seu cartão.
- O intermediador pode ter termos próprios, que serão apresentados no checkout.

9.7. **Falta de pagamento.** Se um pagamento falhar, avisaremos você e poderemos tentar a cobrança de novo.
- Se a pendência continuar depois de [N] dias de carência, o acesso aos recursos pagos pode ser suspenso até a regularização.
- O Seu Conteúdo não é apagado por falta de pagamento antes de [prazo] e de aviso prévio.

9.8. **Mudança de preço.** Avisaremos qualquer aumento de preço com pelo menos **30 dias** de antecedência, por e-mail e no Serviço.
- O novo preço vale a partir da renovação seguinte ao aviso.
- Se não concordar, você pode cancelar antes dela.

9.9. **Planos concedidos por parceiros.** Um plano pode ser concedido por um parceiro do termhub, como uma escola ou empresa, ao e-mail que ele informar.
- Enquanto a parceria e o seu vínculo com o parceiro estiverem ativos, o plano fica disponível sem cobrança do termhub.
- Quando a concessão termina, avisaremos você. Depois de [N] dias, a conta volta ao nível gratuito ou de teste, a menos que você contrate um plano.
- O Seu Conteúdo é mantido.
- O parceiro fica sabendo apenas se o e-mail informado tem conta ativa no termhub.

9.10. **Tributos e nota fiscal.** Os preços incluem [ou não incluem] os tributos. A nota fiscal é emitida por [termhub ou intermediador].

## 10. Disponibilidade, mudanças no Serviço e versões de teste

10.1. Trabalhamos para manter o Serviço disponível, mas não garantimos funcionamento ininterrupto ou livre de erros.
- Pode haver manutenção, atualizações e falhas de terceiros, como provedores de internet, Cloudflare, lojas de aplicativos e fornecedores de IA.
- Ao atualizar o servidor, os terminais podem se reconectar por alguns instantes.

10.2. Podemos mudar, adicionar ou remover recursos. Se a mudança reduzir de forma relevante um recurso de um plano pago, avisaremos com antecedência razoável. Se você não concordar, poderá cancelar [com reembolso proporcional].

10.3. Recursos marcados como "beta", "alpha", "experimental" ou parecidos podem mudar ou ser removidos sem aviso e são oferecidos no estado em que se encontram.

10.4. **Atualização do agente.** O agente pode ser atualizado automaticamente, quando você liga essa opção, ou pelo botão de atualização. Versões muito antigas podem deixar de funcionar com o Serviço.

## 11. Suspensão e encerramento

11.1. Você pode encerrar sua conta a qualquer momento, pelo aplicativo, pelo site ou pelo e-mail [contato]. Os efeitos do encerramento sobre os seus dados estão na Política de Privacidade.

11.2. Podemos suspender ou limitar o acesso à sua conta, no todo ou em parte, nos seguintes casos:
- violação destes Termos, em especial da seção 7;
- risco à segurança do Serviço, de outros usuários ou de terceiros;
- ordem de autoridade competente;
- falta de pagamento, nos termos da cláusula 9.7.

11.3. Sempre que possível, avisaremos antes, com o motivo, e daremos prazo para correção. Em casos graves ou urgentes, como ataque em andamento, malware ou ordem judicial, a suspensão pode ser imediata, com aviso logo em seguida.

11.4. Você pode contestar uma suspensão pelo e-mail [contato]. Responderemos em até [N] dias úteis.

11.5. Podemos encerrar contas gratuitas ou de teste sem uso por mais de [12 meses], com aviso prévio de [30 dias] por e-mail.

11.6. Com o encerramento, você pode pedir uma cópia dos seus dados por [prazo], conforme a Política de Privacidade.

## 12. Responsabilidade

12.1. O termhub responde pelos danos que causar na prestação do Serviço, nos termos da lei.

12.2. O termhub **não** responde por:
1. comandos e ações executados nas suas máquinas, digitados por você ou feitos pelos agentes de IA que você usa, nem pelas confirmações que você aprova (seção 6);
2. o conteúdo gerado por modelos de IA de terceiros, que pode ser incorreto, incompleto ou inseguro e deve ser revisado por você;
3. falhas, indisponibilidade, mudanças de preço ou de regras e bloqueios de conta por parte dos fornecedores de IA, das integrações e de outros serviços de terceiros que você usa;
4. perda de dados nas suas máquinas ou no seu código causada por ação sua ou de agentes. Mantenha backups;
5. uso da sua conta por terceiros com credenciais que você deixou de proteger;
6. danos indiretos, como lucros cessantes e perda de oportunidade, quando o uso do Serviço for profissional, na extensão permitida pela lei.

12.3. Quando o uso for profissional e não houver relação de consumo, a responsabilidade total do termhub fica limitada ao maior entre: (a) o valor pago por você nos 12 meses anteriores ao fato; e (b) [R$ X]. A limitação não vale para dolo ou culpa grave.

> Nota: limitações de responsabilidade são frágeis diante do CDC (arts. 25 e 51, I). Ver `duvidas-advogado.md`, item J-4, sobre consumidor x profissional.

12.4. Se o seu uso do Serviço violar estes Termos ou direitos de terceiros e isso gerar reclamação contra o termhub, você se compromete a nos ressarcir pelos prejuízos comprovados, na extensão permitida pela lei.

## 13. Alterações destes Termos

13.1. Podemos alterar estes Termos. Avisaremos as mudanças relevantes com pelo menos **30 dias** de antecedência, por e-mail e no Serviço.
- Mudanças exigidas por lei ou por segurança podem valer antes, com aviso.

13.2. Se você não concordar com a nova versão, pode encerrar a conta antes de ela entrar em vigor. Se a mudança for relevante, pediremos um novo aceite.

13.3. As versões anteriores ficam disponíveis em [URL do histórico].

## 14. Comunicações

14.1. Usamos o seu e-mail e as notificações do Serviço para avisos sobre a conta, segurança, cobrança e mudanças nestes Termos. Mensagens de marketing só serão enviadas com o seu consentimento, e você pode cancelá-las a qualquer momento.

## 15. Lei aplicável e foro

15.1. Estes Termos são regidos pelas leis da República Federativa do Brasil, em especial o Código de Defesa do Consumidor, o Marco Civil da Internet e a Lei Geral de Proteção de Dados (LGPD).

15.2. Se você for consumidor, fica eleito o foro do seu domicílio. Nos demais casos, fica eleito o foro da comarca de [Goiânia/GO], com renúncia a qualquer outro.

15.3. Antes de recorrer à Justiça, pedimos que você nos procure em [contato]. Você também pode registrar reclamação no consumidor.gov.br.

## 16. Disposições gerais

16.1. Se alguma cláusula for considerada inválida, as demais continuam valendo.

16.2. A tolerância com o descumprimento de uma cláusula não significa renúncia ao direito de exigi-la.

16.3. Você não pode transferir sua conta ou estes Termos sem a nossa concordância. Podemos transferi-los em caso de reorganização societária, venda ou incorporação do Serviço, com aviso prévio a você.

## 17. Contato

- E-mail: [contato@termhub.dev]
- Encarregado de proteção de dados: ver a Política de Privacidade.
- Endereço: [ENDEREÇO]
