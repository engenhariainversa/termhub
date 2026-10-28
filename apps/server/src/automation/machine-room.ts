import type { Machine } from '../db/repositories/types.js';
import { collectHardware, type HardwareSnapshot } from '../system/hardware.js';

/**
 * Room on a machine for one more automatic run (spike R6). Read live from `hw.probe` (the agent RPC that
 * collects CPU, memory, load and disks) and cached per machine, so a tick every 15 s costs one probe a
 * minute at most. Only automatic placement calls it: manual flows (Máquinas, `start_agent`) never wait on it.
 */
export const MIN_AVAILABLE_MEMORY_KB = 4 * 1024 * 1024;
export const MIN_FREE_DISK_KB = 20 * 1024 * 1024;
export const ROOM_CACHE_MS = 60_000;

export type Probe = (machine: Machine) => Promise<HardwareSnapshot>;

/** The first directories of an absolute path guess the home of `~` (`/home/u`, `/Users/u`); else the root. */
function expandHome(path: string, hintCwd: string): string {
  if (path !== '~' && !path.startsWith('~/')) return path;
  const home = /^\/(?:home|Users)\/[^/]+/.exec(hintCwd)?.[0] ?? '';
  return `${home}${path.slice(1)}` || '/';
}

/** Free space (kB) on the mount that holds `path`: the longest mount point that is a prefix of it. */
export function freeDiskKb(snap: HardwareSnapshot, path: string): number | null {
  return diskOf(snap, path)?.avail_kb ?? null;
}

/** Which limit left a machine without room (TER-1138); `reading` = the probe failed, nothing was read. */
export type RoomLimit = 'memory' | 'disk' | 'load' | 'reading';

/**
 * A room check with what it read (TER-1138): the queue, the watcher and the concierge say which limit was hit
 * and by how much, not only "no room". Numbers and the mount point only; null = not in the reading.
 */
export interface RoomReading {
  ok: boolean;
  /** the first limit that failed, in the order memory, disk, load; null when there is room */
  limit: RoomLimit | null;
  mem_available_kb: number | null;
  disk_free_kb: number | null;
  /** the mount that holds the worktrees directory */
  disk_mount: string | null;
  load1: number | null;
  ncpu: number | null;
  /** when the machine was read (ISO) */
  at: string;
}

/** The mount that holds `path`: the longest mount point that is a prefix of it. */
function diskOf(snap: HardwareSnapshot, path: string) {
  const under = (mount: string) => mount === '/' || path === mount || path.startsWith(`${mount}/`);
  const best = snap.disks.filter((d) => under(d.mount)).sort((a, b) => b.mount.length - a.mount.length)[0];
  // macOS: "/" is hidden behind the data volume (see collectHardware)
  return best ?? snap.disks.find((d) => d.mount === '/System/Volumes/Data') ?? null;
}

/** What a reading says about room for a run whose worktrees live under `worktreesPath`. Missing data = no room. */
export function roomReading(snap: HardwareSnapshot, worktreesPath: string, at: Date = new Date()): RoomReading {
  const mem = snap.mem_total_kb === null || snap.mem_used_kb === null ? null : snap.mem_total_kb - snap.mem_used_kb;
  const disk = diskOf(snap, worktreesPath);
  const load1 = snap.load ? snap.load[0] : null;
  const ncpu = snap.ncpu !== null && snap.ncpu > 0 ? snap.ncpu : null;
  const limit: RoomLimit | null =
    mem === null || mem < MIN_AVAILABLE_MEMORY_KB ? 'memory' : !disk || disk.avail_kb < MIN_FREE_DISK_KB ? 'disk' : load1 === null || ncpu === null || load1 >= ncpu ? 'load' : null;
  return { ok: limit === null, limit, mem_available_kb: mem, disk_free_kb: disk?.avail_kb ?? null, disk_mount: disk?.mount ?? null, load1, ncpu, at: at.toISOString() };
}

/** A failed reading: no room, nothing known. */
export const failedReading = (at: Date): RoomReading => ({ ok: false, limit: 'reading', mem_available_kb: null, disk_free_kb: null, disk_mount: null, load1: null, ncpu: null, at: at.toISOString() });

/** Whether a reading leaves room for a run whose worktrees live under `worktreesPath`. Missing data = no room. */
export function hasRoom(snap: HardwareSnapshot, worktreesPath: string): boolean {
  return roomReading(snap, worktreesPath).ok;
}

/**
 * The last room check of each machine in this process (TER-1138), for `list_machines` and the idle-tab sweep:
 * a machine without room has its oldest idle tabs closed first. Kept in memory; a restart forgets it.
 */
const lastRooms = new Map<string, RoomReading>();

/** The last room check of a machine, or null when none was made in this process. */
export function lastRoomOf(machineId: string): RoomReading | null {
  return lastRooms.get(machineId) ?? null;
}

/** Tests only. */
export function resetLastRooms(): void {
  lastRooms.clear();
}

export interface MachineRoom {
  /** `worktreesDir` as set in the project's setup, `repoDir` the project's folder on this machine. */
  check(machine: Machine, worktreesDir: string, repoDir: string): Promise<RoomReading>;
  /** Forgets the reading: the next check reads again (after a start, so it includes that run). */
  invalidate(machineId: string): void;
}

export function createMachineRoom(o: { probe?: Probe; now?: () => number; log?: { warn: (o: object, m: string) => void } } = {}): MachineRoom {
  const probe = o.probe ?? collectHardware;
  const now = o.now ?? Date.now;
  const cache = new Map<string, { at: number; snap: HardwareSnapshot | null }>();
  const readAt = (id: string) => new Date(cache.get(id)?.at ?? now());
  const inflight = new Map<string, Promise<HardwareSnapshot | null>>();

  async function read(machine: Machine): Promise<HardwareSnapshot | null> {
    const hit = cache.get(machine.id);
    if (hit && now() - hit.at < ROOM_CACHE_MS) return hit.snap;
    const pending = inflight.get(machine.id);
    if (pending) return pending;
    const p = (async () => {
      let snap: HardwareSnapshot | null = null;
      try {
        snap = await probe(machine);
      } catch (e) {
        // a failed reading counts as no room, and is kept as long as a good one so a dead machine is not probed every tick
        o.log?.warn({ machineId: machine.id, code: (e as { code?: unknown })?.code }, 'automation: hardware reading failed');
      }
      cache.set(machine.id, { at: now(), snap });
      return snap;
    })().finally(() => inflight.delete(machine.id));
    inflight.set(machine.id, p);
    return p;
  }

  return {
    async check(machine, worktreesDir, repoDir) {
      const snap = await read(machine);
      const reading = snap ? roomReading(snap, expandHome(worktreesDir, repoDir), readAt(machine.id)) : failedReading(readAt(machine.id));
      lastRooms.set(machine.id, reading);
      return reading;
    },
    invalidate: (id) => void cache.delete(id),
  };
}
