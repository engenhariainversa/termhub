import { chatBus } from '../chat/bus.js';
import type { Repositories } from '../db/repositories/index.js';
import { localeOf, type Locale } from '../i18n/index.js';

type Log = { warn: (o: object, m: string) => void };

/**
 * One line from the automatic work in the owner's most recent conversation of the project (spec D25): a
 * merge, a deploy, a publication, an account at its limit. `text` is written in the owner's language.
 * Never throws: the line is a courtesy, the work it reports has already happened.
 */
export async function postAutomationLine(repos: Repositories, projectId: string, text: (locale: Locale) => string, log?: Log): Promise<void> {
  try {
    const project = await repos.projects.findById(projectId);
    if (!project?.owner_id) return;
    const owner = await repos.users.findById(project.owner_id);
    if (!owner) return;
    const conversation = (await repos.chat.findLatestActiveForProject(project.id, owner.id)) ?? (await repos.chat.getOrCreateForProject(owner.id, project.id));
    const message = await repos.chat.addMessage({ conversation_id: conversation.id, role: 'assistant', text: text(localeOf(owner.locale)) });
    chatBus.publish({ type: 'message', user_id: owner.id, conversation_id: conversation.id, message });
  } catch (e) {
    log?.warn({ projectId, err: e instanceof Error ? e.message : String(e) }, 'automation: chat line not posted');
  }
}
