/** What the overlay says at a given zoom, and what a building's sign says. Pure: no PixiJS, so it can be tested alone. */
import type { BuildingModel, FocusTarget } from '../model';
import { i18n, tk } from '../../i18n';

/** Zoom from which a sign keeps its full size; below it, it gives way a little (see Overlay.ts). */
export const SIGN_SCALE = 0.7;

/**
 * Zoom from which a free-roaming view is close enough to read a building's desks: a label keeps its
 * screen size, so below this the labels of two neighbouring desks (two tiles apart) run into each
 * other.
 */
export const LABEL_SCALE = 1.8;

/** A desk's name, machine line and bar: always inside the building the person stands in, elsewhere only close enough to read. */
export function deskLabelsVisible(target: FocusTarget, scale: number, buildingId: string): boolean {
  return scale >= LABEL_SCALE || (target.kind === 'building' && target.projectId === buildingId);
}

/** pt-BR keys, shown with `i18n.t(NOTICE[notice])`. */
const NOTICE = { offline: tk('offline'), silent: tk('sem resposta') } as const;
const needsYouText = (n: number) => i18n.t('{{count}} precisam de você', { count: n });

/**
 * The building sign's three texts (city-by-project §3.2): the name, a muted detail line — the
 * notice, the board, or that nobody is in there right now — and the orange counter of who needs
 * you, which an offline building must still shout. The separator before the counter belongs to the
 * detail line, so it dims with it.
 */
export function buildingSignText(b: Pick<BuildingModel, 'label' | 'notice' | 'progress' | 'needsYou' | 'desks'>): { name: string; detail: string; count: string } {
  const parts: string[] = [];
  if (b.notice) parts.push(i18n.t(NOTICE[b.notice]));
  if (b.progress) parts.push(i18n.t('{{done}}/{{total}} tarefas', { done: b.progress.done, total: b.progress.total }));
  if (b.desks.length === 0) parts.push(i18n.t('sem agentes agora'));
  const count = b.needsYou > 0 ? needsYouText(b.needsYou) : '';
  const detail = parts.join(' · ');
  return { name: b.label, detail: detail && count ? `${detail} ·` : detail, count };
}
