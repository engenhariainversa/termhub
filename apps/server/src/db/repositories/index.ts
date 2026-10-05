import type { PrismaClient } from '../prisma.js';
import { UsersRepository } from './users.js';
import { SessionsRepository } from './sessions.js';
import { LoginAttemptsRepository } from './login-attempts.js';
import { LoginCodesRepository } from './login-codes.js';
import { MachinesRepository } from './machines.js';
import { ProjectsRepository } from './projects.js';
import { ProjectMachinesRepository } from './project-machines.js';
import { TabsRepository } from './tabs.js';
import { TasksRepository } from './tasks.js';
import { TaskColumnsRepository } from './task-columns.js';
import { ProgressRepository } from './progress.js';
import { NotesRepository } from './notes.js';
import { IntegrationsRepository } from './integrations.js';
import { ProjectSetupRepository } from './project-setup.js';
import { TicketsRepository } from './tickets.js';
import { AiAccountsRepository } from './ai-accounts.js';
import { WaitlistRepository } from './waitlist.js';
import { RolesRepository } from './roles.js';
import { MachineHooksRepository } from './machine-hooks.js';
import { UploadsRepository } from './uploads.js';
import { ApiTokensRepository } from './api-tokens.js';
import { ChatRepository } from './chat.js';
import { ChatActionsRepository } from './chat-actions.js';
import { ChatGrantsRepository } from './chat-grants.js';
import { ChatProjectGrantsRepository } from './chat-project-grants.js';
import { ChatStandingGrantsRepository } from './chat-standing-grants.js';
import { ChatDefaultRestrictionsRepository } from './chat-default-restrictions.js';
import { ChatSubagentsRepository } from './chat-subagents.js';
import { ChatLiveRunsRepository } from './chat-live-runs.js';
import { TabQuestionsRepository } from './tab-questions.js';
import { TabLimitNoticesRepository } from './tab-limit-notices.js';
import { ChatAttachmentsRepository, type ChatAttachmentsRepo } from './chat-attachments.js';
import { ChatDecisionsRepository } from './chat-decisions.js';
import { MemoryItemsRepository } from './memory-items.js';
import { InstanceSecretsRepository } from './instance-secrets.js';
import { ProjectGroupsRepository } from './project-groups.js';
import { DeviceRequestsRepository } from './device-requests.js';
import { DevicesRepository } from './devices.js';
import { DeviceSessionsRepository } from './device-sessions.js';
import { DeviceEventsRepository } from './device-events.js';
import { UserNotificationsRepository } from './user-notifications.js';
import { PushTicketsRepository } from './push-tickets.js';
import { TaskPullRequestsRepository } from './task-pull-requests.js';
import { AccountDeletionRepository } from './account-deletion.js';
import { AutomationPausesRepository } from './automation-pauses.js';
import { AutomationEventsRepository } from './automation-events.js';
import { AutomationRunsRepository } from './automation-runs.js';
import { AiAccountExhaustionsRepository } from './ai-account-exhaustions.js';
import { TabUsageRepository } from './tab-usage.js';

export interface Repositories {
  users: UsersRepository;
  sessions: SessionsRepository;
  loginAttempts: LoginAttemptsRepository;
  loginCodes: LoginCodesRepository;
  machines: MachinesRepository;
  projects: ProjectsRepository;
  projectMachines: ProjectMachinesRepository;
  tabs: TabsRepository;
  tasks: TasksRepository;
  taskColumns: TaskColumnsRepository;
  progress: ProgressRepository;
  notes: NotesRepository;
  integrations: IntegrationsRepository;
  projectSetup: ProjectSetupRepository;
  tickets: TicketsRepository;
  aiAccounts: AiAccountsRepository;
  machineHooks: MachineHooksRepository;
  waitlist: WaitlistRepository;
  roles: RolesRepository;
  uploads: UploadsRepository;
  apiTokens: ApiTokensRepository;
  chat: ChatRepository;
  chatActions: ChatActionsRepository;
  chatGrants: ChatGrantsRepository;
  chatProjectGrants: ChatProjectGrantsRepository;
  chatStandingGrants: ChatStandingGrantsRepository;
  chatDefaultRestrictions: ChatDefaultRestrictionsRepository;
  chatSubagents: ChatSubagentsRepository;
  chatLiveRuns: ChatLiveRunsRepository;
  tabQuestions: TabQuestionsRepository;
  tabLimitNotices: TabLimitNoticesRepository;
  chatAttachments: ChatAttachmentsRepo;
  chatDecisions: ChatDecisionsRepository;
  memoryItems: MemoryItemsRepository;
  instanceSecrets: InstanceSecretsRepository;
  projectGroups: ProjectGroupsRepository;
  deviceRequests: DeviceRequestsRepository;
  devices: DevicesRepository;
  deviceSessions: DeviceSessionsRepository;
  deviceEvents: DeviceEventsRepository;
  userNotifications: UserNotificationsRepository;
  pushTickets: PushTicketsRepository;
  taskPullRequests: TaskPullRequestsRepository;
  accountDeletion: AccountDeletionRepository;
  automationPauses: AutomationPausesRepository;
  automationEvents: AutomationEventsRepository;
  automationRuns: AutomationRunsRepository;
  tabUsage: TabUsageRepository;
  aiAccountExhaustions: AiAccountExhaustionsRepository;
  /** Round-trips a trivial query: `/api/ready` asks whether the database answers. */
  ping(): Promise<void>;
}

export function createRepositories(db: PrismaClient): Repositories {
  return {
    users: new UsersRepository(db),
    sessions: new SessionsRepository(db),
    loginAttempts: new LoginAttemptsRepository(db),
    loginCodes: new LoginCodesRepository(db),
    machines: new MachinesRepository(db),
    projects: new ProjectsRepository(db),
    projectMachines: new ProjectMachinesRepository(db),
    tabs: new TabsRepository(db),
    tasks: new TasksRepository(db),
    taskColumns: new TaskColumnsRepository(db),
    progress: new ProgressRepository(db),
    notes: new NotesRepository(db),
    integrations: new IntegrationsRepository(db),
    projectSetup: new ProjectSetupRepository(db),
    tickets: new TicketsRepository(db),
    aiAccounts: new AiAccountsRepository(db),
    machineHooks: new MachineHooksRepository(db),
    waitlist: new WaitlistRepository(db),
    roles: new RolesRepository(db),
    uploads: new UploadsRepository(db),
    apiTokens: new ApiTokensRepository(db),
    chat: new ChatRepository(db),
    chatActions: new ChatActionsRepository(db),
    chatGrants: new ChatGrantsRepository(db),
    chatProjectGrants: new ChatProjectGrantsRepository(db),
    chatStandingGrants: new ChatStandingGrantsRepository(db),
    chatDefaultRestrictions: new ChatDefaultRestrictionsRepository(db),
    chatSubagents: new ChatSubagentsRepository(db),
    chatLiveRuns: new ChatLiveRunsRepository(db),
    tabQuestions: new TabQuestionsRepository(db),
    tabLimitNotices: new TabLimitNoticesRepository(db),
    chatAttachments: new ChatAttachmentsRepository(db),
    chatDecisions: new ChatDecisionsRepository(db),
    memoryItems: new MemoryItemsRepository(db),
    instanceSecrets: new InstanceSecretsRepository(db),
    projectGroups: new ProjectGroupsRepository(db),
    deviceRequests: new DeviceRequestsRepository(db),
    devices: new DevicesRepository(db),
    deviceSessions: new DeviceSessionsRepository(db),
    deviceEvents: new DeviceEventsRepository(db),
    userNotifications: new UserNotificationsRepository(db),
    pushTickets: new PushTicketsRepository(db),
    taskPullRequests: new TaskPullRequestsRepository(db),
    accountDeletion: new AccountDeletionRepository(db),
    automationPauses: new AutomationPausesRepository(db),
    automationEvents: new AutomationEventsRepository(db),
    automationRuns: new AutomationRunsRepository(db),
    tabUsage: new TabUsageRepository(db),
    aiAccountExhaustions: new AiAccountExhaustionsRepository(db),
    ping: () => db.$queryRaw`SELECT 1`.then(() => undefined),
  };
}

export * from './types.js';
export type { Integration, IntegrationProvider } from './integrations.js';
export type { ProjectSetup } from './project-setup.js';
export type { WaitlistEntry } from './waitlist.js';
export type { Role, PermissionGrant } from './roles.js';
export type { Upload } from './uploads.js';
export { SYSTEM_ROLE_IDS } from './roles.js';
export type { ChatConversation, ChatMessage, ChatRole } from './chat.js';
export type { ChatAction, ChatActionClass, ChatActionStatus, InsertPendingInput, InsertApprovedInput } from './chat-actions.js';
export type { ChatSubagent, StartSubagentInput } from './chat-subagents.js';
export type { ChatLiveRun, StoredTurn, SaveLiveRunInput } from './chat-live-runs.js';
export type { TabQuestion, TabQuestionStatus, AutoAnswer, AnsweredVia } from './tab-questions.js';
export type { AttachmentRow, ChatAttachmentsRepo, CreateAttachmentInput } from './chat-attachments.js';
export type { ChatDecision, DecisionOption, DecisionAnswer, NewDecision, DecisionNeighbour, AnsweredChoiceRow } from './chat-decisions.js';
export type { MemoryItem, NewMemoryItem, MemoryHit, MemoryFilter, MemoryKind, MemoryTrust } from './memory-items.js';
export { ProjectRuleError } from './projects.js';
export type { ProjectRuleCode } from './projects.js';
export { ProjectGroupRuleError } from './project-groups.js';
export type { ProjectGroup, ProjectGroupRuleCode } from './project-groups.js';
export { TaskRuleError } from './task-rules.js';
export type { TaskRuleCode } from './task-rules.js';
export type { DeviceRequest, DeviceRequestStatus, DeviceRequestCreateInput } from './device-requests.js';
export type { Device, DeviceStatus, DeviceCreateInput } from './devices.js';
export type { DeviceChallengePurpose } from './device-sessions.js';
export type { DeviceEvent, DeviceEventKind, DeviceEventInput } from './device-events.js';
export type { UserNotification, UserNotificationCreateInput } from './user-notifications.js';
export type { TaskPullRequest, PullRequestInfo, PrState, CiState, CiSummary } from './task-pull-requests.js';
export { WATCH_MERGED_FOR_MS } from './task-pull-requests.js';
export type { PurgedAccount, AccountDeletionLink } from './account-deletion.js';
export type { PauseState } from './automation-pauses.js';
export type { UsageCursor, UsageTokens, UsageWrite, UsageSum } from './tab-usage.js';
export type { AutomationEvent, AutomationEventKind, AutomationEventPayload, AutomationEventInput } from './automation-events.js';
export { AUTOMATION_EVENT_RETENTION_MS, AUTOMATION_EVENTS_PAGE_MAX } from './automation-events.js';
