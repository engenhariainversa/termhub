import type { AccessStatus, ApiToken, ApiTokenScope, ChatAction, ChatActionStatus, ChatConversation, ChatGrant, ChatHostState, ChatMessage, CityLink, CreatedApiToken, InviteResult, ViewAs, OfficeCity, PermissionAction, ResourcePermissions, Role, WaitlistEntry, HardwareSnapshot, AiAccount, AiAccountUsage, AiProvider, AuthConfig, ConnectionInfo, DashboardItem, FsListing, Integration, IntegrationProvider, Machine, MachineHooks, MachineType, MonitorItem, Note, Project, ProjectGroup, ProjectInput, ProjectMachineLink, ProjectChatStatus, ProjectSetup, ProjectSetupData, Simulator, Tab, TabEvent, TabKind, Task, Transcription, BoardData, ColumnCategory, MoveTarget, TaskColumn, TaskCreateInput, TaskPatchInput, UploadEntry, UploadMachineStatus, Ticket, User, WdaSetupState, WaitlistInviteResult, Device, DeviceEventView, DeviceRequestView, DevicesSummary } from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public issues?: unknown,
  ) {
    super(message);
  }
}

export function readCookie(name: string): string | undefined {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : undefined;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const raw = body instanceof Blob;
  if (raw) headers['content-type'] = body.type || 'application/octet-stream';
  else if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD') {
    const csrf = readCookie('termhub_csrf');
    if (csrf) headers['x-csrf-token'] = csrf;
  }
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) throw errorFrom(res.status, data);
  return data as T;
}

function errorFrom(status: number, data: unknown): ApiError {
  const d = (data ?? {}) as { error?: string; code?: string; issues?: unknown };
  if (status === 401) window.dispatchEvent(new CustomEvent('termhub:unauthorized'));
  return new ApiError(status, d.error ?? `Erro ${status}`, d.code, d.issues);
}

/**
 * POST of a binary body with upload progress (fetch has none): used for dictation clips, whose upload
 * on a slow uplink is long enough to deserve a percentage. Same cookies/CSRF/error shape as request().
 */
function upload<T>(path: string, body: Blob, onProgress?: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api${path}`);
    xhr.withCredentials = true;
    xhr.responseType = 'text';
    xhr.setRequestHeader('accept', 'application/json');
    xhr.setRequestHeader('content-type', body.type || 'application/octet-stream');
    const csrf = readCookie('termhub_csrf');
    if (csrf) xhr.setRequestHeader('x-csrf-token', csrf);
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && onProgress) onProgress(ev.loaded / ev.total);
    };
    xhr.onerror = () => reject(new ApiError(0, 'Sem conexão com o servidor', 'NETWORK'));
    xhr.onabort = () => reject(new ApiError(0, 'Envio cancelado', 'ABORTED'));
    xhr.onload = () => {
      let data: unknown = null;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else reject(errorFrom(xhr.status, data));
    };
    xhr.send(body);
  });
}

export const api = {
  auth: {
    config: () => request<AuthConfig>('GET', '/auth/config'),
    me: () => request<{ user: User; view_as: ViewAs }>('GET', '/auth/me'),
    /** admin only: null = self, '*' = everything, or a user id */
    viewAs: (user_id: string | null) => request<{ view_as: ViewAs }>('POST', '/auth/view-as', { user_id }),
    login: (email: string, password: string) => request<{ user: User }>('POST', '/auth/login', { email, password }),
    sendCode: (email: string) => request<{ ok: true; ttl_minutes: number }>('POST', '/auth/code/send', { email }),
    verifyCode: (email: string, code: string) => request<{ user: User }>('POST', '/auth/code/verify', { email, code }),
    logout: () => request<{ ok: true }>('POST', '/auth/logout'),
    /** Claims the address of the user's public city. 400 NICKNAME_INVALID for a bad shape or a
     *  reserved word, 409 NICKNAME_TAKEN when somebody else already holds it, 409 NICKNAME_LOCKED
     *  when the account already has one (a claimed address is never changed). */
    setNickname: (nickname: string) => request<{ user: User }>('PATCH', '/auth/me/nickname', { nickname }),
    /** The city address and its short link. May create the partner link on the way (the server rate-limits that). */
    cityLink: () => request<CityLink>('GET', '/auth/me/city-link'),
    /** 400 SHORT_LINK_INVALID, 400 SHORT_LINK_MISMATCH (the message says where the link really goes), 502 SHORT_LINK_UNREACHABLE */
    setCustomCityLink: (short_url: string) => request<CityLink>('PUT', '/auth/me/city-link', { short_url }),
    /** back to the partner link */
    clearCustomCityLink: () => request<CityLink>('DELETE', '/auth/me/city-link/custom'),
  },
  machines: {
    list: () => request<{ machines: Machine[]; latest_agent_version: string | null }>('GET', '/machines'),
    /** for `type: 'agent'`, the response also carries `agent_token` (the plaintext token, shown only once) */
    create: (input: Partial<Machine>) => request<{ machine: Machine; agent_token?: string }>('POST', '/machines', input),
    update: (id: string, input: Partial<Machine>) => request<{ machine: Machine }>('PATCH', `/machines/${id}`, input),
    remove: (id: string) => request<{ ok: true }>('DELETE', `/machines/${id}`),
    status: (id: string) =>
      request<{
        id: string;
        online: boolean;
        tmux: boolean;
        os: string | null;
        capabilities: string[];
        agent_version?: string | null;
        last_seen_at?: string | null;
        latest_agent_version?: string | null;
        update_available?: boolean;
      }>('GET', `/machines/${id}/status`),
    /** installs the latest @termhub/agent through the agent; `restarting` = poll the status until the version changes */
    updateAgent: (id: string) => request<{ installed_version: string | null; restart: 'service' | 'manual'; restarting: boolean }>('POST', `/machines/${id}/agent/update`, {}),
    /** issues a new agent token, invalidating the previous one */
    rotateAgentToken: (id: string) => request<{ agent_token: string }>('POST', `/machines/${id}/agent-token`, {}),
    simulators: (id: string) => request<{ simulators: Simulator[] }>('GET', `/machines/${id}/simulators`),
    wdaSetup: (id: string) => request<WdaSetupState>('GET', `/machines/${id}/simulator/setup`),
    hooks: (id: string) => request<MachineHooks>('GET', `/machines/${id}/hooks`),
    installHooks: (id: string) => request<MachineHooks & { claude: 'installed' | 'skipped'; codex: 'installed' | 'skipped'; cursor?: 'installed' | 'skipped' | 'agent_outdated'; claude_dirs?: string[] }>('POST', `/machines/${id}/hooks`),
    removeHooks: (id: string) => request<{ ok: true }>('DELETE', `/machines/${id}/hooks`),
    startWdaSetup: (id: string) => request<{ ok: true }>('POST', `/machines/${id}/simulator/setup`, {}),
    /** subpastas de `path` (padrão $HOME) + discos/mounts da máquina */
    hardware: (id: string) => request<{ hardware: HardwareSnapshot }>('GET', `/machines/${id}/hardware`),
    mkdir: (id: string, parent: string, name: string) => request<{ path: string }>('POST', `/machines/${id}/fs/mkdir`, { parent, name }),
    browse: (id: string, path?: string) => request<FsListing>('GET', `/machines/${id}/fs${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  },
  projects: {
    list: () => request<{ projects: Project[] }>('GET', '/projects'),
    get: (id: string) => request<{ project: Project }>('GET', `/projects/${id}`),
    keyAvailable: (key: string) => request<{ available: boolean; reason?: 'invalid' | 'taken' }>('GET', `/projects/key-available?key=${encodeURIComponent(key)}`),
    create: (input: ProjectInput) => request<{ project: Project }>('POST', '/projects', input),
    /** `input.is_public: true` publishes the project's rooms to the owner's public city; refused with
     *  403 NOT_OWNER (not the project's owner), 409 PROJECT_UNOWNED (no owner at all) or 409
     *  NICKNAME_REQUIRED (the owner has not claimed a nickname yet). */
    update: (id: string, input: ProjectInput) => request<{ project: Project }>('PATCH', `/projects/${id}`, input),
    remove: (id: string) => request<{ ok: true }>('DELETE', `/projects/${id}`),
    machines: (id: string) => request<{ machines: Array<ProjectMachineLink & { machine: { id: string; name: string; type: MachineType } }> }>('GET', `/projects/${id}/machines`),
    linkMachine: (id: string, input: { machine_id: string; cwd: string; create_dir?: boolean }) => request<{ link: ProjectMachineLink }>('POST', `/projects/${id}/machines`, input),
    updateMachine: (id: string, machineId: string, input: { cwd: string; create_dir?: boolean }) => request<{ link: ProjectMachineLink }>('PATCH', `/projects/${id}/machines/${machineId}`, input),
    unlinkMachine: (id: string, machineId: string) => request<{ ok: true; closed_tabs: number }>('DELETE', `/projects/${id}/machines/${machineId}`),
    tabs: (id: string) => request<{ reachable: boolean; tabs: Tab[] }>('GET', `/projects/${id}/tabs`),
    createTab: (id: string, input: { name?: string; kind?: TabKind; simulator_udid?: string; machine_id?: string } = {}) =>
      request<{ tab: Tab }>('POST', `/projects/${id}/tabs`, input),
  },
  projectGroups: {
    list: () => request<{ groups: ProjectGroup[] }>('GET', '/project-groups'),
    create: (name: string) => request<{ group: ProjectGroup }>('POST', '/project-groups', { name }),
    rename: (id: string, name: string) => request<{ group: ProjectGroup }>('PATCH', `/project-groups/${id}`, { name }),
    remove: (id: string) => request<void>('DELETE', `/project-groups/${id}`),
    reorder: (ids: string[]) => request<{ groups: ProjectGroup[] }>('PUT', '/project-groups/order', { ids }),
    setMemberships: (groups: { id: string; project_ids: string[] }[]) => request<{ groups: ProjectGroup[] }>('PUT', '/project-groups/memberships', { groups }),
  },
  dashboard: () => request<{ items: DashboardItem[] }>('GET', '/dashboard'),
  office: (fresh = false) => request<OfficeCity>('GET', `/office${fresh ? '?fresh=1' : ''}`),
  /** The active conversation of a scope: no project = the account-wide chat (`/chat`); a project id =
   * that project's own chat (404 when it is not the signed-in user's). `actions` is the trail as it
   * truly is server-side (survives a reload); live socket events only update it, they are never its
   * source of truth. `grants` is optional: an older server that predates trusted tabs has none. */
  chat: (projectId?: string | null) =>
    request<{ conversation: ChatConversation; messages: ChatMessage[]; actions: ChatAction[]; host: ChatHostState; grants?: ChatGrant[] }>('GET', projectId ? `/chat?project=${encodeURIComponent(projectId)}` : '/chat'),
  /**
   * Chooses the machine that runs the conversation, and which of its Claude accounts (no account =
   * that machine's own default login). Both halves of the pair travel here, in one call: the chat's
   * host picker (`ChatHost`) is the only place either can be set — "Contas de IA" registers a
   * machine's logins and cannot choose the chat's.
   *
   * Answers with the freshly resolved host, so the screen needs no second read. 404 for a machine that
   * is not this user's (or an account that is not on it — the chat is always the signed-in user's own,
   * never the one an admin is "viewing as"), 400 for a machine with no termhub agent, and 400 for an
   * account of another provider. The CLI session starts over only when the pair really moved — the
   * server decides that; the warning before the move is the screen's.
   */
  setChatHost: (machineId: string, aiAccountId?: string | null) =>
    request<{ conversation: ChatConversation; host: ChatHostState }>('POST', '/chat/host', { machine_id: machineId, ai_account_id: aiAccountId ?? null }),
  /** 400 for empty/over-8000-char text; 409 CHAT_BUSY (its pt-BR message shown as-is) while a previous
   *  answer is still running; 409 CHAT_NO_MACHINE / CHAT_HOST_NOT_CHOSEN / CHAT_HOST_OFFLINE /
   *  CHAT_AGENT_TOO_OLD when the host cannot run it (each with its own pt-BR sentence) */
  sendChatMessage: (text: string, projectId?: string | null) => request<{ message: ChatMessage }>('POST', '/chat/messages', projectId ? { text, project_id: projectId } : { text }),
  /** "Nova conversa": archives the scope's active conversation (the transcript is kept) and answers the
   *  fresh one. 409 CHAT_BUSY while an answer is being written, 409 CHAT_ARCHIVED if the send that lost
   *  the race already ran against the conversation this call just archived. */
  resetChat: (projectId?: string | null) => request<{ conversation: ChatConversation }>('POST', '/chat/reset', projectId ? { project_id: projectId } : {}),
  /** Which project chats have anything going on right now, for a sidebar badge. */
  chatProjects: () => request<{ projects: ProjectChatStatus[] }>('GET', '/chat/projects'),
  /**
   * 200 normally; 200 with `queued: true` and a pt-BR `note` when a run is in flight (the decision is
   * recorded and will be applied once it finishes); 404 unknown/not yours; 409 already decided (400
   * `GRANT_NOT_ALLOWED` for `approve_tab` on an action the server does not consider grantable).
   * `action` is the raw decided row (not the enriched card `GET /api/chat` returns — no `summary`
   * here): only its `id`/`status` are honoured, and the card's summary is kept as already known.
   * `grant` is the new (or renewed) trusted-tab grant, present only for `approve_tab`.
   */
  decideChatAction: (id: string, decision: 'approve' | 'deny' | 'approve_tab') =>
    request<{ action: { id: string; status: ChatActionStatus }; message?: ChatMessage; queued?: true; note?: string; grant?: ChatGrant }>('POST', `/chat/actions/${id}/decision`, { decision }),
  /** "Revogar": 404 unknown/not yours, 409 already revoked. */
  revokeChatGrant: (id: string) => request<{ grant: ChatGrant }>('DELETE', `/chat/grants/${encodeURIComponent(id)}`),
  monitor: {
    tabs: () => request<{ items: MonitorItem[] }>('GET', '/monitor/tabs'),
    /** every open terminal tab of the scope, reported a state or not (the sidebar's agents) */
    openTabs: () => request<{ items: MonitorItem[] }>('GET', '/monitor/open-tabs'),
  },
  tasks: {
    list: (projectId: string) => request<BoardData>('GET', `/projects/${projectId}/tasks`),
    create: (projectId: string, input: TaskCreateInput) => request<{ task: Task }>('POST', `/projects/${projectId}/tasks`, input),
    update: (id: string, input: TaskPatchInput) => request<{ task: Task }>('PATCH', `/tasks/${id}`, input),
    move: (id: string, target: MoveTarget, position: number) => request<{ task: Task }>('POST', `/tasks/${id}/move`, { ...target, position }),
    /** `KEY-N`, key case-insensitive; 404 outside the scope */
    byRef: (ref: string) => request<{ task: Task; project_id: string }>('GET', `/tasks/by-ref/${encodeURIComponent(ref)}`),
    remove: (id: string) => request<{ ok: true; deleted_subtasks: number }>('DELETE', `/tasks/${id}`),
    addSubtasks: (id: string, items: { title: string; description?: string | null }[]) =>
      request<{ subtasks: Task[] }>('POST', `/tasks/${id}/subtasks`, { items }),
    reorder: (id: string, position: number) => request<{ task: Task }>('POST', `/tasks/${id}/reorder`, { position }),
    pushStatus: (id: string) => request<{ task: Task; state: string }>('POST', `/tasks/${id}/push-status`, {}),
    openTerminal: (id: string, machineId?: string) =>
      request<{ task: Task; tab: Tab; created: boolean }>('POST', `/tasks/${id}/terminal`, machineId ? { machine_id: machineId } : {}),
    detachTerminal: (id: string) => request<{ task: Task }>('DELETE', `/tasks/${id}/terminal`),
  },
  columns: {
    create: (projectId: string, input: { name: string; category: ColumnCategory }) => request<{ column: TaskColumn }>('POST', `/projects/${projectId}/columns`, input),
    update: (id: string, input: { name?: string; category?: ColumnCategory }) => request<{ column: TaskColumn }>('PATCH', `/columns/${id}`, input),
    move: (id: string, position: number) => request<{ columns: TaskColumn[] }>('POST', `/columns/${id}/move`, { position }),
    remove: (id: string) => request<{ ok: true; moved_tasks: number }>('DELETE', `/columns/${id}`),
    setAgent: (projectId: string, columnId: string | null) => request<{ agent_column_id: string | null }>('PUT', `/projects/${projectId}/agent-column`, { column_id: columnId }),
  },
  tickets: {
    list: (projectId: string) => request<{ tickets: Ticket[] }>('GET', `/projects/${projectId}/tickets`),
    import: (projectId: string, ticketIds: string[]) => request<{ tasks: Task[] }>('POST', `/projects/${projectId}/tickets/import`, { ticket_ids: ticketIds }),
  },
  notes: {
    get: (projectId: string) => request<{ note: Note }>('GET', `/projects/${projectId}/note`),
    save: (projectId: string, content: string) => request<{ note: Note }>('PUT', `/projects/${projectId}/note`, { content }),
  },
  integrations: {
    list: () => request<{ integrations: Integration[] }>('GET', '/integrations'),
    create: (input: { provider: IntegrationProvider; name: string; config: Record<string, unknown>; secret: string }) =>
      request<{ integration: Integration }>('POST', '/integrations', input),
    update: (id: string, input: { name?: string; config?: Record<string, unknown>; secret?: string }) =>
      request<{ integration: Integration }>('PATCH', `/integrations/${id}`, input),
    remove: (id: string) => request<{ ok: true }>('DELETE', `/integrations/${id}`),
    test: (input: { provider: IntegrationProvider; config: Record<string, unknown>; secret?: string; integration_id?: string }) =>
      request<ConnectionInfo>('POST', '/integrations/test', input),
  },
  setup: {
    get: (projectId: string) => request<{ setup: ProjectSetup }>('GET', `/projects/${projectId}/setup`),
    save: (projectId: string, data: ProjectSetupData) => request<{ setup: ProjectSetup }>('PUT', `/projects/${projectId}/setup`, data),
    syncTickets: (projectId: string) =>
      request<{ ok: true; fetched: number; created: number; updated: number; removed: number; synced_at: string }>('POST', `/projects/${projectId}/tickets/sync`, {}),
  },
  aiAccounts: {
    list: () => request<{ accounts: AiAccount[] }>('GET', '/ai-accounts'),
    create: (input: { provider: AiProvider; label: string; machine_id: string; config_dir?: string | null }) =>
      request<{ account: AiAccount }>('POST', '/ai-accounts', input),
    update: (id: string, input: { label?: string; machine_id?: string; config_dir?: string | null }) => request<{ account: AiAccount }>('PATCH', `/ai-accounts/${id}`, input),
    remove: (id: string) => request<{ ok: true }>('DELETE', `/ai-accounts/${id}`),
    usage: (refresh = false) => request<{ usage: AiAccountUsage[] }>('GET', `/ai-accounts/usage${refresh ? '?refresh=1' : ''}`),
    usageOf: (id: string, refresh = false) => request<{ usage: AiAccountUsage }>('GET', `/ai-accounts/${id}/usage${refresh ? '?refresh=1' : ''}`),
  },
  roles: {
    list: () => request<{ roles: Role[] }>('GET', '/roles'),
    resources: () => request<{ resources: { key: string; label: string }[]; actions: PermissionAction[] }>('GET', '/roles/resources'),
    create: (input: { name: string; label: string; description?: string | null; is_admin?: boolean }) => request<{ role: Role }>('POST', '/roles', input),
    update: (id: string, input: { label?: string; description?: string | null; is_admin?: boolean }) => request<{ role: Role }>('PATCH', `/roles/${id}`, input),
    remove: (id: string) => request<{ ok: true }>('DELETE', `/roles/${id}`),
    permissions: (id: string) => request<{ role: Role; permissions: ResourcePermissions[] }>('GET', `/roles/${id}/permissions`),
    toggle: (id: string, resource: string, action: PermissionAction) => request<{ granted: boolean }>('POST', `/roles/${id}/permissions/toggle`, { resource, action }),
  },
  users: {
    list: () => request<{ users: User[] }>('GET', '/users'),
    access: () => request<AccessStatus>('GET', '/users/access'),
    invite: (input: { email: string; name?: string; role_id: string }) => request<InviteResult>('POST', '/users/invite', input),
    resendInvite: (id: string) => request<InviteResult>('POST', `/users/${id}/invite`),
    inviteFromWaitlist: (input: { ids: string[]; role_id: string }) => request<{ results: WaitlistInviteResult[] }>('POST', '/users/invite-from-waitlist', input),
    setRole: (id: string, role_id: string) => request<{ user: User }>('PATCH', `/users/${id}`, { role_id }),
    remove: (id: string) => request<{ ok: true; access_removed: boolean }>('DELETE', `/users/${id}`),
    /** Store-review switch (Settings → Usuários → Revisão). `days: null` turns it off. 400 REVIEW_ADMIN
     *  ("A conta de revisão não pode ser admin.") when the target is an admin. `revoked_devices` is how
     *  many of the target's active devices were actually revoked (a failing one is skipped, not fatal). */
    setReview: (id: string, input: { days: 1 | 3 | 7 | null; revoke_devices?: boolean }) => request<{ user: User; revoked_devices: number }>('POST', `/users/${id}/review`, input),
    /** The target user's own devices and device trail, for the review panel. `can_enrol` is the
     *  server's own read of the target's role grants (`devices:create`) — the BETA-role note follows
     *  it instead of guessing from a role name or a permissions list this endpoint never sent. 503
     *  MOBILE_DISABLED when this server has no mobile app configured. */
    devices: (id: string) => request<{ devices: Device[]; events: DeviceEventView[]; can_enrol: boolean }>('GET', `/users/${id}/devices`),
    revokeDevice: (id: string, deviceId: string) => request<{ device: Device }>('DELETE', `/users/${id}/devices/${deviceId}`),
  },
  apiTokens: {
    list: () => request<{ tokens: ApiToken[] }>('GET', '/api-tokens'),
    create: (input: { name: string; scopes: ApiTokenScope[]; expires_in_days: number | null }) => request<CreatedApiToken>('POST', '/api-tokens', input),
    revoke: (id: string) => request<{ api_token: ApiToken }>('DELETE', `/api-tokens/${id}`),
  },
  waitlist: {
    list: () => request<{ entries: WaitlistEntry[] }>('GET', '/waitlist'),
    remove: (id: string) => request<{ ok: true }>('DELETE', `/waitlist/${id}`),
  },
  /** Settings → Aparelhos: the signed-in user's own phones, never a "viewing as" scope. */
  devices: {
    requests: () => request<{ requests: DeviceRequestView[] }>('GET', '/devices/requests'),
    /** 409 DEVICE_LIMIT ("Revogue um aparelho antes") once 5 devices are already active */
    approve: (id: string) => request<{ request: DeviceRequestView }>('POST', `/devices/requests/${id}/approve`, {}),
    deny: (id: string) => request<{ request: DeviceRequestView }>('POST', `/devices/requests/${id}/deny`, {}),
    list: () => request<{ devices: Device[] }>('GET', '/devices'),
    rename: (id: string, name: string) => request<{ device: Device }>('PATCH', `/devices/${id}`, { name }),
    revoke: (id: string) => request<{ device: Device }>('DELETE', `/devices/${id}`),
    events: () => request<{ events: DeviceEventView[] }>('GET', '/devices/events'),
    summary: () => request<DevicesSummary>('GET', '/devices/summary'),
  },
  tabs: {
    rename: (id: string, name: string) => request<{ tab: Tab }>('PATCH', `/tabs/${id}`, { name }),
    remove: (id: string) => request<{ ok: true; killed: boolean }>('DELETE', `/tabs/${id}`),
    update: (id: string, input: { name?: string; simulator_udid?: string | null }) => request<{ tab: Tab }>('PATCH', `/tabs/${id}`, input),
    screenshotUrl: (id: string) => `/api/tabs/${id}/simulator/screenshot`,
    /** types text into the tab's tmux session (and presses Enter) — no terminal attached needed */
    input: (id: string, text: string, enter = true) => request<{ ok: true; tab: Tab }>('POST', `/tabs/${id}/input`, { text, enter }),
    /** the user focused this tab: clears its "needs you" flag if it had one (idempotent) */
    seen: (id: string) => request<{ tab: Tab }>('POST', `/tabs/${id}/seen`),
    events: (id: string, limit = 50) => request<{ events: TabEvent[] }>('GET', `/tabs/${id}/events?limit=${limit}`),
    /** writes the file to ~/.cache/termhub/paste/ on the tab's machine and returns its path */
    pasteFile: (id: string, file: Blob, name?: string) =>
      request<{ path: string; bytes: number; mime: string }>('POST', `/tabs/${id}/paste-file${name ? `?name=${encodeURIComponent(name)}` : ''}`, new Blob([file], { type: 'application/octet-stream' })),
  },
  uploads: {
    list: () => request<{ machines: UploadMachineStatus[]; files: UploadEntry[] }>('GET', '/uploads'),
    remove: (machineId: string, name: string) => request<{ ok: true; existed: boolean }>('DELETE', `/uploads/${machineId}/${encodeURIComponent(name)}`),
  },
  transcriptions: {
    config: () => request<{ enabled: boolean }>('GET', '/transcriptions/config'),
    /**
     * The blob keeps its recorder mime type (audio/webm, audio/mp4...) so the server can decode it;
     * `seconds` is the recorded length, which the server turns into a time estimate.
     */
    create: (audio: Blob, seconds: number, onProgress?: (fraction: number) => void) =>
      upload<{ transcription: Transcription }>(`/transcriptions?seconds=${Math.round(seconds)}`, audio, onProgress),
    get: (id: string) => request<{ transcription: Transcription }>('GET', `/transcriptions/${id}`),
  },
};
