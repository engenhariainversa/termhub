// Seed data for a fresh `MockState` (design spec §4.2 "Chat"): three projects and the
// account-wide chat, each with a short pt-BR thread dated within the last two days, and the two
// pending confirmations of termhub (`a-termhub-1`, the one the plan fixes in place, and `a-termhub-2`).
import { randomId } from '../../crypto/random';
import type { MockAction, MockConversation, MockMessage, MockNotification, MockProject, MockState } from './state';

/** 5 h between messages (oldest first), newest one 20 min ago — keeps every conversation well
 * inside the "last two days" the brief asks for, even at 6 messages. */
const MSG_SPACING_MS = 5 * 60 * 60_000;
const NEWEST_MSG_AGO_MS = 20 * 60_000;

function timestampFor(now: number, index: number, count: number): string {
  const msAgo = (count - 1 - index) * MSG_SPACING_MS + NEWEST_MSG_AGO_MS;
  return new Date(now - msAgo).toISOString();
}

interface SeedTurn {
  role: 'user' | 'assistant';
  text: string;
}

/** Builds one conversation's messages and registers it as the project's (or, for `projectId ===
 * null`, the account-wide chat's) active conversation. */
function seedConversation(state: MockState, now: number, conversationId: string, projectId: string | null, turns: SeedTurn[]): void {
  const messages: MockMessage[] = turns.map((turn, index) => ({
    id: randomId(10),
    conversation_id: conversationId,
    role: turn.role,
    text: turn.text,
    usage: null,
    error_code: null,
    created_at: timestampFor(now, index, turns.length),
  }));
  state.messages.set(conversationId, messages);

  const conversation: MockConversation = {
    id: conversationId,
    title: null,
    project_id: projectId,
    // Every conversation, including the account-wide chat, starts on `m-jarvis` — the only
    // machine `setHost` can actually reach (`handlers/chat.ts`'s `hostFor`).
    machine_id: 'm-jarvis',
    ai_account_id: null,
    archived_at: null,
    last_message_at: messages[messages.length - 1]?.created_at ?? null,
  };
  state.conversations.set(conversationId, conversation);
  state.activeConversation.set(projectId, conversationId);
}

export function seedFixtures(state: MockState, now: number): void {
  const projects: MockProject[] = [
    { id: 'p-termhub', name: 'termhub', key: 'TER' },
    { id: 'p-opapingou', name: 'opapingou', key: 'OPM' },
    { id: 'p-reactivando', name: 'reactivando', key: 'REA' },
  ];
  for (const project of projects) state.projects.set(project.id, project);

  seedConversation(state, now, 'c-termhub', 'p-termhub', [
    { role: 'user', text: 'Como estão as abas do projeto?' },
    { role: 'assistant', text: 'A aba api está esperando sua confirmação pra rodar `npm test`.' },
    { role: 'user', text: 'Pode adiantar isso?' },
    { role: 'assistant', text: 'Só com sua aprovação — está pendente aí no card.' },
  ]);

  seedConversation(state, now, 'c-opapingou', 'p-opapingou', [
    { role: 'user', text: 'bom dia! como ficou o deploy de ontem?' },
    { role: 'assistant', text: 'Foi tranquilo, sem erros. Quer que eu confira os logs de novo?' },
    { role: 'user', text: 'não precisa, valeu' },
  ]);

  seedConversation(state, now, 'c-reactivando', 'p-reactivando', [
    { role: 'user', text: 'roda os testes da aba principal' },
    { role: 'assistant', text: 'Rodei `npm test`: 842 testes passaram, 12 pulados.' },
    { role: 'user', text: 'show, obrigado' },
    { role: 'assistant', text: 'Fico por aqui se precisar de mais alguma coisa.' },
    { role: 'user', text: 'beleza' },
  ]);

  seedConversation(state, now, 'c-general', null, [
    { role: 'user', text: 'oi, alguma coisa pendente hoje?' },
    { role: 'assistant', text: 'Só o pedido de confirmação no termhub, o resto está tranquilo.' },
    { role: 'user', text: 'beleza, obrigado' },
  ]);

  const action: MockAction = {
    id: 'a-termhub-1',
    conversation_id: 'c-termhub',
    tool: 'send_input',
    args: { tab_id: 't-api', text: 'npm test' },
    class: 'write',
    status: 'pending',
    machine_id: 'm-jarvis',
    project_id: 'p-termhub',
    tab_id: 't-api',
    grant_id: null,
    summary: 'digitar `npm test` na aba api do projeto termhub, no jarvis',
    created_at: new Date(now - 15 * 60_000).toISOString(),
  };
  state.actions.set(action.id, action);
  // A second pending action in the same conversation, so a grouped confirmation has two cards.
  const second: MockAction = {
    id: 'a-termhub-2',
    conversation_id: 'c-termhub',
    tool: 'move_task',
    args: { task_id: 'task-login', status: 'doing' },
    class: 'write',
    status: 'pending',
    machine_id: null,
    project_id: 'p-termhub',
    tab_id: null,
    grant_id: null,
    summary: 'mover a tarefa TER-12 "Revisar o login" do projeto termhub',
    created_at: new Date(now - 14 * 60_000).toISOString(),
  };
  state.actions.set(second.id, second);

  // The confirmation notification this pre-existing pending action would have produced, so the
  // Notificações tab is not empty on first boot either.
  const notification: MockNotification = {
    id: randomId(10),
    kind: 'confirmation',
    title: 'termhub precisa de você',
    body: 'O chat do projeto termhub pediu confirmação para agir na aba api (jarvis).',
    data: { kind: 'confirmation', conversation_id: action.conversation_id, project_id: action.project_id, action_id: action.id },
    created_at: action.created_at,
    read_at: null,
  };
  state.notifications.push(notification);
}
