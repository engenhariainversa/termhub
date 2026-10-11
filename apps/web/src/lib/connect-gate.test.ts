import { describe, expect, it } from 'vitest';
import { ConnectGate } from './connect-gate';

describe('ConnectGate', () => {
  it('starts at most `limit` handshakes at once and the next one when a slot frees', () => {
    const gate = new ConnectGate(2);
    const started: number[] = [];
    const tickets = [0, 1, 2, 3].map((i) => gate.enqueue(() => started.push(i), () => false));
    expect(started).toEqual([0, 1]);
    tickets[0].release();
    expect(started).toEqual([0, 1, 2]);
    tickets[1].release();
    tickets[2].release();
    expect(started).toEqual([0, 1, 2, 3]);
  });

  it('hands a free slot to a waiting priority entry before older ones', () => {
    const gate = new ConnectGate(1);
    const started: string[] = [];
    let visible = false;
    const first = gate.enqueue(() => started.push('busy'), () => false);
    gate.enqueue(() => started.push('hidden'), () => false);
    gate.enqueue(() => started.push('visible'), () => visible);
    visible = true; // the person switched to that tab while it waited
    first.release();
    expect(started).toEqual(['busy', 'visible']);
  });

  it('a released waiting entry never starts, and release is idempotent', () => {
    const gate = new ConnectGate(1);
    const started: string[] = [];
    const a = gate.enqueue(() => started.push('a'), () => false);
    const b = gate.enqueue(() => started.push('b'), () => false);
    gate.enqueue(() => started.push('c'), () => false);
    b.release(); // gave up while queued (the tab closed)
    a.release();
    a.release(); // a second release must not free another slot
    expect(started).toEqual(['a', 'c']);
  });
});
