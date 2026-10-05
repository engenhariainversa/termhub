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
  const under = (mount: string) => mount === '/' || path === mount || path.startsWith(`${mount}/`);
  const best = snap.disks.filter((d) => under(d.mount)).sort((a, b) => b.mount.length - a.mount.length)[0];
  // macOS: "/" is hidden behind the data volume (see collectHardware)
  const disk = best ?? snap.disks.find((d) => d.mount === '/System/Volumes/Data');
  return disk ? disk.avail_kb : null;
}

/** Whether a reading leaves room for a run whose worktrees live under `worktreesPath`. Missing data = no room. */
export function hasRoom(snap: HardwareSnapshot, worktreesPath: string): boolean {
  if (snap.mem_total_kb === null || snap.mem_used_kb === null) return false;
  if (snap.mem_total_kb - snap.mem_used_kb < MIN_AVAILABLE_MEMORY_KB) return false;
  const disk = freeDiskKb(snap, worktreesPath);
  if (disk === null || disk < MIN_FREE_DISK_KB) return false;
  if (!snap.load || snap.ncpu === null || snap.ncpu <= 0) return false;
  return snap.load[0] < snap.ncpu;
}

export interface MachineRoom {
  /** `worktreesDir` as set in the project's setup, `repoDir` the project's folder on this machine. */
  check(machine: Machine, worktreesDir: string, repoDir: string): Promise<boolean>;
  /** Forgets the reading: the next check reads again (after a start, so it includes that run). */
  invalidate(machineId: string): void;
}

export function createMachineRoom(o: { probe?: Probe; now?: () => number; log?: { warn: (o: object, m: string) => void } } = {}): MachineRoom {
  const probe = o.probe ?? collectHardware;
  const now = o.now ?? Date.now;
  const cache = new Map<string, { at: number; snap: HardwareSnapshot | null }>();
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
      return snap !== null && hasRoom(snap, expandHome(worktreesDir, repoDir));
    },
    invalidate: (id) => void cache.delete(id),
  };
}
