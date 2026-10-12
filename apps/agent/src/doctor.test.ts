import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDoctorPaths, formatDoctor, runDoctor, type DoctorReport } from './doctor.js';

describe('runDoctor', () => {
  let home: string;
  const ORIGINAL_ENV = process.env.TERMHUB_AGENT_HOME;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-agent-doctor-'));
    process.env.TERMHUB_AGENT_HOME = home;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.TERMHUB_AGENT_HOME;
    else process.env.TERMHUB_AGENT_HOME = ORIGINAL_ENV;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('reports config:ok=false when there is no config file', async () => {
    const report = await runDoctor([], { connect: vi.fn() });
    expect(report.config.ok).toBe(false);
    expect(report.config.path).toBe(path.join(home, 'config.json'));
    expect(report.server).toEqual({ ok: false, error: 'sem configuração' });
  });

  it('checks the server through the injected connect() once a config exists', async () => {
    const { writeConfig } = await import('./config.js');
    writeConfig({
      url: 'https://app.termhub.dev',
      token: 'thb_ag_' + 'a'.repeat(43),
      machine_id: '',
      machine_name: '',
      created_at: new Date().toISOString(),
    });

    const connect = vi.fn().mockResolvedValue({ ok: true });
    const report = await runDoctor([], { connect });
    expect(report.config.ok).toBe(true);
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://app.termhub.dev' }), expect.any(Number));
    expect(report.server).toEqual({ ok: true });
  });

  it('POSTs to the hooks and MCP addresses the probe returned, ok only on 401', async () => {
    const { writeConfig } = await import('./config.js');
    writeConfig({ url: 'https://app.termhub.dev', token: 'thb_ag_' + 'a'.repeat(43), machine_id: '', machine_name: '', created_at: new Date().toISOString() });
    const connect = vi.fn().mockResolvedValue({ ok: true, endpoints: { hooks_url: 'https://termhub.dev/api/hooks/events', mcp_url: 'https://termhub.dev/mcp' } });
    const check = vi.fn(async (url: string) => (url.endsWith('/mcp') ? { url, status: null, error: 'ECONNREFUSED' } : { url, status: 401, error: null }));
    const report = await runDoctor([], { connect, check });
    expect(check).toHaveBeenCalledTimes(2);
    expect(report.server).toEqual({ ok: true });
    expect(report.endpoints).toEqual([
      { name: 'hooks', url: 'https://termhub.dev/api/hooks/events', host: 'termhub.dev', ok: true, status: 401, error: null },
      { name: 'mcp', url: 'https://termhub.dev/mcp', host: 'termhub.dev', ok: false, status: null, error: 'ECONNREFUSED' },
    ]);
  });

  it('skips the MCP check when the server has no MCP address, and both when the server sent none', async () => {
    const { writeConfig } = await import('./config.js');
    writeConfig({ url: 'https://app.termhub.dev', token: 'thb_ag_' + 'a'.repeat(43), machine_id: '', machine_name: '', created_at: new Date().toISOString() });
    const check = vi.fn(async (url: string) => ({ url, status: 401, error: null }));
    const one = await runDoctor([], { connect: vi.fn().mockResolvedValue({ ok: true, endpoints: { hooks_url: 'https://h.example/api/hooks/events', mcp_url: null } }), check });
    expect(one.endpoints.map((e) => e.name)).toEqual(['hooks']);
    const none = await runDoctor([], { connect: vi.fn().mockResolvedValue({ ok: true }), check });
    expect(none.endpoints).toEqual([]);
  });

  it('reports ok:false with error "eperm" for a path that throws EPERM, ok:true for one that succeeds', async () => {
    const eperm = Object.assign(new Error('permission denied'), { code: 'EPERM' });
    const fakeFs = {
      readdirSync: vi.fn((p: string) => {
        if (p === '/blocked') throw eperm;
        return [];
      }),
    };

    const report = await runDoctor(['/ok', '/blocked'], { fs: fakeFs as unknown as typeof fs, connect: vi.fn() });

    expect(report.paths).toEqual([
      { path: '/ok', ok: true },
      { path: '/blocked', ok: false, error: 'eperm' },
    ]);
  });

  it('maps EACCES to "eperm" too', async () => {
    const eacces = Object.assign(new Error('access denied'), { code: 'EACCES' });
    const fakeFs = { readdirSync: vi.fn(() => { throw eacces; }) };
    const report = await runDoctor(['/nope'], { fs: fakeFs as unknown as typeof fs, connect: vi.fn() });
    expect(report.paths).toEqual([{ path: '/nope', ok: false, error: 'eperm' }]);
  });
});

describe('defaultDoctorPaths', () => {
  it('includes HOME, Documents and Desktop', () => {
    const home = os.homedir();
    const paths = defaultDoctorPaths();
    expect(paths).toContain(home);
    expect(paths).toContain(path.join(home, 'Documents'));
    expect(paths).toContain(path.join(home, 'Desktop'));
  });
});

describe('formatDoctor', () => {
  const baseReport: DoctorReport = {
    config: { ok: true, path: '/home/x/.termhub/config.json' },
    server: { ok: true },
    endpoints: [],
    tmux: { ok: true, path: '/usr/bin/tmux' },
    nodePty: { ok: true },
    spawnHelper: { ok: true, path: '/g/node-pty/prebuilds/darwin-arm64/spawn-helper', repaired: false },
    paths: [],
  };

  it('tells the user when the spawn-helper could not be made executable', () => {
    const text = formatDoctor({ ...baseReport, spawnHelper: { ok: false, path: '/g/spawn-helper', repaired: false, error: 'EACCES' } }, { platform: 'darwin' });
    expect(text).toContain('✗ spawn-helper do node-pty sem permissão de execução: EACCES');
    expect(text).toContain('chmod +x "/g/spawn-helper"');
  });

  it('mentions when the spawn-helper was just repaired', () => {
    const text = formatDoctor({ ...baseReport, spawnHelper: { ok: true, path: '/g/spawn-helper', repaired: true } }, { platform: 'darwin' });
    expect(text).toContain('permissão de execução corrigida agora');
  });

  it('shows each address with its host, and what to open in the firewall when it fails', () => {
    const text = formatDoctor({
      ...baseReport,
      endpoints: [
        { name: 'hooks', url: 'https://termhub.dev/api/hooks/events', host: 'termhub.dev', ok: true, status: 401, error: null },
        { name: 'mcp', url: 'https://termhub.dev/mcp', host: 'termhub.dev', ok: false, status: 403, error: null },
      ],
    }, { platform: 'linux' });
    expect(text).toContain('✓ Hooks do monitor (termhub.dev)');
    expect(text).toContain('✗ MCP das abas (termhub.dev): respondeu HTTP 403 (esperado 401)');
    expect(text).toContain('libere https://termhub.dev/mcp no firewall/proxy');
  });

  it('marks every ok check with ✓ and includes the config path', () => {
    const text = formatDoctor(baseReport, { platform: 'linux' });
    expect(text).toContain('✓ Configuração (/home/x/.termhub/config.json)');
    expect(text).not.toContain('✗');
  });

  it('appends the Full Disk Access note (with process.execPath) on macOS for an eperm path', () => {
    const report: DoctorReport = { ...baseReport, paths: [{ path: '/Volumes/Data', ok: false, error: 'eperm' }] };
    const text = formatDoctor(report, { platform: 'darwin', execPath: '/usr/local/bin/node' });
    expect(text).toContain('Acesso Total ao Disco');
    expect(text).toContain('/usr/local/bin/node');
  });

  it('omits the Full Disk Access note on linux even for an eperm path', () => {
    const report: DoctorReport = { ...baseReport, paths: [{ path: '/blocked', ok: false, error: 'eperm' }] };
    const text = formatDoctor(report, { platform: 'linux', execPath: '/usr/bin/node' });
    expect(text).not.toContain('Acesso Total ao Disco');
    expect(text).toContain('✗ /blocked: eperm');
  });

  it('defaults platform/execPath to the real process when not given', () => {
    const report: DoctorReport = { ...baseReport, paths: [{ path: '/blocked', ok: false, error: 'eperm' }] };
    const text = formatDoctor(report);
    if (process.platform === 'darwin') {
      expect(text).toContain(process.execPath);
    } else {
      expect(text).not.toContain('Acesso Total ao Disco');
    }
  });
});
