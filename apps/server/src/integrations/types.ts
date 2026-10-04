export type IntegrationProvider = 'github' | 'linear' | 'jira';
export type KanbanStatus = 'backlog' | 'todo' | 'doing' | 'done';

/** Caps how many tickets a single source contributes to one sync/list call. */
export const MAX_TICKETS_PER_SOURCE = 500;

/** Ticket normalizado vindo de Linear/Jira/GitHub. */
export interface ExternalTicket {
  /** stable key: linear:<id> | jira:<KEY> | github:<owner/repo>#<n> */
  sync_key: string;
  provider: IntegrationProvider;
  provider_id: string;
  /** what people type: EI-123, PROJ-45, owner/repo#12 */
  key: string;
  title: string;
  description: string | null;
  url: string;
  /** estado bruto do provedor */
  state: string;
  /** mapeado para o kanban */
  status: KanbanStatus;
  updatedAt: string;
  /** dados extras do provedor (prioridade, labels, assignee...) */
  meta?: Record<string, unknown>;
}

export interface ConnectionInfo {
  ok: boolean;
  /** quem está autenticado (login/e-mail) */
  account?: string;
  /** opções descobertas (times do Linear, projetos do Jira, ...) para preencher o setup */
  options?: Record<string, { id: string; name: string }[]>;
  error?: string;
}

/** Configuração da fonte de tickets em um projeto (vem do ProjectSetup.tickets). */
export interface TicketSourceConfig {
  provider: IntegrationProvider;
  integration_id: string;
  /** Linear: team key/ID; Jira: project key; GitHub: owner/repo */
  scope: string;
  /** filtro extra: Linear = nomes de estados; Jira = JQL adicional; GitHub = labels */
  filter?: string | null;
}

/** One page of tickets from a source, capped at MAX_TICKETS_PER_SOURCE. */
export interface TicketPage {
  tickets: ExternalTicket[];
  /** true when the source has more tickets than the cap allowed us to fetch */
  truncated: boolean;
}

export interface TicketProvider {
  provider: IntegrationProvider;
  /** valida credenciais e devolve opções para o setup */
  testConnection(secret: string, config: Record<string, unknown>): Promise<ConnectionInfo>;
  /** lista tickets abertos do escopo configurado, paginando até MAX_TICKETS_PER_SOURCE */
  listTickets(secret: string, config: Record<string, unknown>, source: TicketSourceConfig): Promise<TicketPage>;
  /**
   * One ticket, whatever its state: what the sync asks about an imported ticket that stopped
   * coming back from its source (TER-718). Throws when the provider does not answer it.
   */
  getTicket(secret: string, config: Record<string, unknown>, ticket: { provider_id: string; key: string; scope: string }): Promise<ExternalTicket>;
  /**
   * Atualiza o estado do ticket no provedor para refletir a coluna do kanban.
   * Só é chamado por ação explícita do usuário. Devolve o novo estado bruto.
   */
  updateStatus(secret: string, config: Record<string, unknown>, ticket: { provider_id: string; key: string; scope: string }, status: KanbanStatus): Promise<string>;
}
