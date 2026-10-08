import { describe, expect, it } from 'vitest';
import type { TabState } from '../../lib/types';
import type { DeskModel } from '../model';
import { bounce } from './DeskScreens';
import { deskLook, deskStatusText } from './deskLook';
import { humanPose } from './PersonView';
import { robotPose } from './Robot';

const desk = (over: Partial<DeskModel> = {}): DeskModel => ({
  id: 't',
  projectId: 'p',
  name: 'n',
  label: 'n',
  kind: 'person',
  pose: 'sit',
  marker: null,
  dimmed: false,
  screenOn: true,
  state: 'idle',
  activity: null,
  verb: null,
  progress: null,
  look: 0,
  machine: null,
  auto: null,
  ...over,
});

const STATES: Array<TabState | null> = ['working', 'waiting_input', 'waiting_permission', 'error', 'finished', 'idle', 'waiting_background', null];

describe('deskLook: (state, automatic) → what the desk shows', () => {
  it('gives every state its own screen and motion', () => {
    expect(STATES.map((state) => [state, deskLook(desk({ state })).screen, deskLook(desk({ state })).motion])).toEqual([
      ['working', 'code', 'type'],
      ['waiting_input', 'game', 'play'],
      ['waiting_permission', 'game', 'play'],
      ['error', 'error', 'shake'],
      ['finished', 'done', 'relax'],
      ['idle', 'saver', 'doze'],
      ['waiting_background', 'clock', 'watch'],
      [null, 'off', 'still'],
    ]);
    // the two waits share the game: what tells them apart is the marker over the desk
    const distinct = new Set(STATES.filter((s) => s !== 'waiting_permission').map((state) => deskLook(desk({ state })).screen));
    expect(distinct.size).toBe(STATES.length - 1);
  });

  it('seats a robot only at an automatic run, a person everywhere else, nobody at an empty desk or a phone', () => {
    expect(deskLook(desk({ auto: 'TER-1' })).avatar).toBe('robot');
    expect(deskLook(desk()).avatar).toBe('human');
    expect(deskLook(desk({ auto: 'TER-1', pose: 'empty' }))).toMatchObject({ avatar: null, screen: 'off' });
    expect(deskLook(desk({ kind: 'phone', auto: 'TER-1' }))).toMatchObject({ avatar: null, screen: 'off' });
  });

  it('marks the corner ⚡ only while an automatic run works', () => {
    expect(deskLook(desk({ state: 'working', auto: 'TER-1' })).bolt).toBe(true);
    expect(deskLook(desk({ state: 'working' })).bolt).toBe(false);
    expect(deskLook(desk({ state: 'idle', auto: 'TER-1' })).bolt).toBe(false);
  });

  it('blinks for attention only while the tab needs the person', () => {
    expect(deskLook(desk({ state: 'waiting_input', marker: 'input' })).attention).toBe(true);
    expect(deskLook(desk({ state: 'waiting_permission', marker: 'permission' })).attention).toBe(true);
    // seen already: still waiting (the game goes on), no longer calling
    expect(deskLook(desk({ state: 'waiting_input', marker: null })).attention).toBe(false);
  });

  it('picks the same game for the same tab, all three across tabs', () => {
    expect(new Set([0, 1, 2, 3].map((look) => deskLook(desk({ state: 'waiting_input', look })).game))).toEqual(new Set(['snake', 'pong', 'tetris']));
    expect(deskLook(desk({ look: 4 })).game).toBe(deskLook(desk({ look: 1 })).game);
  });
});

describe('deskStatusText', () => {
  it('names the run and its card for an automatic desk, the state alone otherwise', () => {
    expect(deskStatusText(desk({ state: 'working', auto: 'TER-123' }))).toBe('Automático — trabalhando — TER-123');
    expect(deskStatusText(desk({ state: null, auto: 'TER-123' }))).toBe('Automático — TER-123');
    expect(deskStatusText(desk({ state: 'waiting_input' }))).toBe('Esperando resposta');
    expect(deskStatusText(desk({ state: null }))).toBe('');
    expect(deskStatusText(desk({ state: 'idle', pose: 'empty' }))).toBe('');
  });
});

describe('avatar motion', () => {
  it('moves the person differently in each state and holds them still without a state', () => {
    const poses = (['type', 'play', 'shake', 'doze', 'relax', 'watch'] as const).map((m) => JSON.stringify([0, 1, 2, 3, 7].map((f) => humanPose(m, f, 0.2))));
    expect(new Set(poses).size).toBe(poses.length);
    expect(humanPose('still', 5, 3)).toEqual({ x: 0, y: 0, rotation: 0 });
  });

  it('types with alternating hands and a blinking antenna, powers off when dozing, blinks attention while waiting', () => {
    const a = robotPose('type', 0, false, false);
    const b = robotPose('type', 1, false, false);
    expect(a.hands).not.toEqual(b.hands);
    expect(new Set([0, 1, 2, 3, 4, 5].map((f) => robotPose('type', f, false, false).antenna)).size).toBe(2);
    expect(robotPose('doze', 0, false, false).antenna).toBeNull();
    expect(robotPose('play', 0, true, false).antenna).toBe(0xf0883e);
    expect(robotPose('play', 8, true, false).antenna).not.toBe(0xf0883e);
  });

  it('keeps only the colour with reduced motion: the same pose on every frame', () => {
    expect(robotPose('type', 0, false, true)).toEqual(robotPose('type', 7, false, true));
    expect(robotPose('shake', 3, false, true).dx).toBe(0);
  });
});

describe('bounce', () => {
  it('goes from a to b and back, one step per frame', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((f) => bounce(f, 0, 3))).toEqual([0, 1, 2, 3, 2, 1, 0]);
    expect(bounce(-1, 0, 3)).toBe(1);
  });
});
