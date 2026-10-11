import { describe, expect, it, vi } from 'vitest';
import type { Machine } from '../db/repositories/types.js';
import type { HardwareSnapshot } from '../system/hardware.js';
import { createMachineRoom, freeDiskKb, hasRoom, MIN_AVAILABLE_MEMORY_KB, MIN_FREE_DISK_KB, ROOM_CACHE_MS } from './machine-room.js';

const GB = 1024 * 1024;
const snap = (o: Partial<HardwareSnapshot> = {}): HardwareSnapshot => ({
  os: 'linux', hostname: 'h', cpu_model: null, ncpu: 12, uptime_s: 1, load: [3, 3, 3], cpu_pct: 10,
  mem_total_kb: 60 * GB, mem_used_kb: 18 * GB, swap_total_kb: 0, swap_used_kb: 0,
  disks: [
    { mount: '/', source: '/dev/a', size_kb: 500 * GB, used_kb: 400 * GB, avail_kb: 93 * GB },
    { mount: '/mnt/hd', source: '/dev/b', size_kb: 2000 * GB, used_kb: 1990 * GB, avail_kb: 10 * GB },
  ],
  temps: [], gpus: [], processes: [], collected_at: '', ...o,
});
const machine = { id: 'm1' } as Machine;

describe('hasRoom', () => {
  it('needs 4 GB of memory, 20 GB of disk on the worktrees mount and a load below the CPU count', () => {
    expect(hasRoom(snap(), '/home/u/.termhub/worktrees')).toBe(true);
    expect(hasRoom(snap({ mem_used_kb: 60 * GB - MIN_AVAILABLE_MEMORY_KB + 1 }), '/home/u/w')).toBe(false);
    expect(hasRoom(snap({ mem_used_kb: 60 * GB - MIN_AVAILABLE_MEMORY_KB }), '/home/u/w')).toBe(true);
    expect(hasRoom(snap({ load: [12, 1, 1] }), '/home/u/w')).toBe(false);
    expect(hasRoom(snap({ load: [11.9, 1, 1] }), '/home/u/w')).toBe(true);
  });

  it('reads the disk of the mount that holds the directory, not the root', () => {
    expect(freeDiskKb(snap(), '/mnt/hd/worktrees')).toBe(10 * GB);
    expect(hasRoom(snap(), '/mnt/hd/worktrees')).toBe(false);
    expect(freeDiskKb(snap(), '/mnt/hdx/a')).toBe(93 * GB); // not a prefix by path segment
    expect(MIN_FREE_DISK_KB).toBe(20 * GB);
  });

  it('missing readings mean no room', () => {
    expect(hasRoom(snap({ mem_total_kb: null }), '/a')).toBe(false);
    expect(hasRoom(snap({ load: null }), '/a')).toBe(false);
    expect(hasRoom(snap({ ncpu: null }), '/a')).toBe(false);
    expect(hasRoom(snap({ disks: [] }), '/a')).toBe(false);
  });

  it('macOS: the data volume holds the home when "/" is hidden', () => {
    const mac = snap({ disks: [{ mount: '/System/Volumes/Data', source: 'x', size_kb: 900 * GB, used_kb: 100 * GB, avail_kb: 800 * GB }] });
    expect(freeDiskKb(mac, '/Users/u/.termhub/worktrees')).toBe(800 * GB);
  });
});

describe('createMachineRoom', () => {
  it('expands ~ with the home guessed from the project folder', async () => {
    const probe = vi.fn(async () => snap({ disks: [{ mount: '/home/u', source: 'x', size_kb: 900 * GB, used_kb: 0, avail_kb: 5 * GB }, ...snap().disks] }));
    const room = createMachineRoom({ probe });
    expect(await room.check(machine, '~/.termhub/worktrees', '/home/u/app')).toBe(false); // /home/u has only 5 GB
    expect(await room.check(machine, '~/.termhub/worktrees', '/srv/app')).toBe(true); // unknown home: the root
  });

  it('reads once a minute per machine, shares a reading in flight, and reads again after invalidate', async () => {
    let t = 0;
    const probe = vi.fn(async () => snap());
    const room = createMachineRoom({ probe, now: () => t });
    await Promise.all([room.check(machine, '/w', '/r'), room.check(machine, '/w', '/r')]);
    await room.check(machine, '/w', '/r');
    expect(probe).toHaveBeenCalledTimes(1);
    t = ROOM_CACHE_MS - 1;
    await room.check(machine, '/w', '/r');
    expect(probe).toHaveBeenCalledTimes(1);
    t = ROOM_CACHE_MS;
    await room.check(machine, '/w', '/r');
    expect(probe).toHaveBeenCalledTimes(2);
    room.invalidate('m1');
    await room.check(machine, '/w', '/r');
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('a failed reading is no room, and is not retried every tick', async () => {
    let t = 0;
    const probe = vi.fn(async () => {
      throw new Error('offline');
    });
    const warn = vi.fn();
    const room = createMachineRoom({ probe, now: () => t, log: { warn } });
    expect(await room.check(machine, '/w', '/r')).toBe(false);
    expect(await room.check(machine, '/w', '/r')).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    t = ROOM_CACHE_MS;
    await room.check(machine, '/w', '/r');
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
