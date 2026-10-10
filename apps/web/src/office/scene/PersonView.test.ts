import { describe, expect, it } from 'vitest';
import type { DeskModel } from '../model';
import { deskArtKeys } from '../pack/art';
import { deskShowsAgent } from './PersonView';

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

describe('deskArtKeys', () => {
  it('uses the v-2 desk/agent stack, with the robot chair, for an occupied seat', () => {
    expect(deskArtKeys(true)).toEqual({
      desk: 'desk/side-v-2',
      agent: 'agent/side-v',
      chair: null,
      robotChair: 'chair/side-v',
    });
  });

  it('uses desk-h + chair-h when the seat is free', () => {
    expect(deskArtKeys(false)).toEqual({
      desk: 'desk/side-h',
      agent: null,
      chair: 'chair/h',
      robotChair: null,
    });
  });
});

describe('deskShowsAgent', () => {
  it('is true only for an occupied person desk', () => {
    expect(deskShowsAgent(desk())).toBe(true);
    expect(deskShowsAgent(desk({ pose: 'empty' }))).toBe(false);
    expect(deskShowsAgent(desk({ kind: 'phone', pose: 'sit' }))).toBe(false);
  });
});
