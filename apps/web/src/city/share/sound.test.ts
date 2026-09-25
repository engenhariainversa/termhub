import { describe, expect, it } from 'vitest';
import type { CityModel, DeskModel } from '../../office/model';
import { cleanMix, DEFAULT_MIX, EQ_RANGE_DB, layerGains, MAX_LAYERS, soundEvents } from './sound';

const desk = (id: string, pose: DeskModel['pose'], marker: DeskModel['marker'] = null) => ({ id, pose, marker }) as DeskModel;
const city = (...buildings: Array<[string, DeskModel[]]>): CityModel => ({ needsYou: 0, buildings: buildings.map(([id, desks]) => ({ id, desks })) }) as unknown as CityModel;

describe('soundEvents', () => {
  it('starts the clicks with the robots typing when the clip starts, and no dings', () => {
    expect(soundEvents(null, city(['b1', [desk('a', 'type'), desk('b', 'type'), desk('c', 'raise', 'input')]]))).toEqual([{ kind: 'typing', typists: 2 }]);
    expect(soundEvents(null, city(['b1', [desk('a', 'sleep')]]))).toEqual([]);
  });

  it('follows the number of typing robots', () => {
    const before = city(['b1', [desk('a', 'type'), desk('b', 'sit')]]);
    const after = city(['b1', [desk('a', 'type'), desk('b', 'type')]]);
    expect(soundEvents(before, after)).toEqual([{ kind: 'typing', typists: 2 }]);
    expect(soundEvents(after, before)).toEqual([{ kind: 'typing', typists: 1 }]);
  });

  it('dings once per newly raised hand, input or permission', () => {
    const before = city(['b1', [desk('a', 'type'), desk('b', 'type')]]);
    const after = city(['b1', [desk('a', 'raise', 'input'), desk('b', 'raise', 'permission')]]);
    expect(soundEvents(before, after)).toEqual([
      { kind: 'typing', typists: 0 },
      { kind: 'ding', desk: 'b1:a' },
      { kind: 'ding', desk: 'b1:b' },
    ]);
    // a hand that stays up does not ding again, nor does an error marker
    expect(soundEvents(after, after)).toEqual([]);
    expect(soundEvents(before, city(['b1', [desk('a', 'shake', 'error'), desk('b', 'type')]]))).toEqual([{ kind: 'typing', typists: 1 }]);
  });

  it('tells two buildings’ desks with the same id apart', () => {
    const before = city(['b1', [desk('a', 'raise', 'input')]], ['b2', [desk('a', 'sit')]]);
    const after = city(['b1', [desk('a', 'raise', 'input')]], ['b2', [desk('a', 'raise', 'input')]]);
    expect(soundEvents(before, after)).toEqual([{ kind: 'ding', desk: 'b2:a' }]);
  });

  it('plays nothing when nothing changed', () => {
    const same = city(['b1', [desk('a', 'type'), desk('b', 'raise', 'input')]]);
    expect(soundEvents(same, city(['b1', [desk('a', 'type'), desk('b', 'raise', 'input')]]))).toEqual([]);
  });
});

describe('layerGains', () => {
  it('opens one keyboard layer per typing robot, up to the cap, at one loop’s total loudness', () => {
    expect(layerGains(0)).toEqual([0, 0, 0]);
    expect(layerGains(1)).toEqual([1, 0, 0]);
    const two = layerGains(2);
    expect(two[2]).toBe(0);
    expect(two[0] ** 2 + two[1] ** 2).toBeCloseTo(1, 10);
    expect(layerGains(40)).toEqual(layerGains(MAX_LAYERS));
  });
});

describe('cleanMix', () => {
  it('starts from the default mix: ambience 70%, keyboard 40%, a flat equaliser', () => {
    expect(cleanMix(null)).toEqual(DEFAULT_MIX);
    expect(DEFAULT_MIX).toMatchObject({ ambience: 0.7, keyboard: 0.4, bass: 0, mid: 0, treble: 0 });
  });

  it('clamps what was stored and drops what it does not know', () => {
    expect(cleanMix({ ambience: 3, keyboard: -1, bass: 99, treble: -99, mid: 'x', extra: 1 })).toEqual({
      ...DEFAULT_MIX,
      ambience: 1,
      keyboard: 0,
      bass: EQ_RANGE_DB,
      treble: -EQ_RANGE_DB,
    });
  });
});
