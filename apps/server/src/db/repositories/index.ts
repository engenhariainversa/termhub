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
import { InstanceSecretsRepository } from './instance-secrets.js';
import { ProjectGroupsRepository } from './project-groups.js';
import { DeviceRequestsRepository } from './device-requests.js';
import { DevicesRepository } from './devices.js';
import { DeviceSessionsRepository } from './device-sessions.js';
import { DeviceEventsRepository } from './device-events.js';
import { UserNotificationsRepository } from './user-notifications.js';

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
  instanceSecrets: InstanceSecretsRepository;
  projectGroups: ProjectGroupsRepository;
  deviceRequests: DeviceRequestsRepository;
  devices: DevicesRepository;
  deviceSessions: DeviceSessionsRepository;
  deviceEvents: DeviceEventsRepository;
  userNotifications: UserNotificationsRepository;
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
    instanceSecrets: new InstanceSecretsRepository(db),
    projectGroups: new ProjectGroupsRepository(db),
    deviceRequests: new DeviceRequestsRepository(db),
    devices: new DevicesRepository(db),
    deviceSessions: new DeviceSessionsRepository(db),
    deviceEvents: new DeviceEventsRepository(db),
    userNotifications: new UserNotificationsRepository(db),
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
export type { ChatAction, ChatActionClass, ChatActionStatus, InsertPendingInput } from './chat-actions.js';
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
