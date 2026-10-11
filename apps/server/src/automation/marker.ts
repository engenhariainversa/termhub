/**
 * Starts every message the server types into an automatic tab (spec D27). Kept apart from `prompts.ts`,
 * which imports `control/agents.ts`: the account swap (imported by it) marks its resume line too.
 */
export const SERVER_MARKER = '[termhub automático]';

export function serverMessage(text: string): string {
  return `${SERVER_MARKER} ${text}`;
}
