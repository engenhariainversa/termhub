/**
 * What a desk's monitors and the one sitting at it show (TER-1048): one animation per tab state, on
 * the screens and on the avatar, with the colours of the tab list's status dot (TER-1044). Pure, so the
 * mapping (state, automatic) → visual is tested apart from Pixi.
 */
import { i18n } from '../../i18n';
import { TAB_STATE_LABEL } from '../../lib/types';
import type { DeskModel } from '../model';

/** What the two monitors play. */
export type ScreenKind =
  /** working: code scrolling on the left, a progress bar going back and forth on the right */
  | 'code'
  /** waiting for the person: a pixel game on the left, a blinking "?" on the right while it needs you */
  | 'game'
  /** error (and, once TER-1046 lands, an expired login): red, a blinking "!" */
  | 'error'
  /** finished: a check that draws itself, then a screensaver that keeps a small check */
  | 'done'
  /** idle at the prompt: a screensaver, the right monitor off */
  | 'saver'
  /** waiting on its own background work: grey, a clock whose hands turn and a row of dots */
  | 'clock'
  /** never reported a state: both monitors off */
  | 'off';

/** How the one at the desk moves. */
export type AvatarMotion = 'type' | 'play' | 'shake' | 'doze' | 'relax' | 'watch' | 'still';

/** The pixel game a waiting desk plays: always the same one for the same tab. */
export type Game = 'snake' | 'pong' | 'tetris';
const GAMES: Game[] = ['snake', 'pong', 'tetris'];

export interface DeskLook {
  /** null: nobody at the desk (an empty chair, a phone) */
  avatar: 'human' | 'robot' | null;
  screen: ScreenKind;
  motion: AvatarMotion;
  game: Game;
  /** the tab needs the person: the screen blinks slowly in the attention colour */
  attention: boolean;
  /** an automatic run: a small ⚡ in the corner of the right monitor while it works */
  bolt: boolean;
}

/** The status dot's colours (tailwind.config.js): working, attention, error, done, still. */
export const SCREEN_COLOR = {
  accent: 0x4f8cff,
  attention: 0xf0883e,
  danger: 0xf85149,
  ok: 0x3fb950,
  dim: 0x6b7280,
} as const;

export function deskLook(model: DeskModel): DeskLook {
  const seated = model.kind === 'person' && model.pose !== 'empty';
  const avatar = !seated ? null : model.auto ? 'robot' : 'human';
  const attention = model.marker === 'input' || model.marker === 'permission';
  const game = GAMES[model.look % GAMES.length];
  const look = (screen: ScreenKind, motion: AvatarMotion): DeskLook => ({ avatar, screen, motion, game, attention, bolt: !!model.auto && screen === 'code' });
  if (!seated) return look('off', 'still');
  switch (model.state) {
    case 'working':
      return look('code', 'type');
    case 'waiting_input':
    case 'waiting_permission':
      return look('game', 'play');
    case 'error':
      return look('error', 'shake');
    case 'finished':
      return look('done', 'relax');
    case 'idle':
      return look('saver', 'doze');
    case 'waiting_background':
      return look('clock', 'watch');
    default:
      return look('off', 'still');
  }
}

/**
 * The line a hovered desk adds under its name: "Automático — trabalhando — TER-123" for a run, the
 * state alone for a person's tab, '' when the tab never reported one and is not a run.
 */
export function deskStatusText(model: DeskModel): string {
  const state = model.state && model.pose !== 'empty' ? i18n.t(TAB_STATE_LABEL[model.state]) : '';
  if (!model.auto) return state ? state.charAt(0).toUpperCase() + state.slice(1) : '';
  return state ? i18n.t('Automático — {{state}} — {{ref}}', { state, ref: model.auto }) : i18n.t('Automático — {{ref}}', { ref: model.auto });
}
