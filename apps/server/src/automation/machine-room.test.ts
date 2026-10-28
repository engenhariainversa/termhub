import { describe, expect, it, vi } from 'vitest';
import type { Machine } from '../db/repositories/types.js';
import type { HardwareSnapshot } from '../system/hardware.js';
import { createMachineRoom, freeDiskKb, hasRoom, lastRoomOf, MIN_AVAILABLE_MEMORY_KB, MIN_FREE_DISK_KB, resetLastRooms, ROOM_CACHE_MS, roomReading } from './machine-room.js';

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

describe('roomReading (TER-1138)', () => {
  const at = new Date('2026-10-28T10:00:00Z');
  it('names the limit that failed, with the values read', () => {
    expect(roomReading(snap(), '/home/u/w', at)).toEqual({ ok: true, limit: null, mem_available_kb: 42 * GB, disk_free_kb: 93 * GB, disk_mount: '/', load1: 3, ncpu: 12, at: at.toISOString() });
    expect(roomReading(snap({ mem_used_kb: 58 * GB }), '/home/u/w', at)).toMatchObject({ ok: false, limit: 'memory', mem_available_kb: 2 * GB });
    expect(roomReading(snap(), '/mnt/hd/w', at)).toMatchObject({ ok: false, limit: 'disk', disk_free_kb: 10 * GB, disk_mount: '/mnt/hd' });
    expect(roomReading(snap({ load: [14.5, 1, 1] }), '/home/u/w', at)).toMatchObject({ ok: false, limit: 'load', load1: 14.5, ncpu: 12 });
  });

  it('memory comes first, then disk, then load; a missing value fails its own limit', () => {
    expect(roomReading(snap({ mem_used_kb: 58 * GB, load: [20, 1, 1] }), '/mnt/hd/w', at).limit).toBe('memory');
    expect(roomReading(snap({ load: [20, 1, 1] }), '/mnt/hd/w', at).limit).toBe('disk');
    expect(roomReading(snap({ mem_total_kb: null }), '/a', at)).toMatchObject({ limit: 'memory', mem_available_kb: null });
    expect(roomReading(snap({ disks: [] }), '/a', at)).toMatchObject({ limit: 'disk', disk_free_kb: null, disk_mount: null });
    expect(roomReading(snap({ ncpu: 0 }), '/a', at)).toMatchObject({ limit: 'load', ncpu: null });
  });
});

describe('createMachineRoom', () => {
  it('keeps the last check of each machine for list_machines and the idle-tab sweep', async () => {
    resetLastRooms();
    const room = createMachineRoom({ probe: async () => snap({ mem_used_kb: 58 * GB }), now: () => Date.parse('2026-10-28T10:00:00Z') });
    expect(lastRoomOf('m1')).toBeNull();
    await room.check(machine, '/w', '/r');
    expect(lastRoomOf('m1')).toMatchObject({ ok: false, limit: 'memory', at: '2026-10-28T10:00:00.000Z' });
  });

  it('expands ~ with the home guessed from the project folder', async () => {
    const probe = vi.fn(async () => snap({ disks: [{ mount: '/home/u', source: 'x', size_kb: 900 * GB, used_kb: 0, avail_kb: 5 * GB }, ...snap().disks] }));
    const room = createMachineRoom({ probe });
    expect(await room.check(machine, '~/.termhub/worktrees', '/home/u/app')).toMatchObject({ ok: false, limit: 'disk', disk_mount: '/home/u' }); // /home/u has only 5 GB
    expect(await room.check(machine, '~/.termhub/worktrees', '/srv/app')).toMatchObject({ ok: true, limit: null, disk_mount: '/' }); // unknown home: the root
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
    expect(await room.check(machine, '/w', '/r')).toMatchObject({ ok: false, limit: 'reading', mem_available_kb: null });
    expect((await room.check(machine, '/w', '/r')).ok).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    t = ROOM_CACHE_MS;
    await room.check(machine, '/w', '/r');
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
