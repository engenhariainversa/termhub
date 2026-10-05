import { HARDWARE_SCRIPT } from '@termhub/machine-ops';
import { agentRpc } from '../agent/errors.js';
import type { Machine } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';
import { REMOTE_PATH_PREFIX, runOnMachine } from '../terminal/machine-exec.js';
import { tk } from '../i18n/index.js';

/**
 * Hardware snapshot of a machine (CPU, memory, disks, temperatures, GPU, top processes),
 * collected with a portable sh script over the same channel the terminals use.
 *
 * Guarded by the "hardware" permission resource (admins, plus roles granted hardware:read).
 */

export interface HardwareDisk {
  mount: string;
  source: string;
  size_kb: number;
  used_kb: number;
  avail_kb: number;
}

export interface HardwareProcess {
  cpu: number;
  mem: number;
  command: string;
}

export interface HardwareGpu {
  name: string;
  utilization: number | null;
  mem_used_mb: number | null;
  mem_total_mb: number | null;
  temp_c: number | null;
}

export interface HardwareSnapshot {
  os: string | null;
  hostname: string | null;
  cpu_model: string | null;
  ncpu: number | null;
  uptime_s: number | null;
  load: [number, number, number] | null;
  /** 0..100 */
  cpu_pct: number | null;
  mem_total_kb: number | null;
  mem_used_kb: number | null;
  swap_total_kb: number | null;
  swap_used_kb: number | null;
  disks: HardwareDisk[];
  temps: { label: string; c: number }[];
  gpus: HardwareGpu[];
  processes: HardwareProcess[];
  collected_at: string;
}

const PSEUDO_FS = new Set(['tmpfs', 'devtmpfs', 'udev', 'overlay', 'squashfs', 'devfs', 'map', 'none', 'shm', 'efivarfs', 'autofs']);
const SKIP_MOUNTS = ['/boot', '/snap', '/run', '/dev', '/sys', '/proc', '/System/Volumes/VM', '/System/Volumes/Preboot', '/System/Volumes/Update', '/System/Volumes/xarts', '/System/Volumes/iSCPreboot', '/System/Volumes/Hardware', '/private/var/vm', '/var/lib/docker', '/Library/Developer/CoreSimulator'];
/** mounted disk images and the like: below this size they are noise, not disks */
const MIN_DISK_KB = 2 * 1024 * 1024;

const num = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const n = Number(String(s).replace(',', '.').trim());
  return Number.isFinite(n) ? n : null;
};

function cpuFromStat(a: string, b: string): number | null {
  const p = (l: string) => l.trim().split(/\s+/).slice(1).map(Number);
  const x = p(a);
  const y = p(b);
  if (x.length < 4 || y.length < 4) return null;
  const total = (v: number[]) => v.reduce((s, n) => s + n, 0);
  const idle = (v: number[]) => v[3] + (v[4] ?? 0);
  const dt = total(y) - total(x);
  if (dt <= 0) return null;
  return Math.max(0, Math.min(100, (1 - (idle(y) - idle(x)) / dt) * 100));
}

function parse(stdout: string): HardwareSnapshot {
  const snap: HardwareSnapshot = {
    os: null, hostname: null, cpu_model: null, ncpu: null, uptime_s: null, load: null, cpu_pct: null,
    mem_total_kb: null, mem_used_kb: null, swap_total_kb: null, swap_used_kb: null,
    disks: [], temps: [], gpus: [], processes: [], collected_at: new Date().toISOString(),
  };
  let stat1 = '';
  let stat2 = '';
  const mem: Record<string, number> = {};
  const vm: Record<string, number> = {};
  let pageSize = 4096;
  let memsize: number | null = null;
  let boot: number | null = null;
  let now: number | null = null;
  const seenMounts = new Set<string>();

  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const i = line.indexOf(':');
    if (i < 0) continue;
    const tag = line.slice(0, i);
    const val = line.slice(i + 1);
    switch (tag) {
      case 'OS': snap.os = val.trim() || null; break;
      case 'HOST': snap.hostname = val.trim() || null; break;
      case 'CPUMODEL': snap.cpu_model = val.trim() || null; break;
      case 'NCPU': snap.ncpu = num(val); break;
      case 'UPTIME': snap.uptime_s = num(val); break;
      case 'BOOT': boot = num(val); break;
      case 'NOW': now = num(val); break;
      case 'LOAD': {
        const l = val.trim().split(/\s+/).map(Number);
        if (l.length >= 3 && l.slice(0, 3).every(Number.isFinite)) snap.load = [l[0], l[1], l[2]];
        break;
      }
      case 'STAT1': stat1 = val; break;
      case 'STAT2': stat2 = val; break;
      case 'MEM': {
        const m = val.match(/^(\w+):\s+(\d+)/);
        if (m) mem[m[1]] = Number(m[2]);
        break;
      }
      case 'MEMSIZE': memsize = num(val); break;
      case 'VMSTAT': {
        const ps = val.match(/page size of (\d+) bytes/);
        if (ps) pageSize = Number(ps[1]);
        const m = val.match(/^\s*(Pages [^:]+|Anonymous pages|File-backed pages):\s+(\d+)/);
        if (m) vm[m[1].trim()] = Number(m[2]);
        break;
      }
      case 'SWAPUSAGE': {
        const t = val.match(/total = ([\d.]+)M/);
        const u = val.match(/used = ([\d.]+)M/);
        if (t) snap.swap_total_kb = Math.round(Number(t[1]) * 1024);
        if (u) snap.swap_used_kb = Math.round(Number(u[1]) * 1024);
        break;
      }
      case 'CPUUSAGE': {
        const idle = val.match(/([\d.]+)% idle/);
        if (idle) snap.cpu_pct = Math.max(0, Math.min(100, 100 - Number(idle[1])));
        break;
      }
      case 'DISK': {
        const [source, size, used, avail, mount] = val.split('\t');
        if (!mount || !mount.startsWith('/') || seenMounts.has(mount)) break;
        if (PSEUDO_FS.has(source) || source.startsWith('fuse.') || SKIP_MOUNTS.some((p) => mount === p || mount.startsWith(p + '/'))) break;
        const sz = num(size); const us = num(used); const av = num(avail);
        if (sz === null || us === null || av === null || sz < MIN_DISK_KB) break;
        seenMounts.add(mount);
        snap.disks.push({ mount, source, size_kb: sz, used_kb: us, avail_kb: av });
        break;
      }
      case 'TEMP': {
        const [label, milli] = val.split('\t');
        const c = num(milli);
        if (c !== null && c > 0) snap.temps.push({ label: (label || 'temp').trim(), c: c > 1000 ? c / 1000 : c });
        break;
      }
      case 'GPU': {
        const [name, util, mu, mt, t] = val.split(',').map((s) => s.trim());
        if (name) snap.gpus.push({ name, utilization: num(util), mem_used_mb: num(mu), mem_total_mb: num(mt), temp_c: num(t) });
        break;
      }
      case 'PROC': {
        const m = val.trim().match(/^([\d.,]+)\s+([\d.,]+)\s+(.+)$/);
        if (!m) break;
        const cpu = num(m[1]); const pm = num(m[2]);
        if (cpu === null || pm === null) break;
        const command = m[3].split('/').pop() ?? m[3];
        if (command === 'ps' || command === 'top') break; // the sampler itself
        snap.processes.push({ cpu, mem: pm, command });
        break;
      }
    }
  }

  if (stat1 && stat2) snap.cpu_pct = cpuFromStat(stat1, stat2);
  if (mem.MemTotal) {
    snap.mem_total_kb = mem.MemTotal;
    snap.mem_used_kb = mem.MemTotal - (mem.MemAvailable ?? 0);
  }
  if (mem.SwapTotal !== undefined) {
    snap.swap_total_kb = mem.SwapTotal;
    snap.swap_used_kb = mem.SwapTotal - (mem.SwapFree ?? 0);
  }
  if (memsize) {
    snap.mem_total_kb = Math.round(memsize / 1024);
    // Activity Monitor's "memory used": app (anonymous) + wired + compressed
    const pages = (vm['Anonymous pages'] ?? vm['Pages active'] ?? 0) + (vm['Pages wired down'] ?? 0) + (vm['Pages occupied by compressor'] ?? 0);
    snap.mem_used_kb = Math.round((pages * pageSize) / 1024);
  }
  if (boot && now) snap.uptime_s = now - boot;
  // macOS: "/" is the sealed system snapshot; the real usage of that APFS container is on /System/Volumes/Data
  if (snap.os === 'macos' && snap.disks.some((d) => d.mount === '/System/Volumes/Data')) snap.disks = snap.disks.filter((d) => d.mount !== '/');
  snap.disks.sort((a, b) => (a.mount === '/' ? -1 : b.mount === '/' ? 1 : a.mount.localeCompare(b.mount)));
  snap.temps = snap.temps.slice(0, 8);
  return snap;
}

export async function collectHardware(machine: Machine): Promise<HardwareSnapshot> {
  let stdout: string;
  if (machine.type === 'agent') {
    ({ stdout } = await agentRpc(machine, 'hw.probe', {}));
  } else {
    const r = await runOnMachine(machine, { file: '/bin/sh', args: ['-c', HARDWARE_SCRIPT] }, `${REMOTE_PATH_PREFIX}${HARDWARE_SCRIPT}`, 15000);
    if (r.timedOut) throw new HttpError(504, 'A máquina demorou para responder');
    if (r.code !== 0) throw new HttpError(502, machine.type === 'ssh' ? tk('Máquina inacessível via SSH') : tk('Falha ao coletar o hardware'));
    stdout = r.stdout;
  }
  const snap = parse(stdout);
  if (!snap.os) throw new HttpError(502, 'Resposta inesperada da máquina');
  return snap;
}
