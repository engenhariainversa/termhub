// Chats' one list of projects (TER-1106): the order of its rows and what each row counts as waiting on the person.
import { favoriteProjects, isFavorite } from '@/features/home/model/favorites';

type Pinnable = { favorite_position?: number | null };

/** The person's Favoritos first, in Favoritos order (Home's and the web sidebar's), then the rest in
 * the order the server sent them. */
export function chatsOrder<T extends Pinnable>(projects: T[]): T[] {
  return [...favoriteProjects(projects), ...projects.filter((p) => !isFavorite(p))];
}

/** How many tabs of each project wait on the person ("esperando você"), by project id. */
export function tabsNeedingYou(tabs: { project: { id: string }; needs_you: boolean }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const tab of tabs) if (tab.needs_you) counts.set(tab.project.id, (counts.get(tab.project.id) ?? 0) + 1);
  return counts;
}
