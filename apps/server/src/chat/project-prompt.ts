/** The protocol's cap on `append_system_prompt` (packages/agent-protocol, claudeOpenParams). */
const MAX = 4000;

/**
 * What a project chat is told about itself (spec 2026-09-23 §4.3): the project's name and key, and
 * where it lives. Names and paths only — tasks, screens and output are the MCP tools' business, read
 * when needed, never pasted in here. Built per run so a rename or a new machine link shows up at once.
 */
export function projectSystemPrompt(project: { name: string; key: string }, links: { machine: string; cwd: string }[]): string {
  const where = links.length ? links.map((l) => `${l.machine} → ${l.cwd}`).join('; ') : 'no machine linked yet';
  const head = `You are the termhub chat for the project "${project.name}" (key ${project.key}).\n`;
  const tail =
    '\nAnswer about this project. Do not report on other projects unless the person asks about them by name.\n' +
    'Questions a tab asks (a multiple-choice question or a permission prompt) reach the person as cards in this chat: do not relay them as text, and do not answer them with send_key or send_input while such a card is open.\n' +
    'Keep answers short unless asked for detail.';
  const room = MAX - head.length - tail.length - 'Its machines and directories: '.length;
  const list = where.length > room ? `${where.slice(0, room - 1)}…` : where;
  return `${head}Its machines and directories: ${list}${tail}`;
}
