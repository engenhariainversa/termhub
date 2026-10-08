import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDoctorPaths, formatDoctor, networkReport, runDoctor, type DoctorReport } from './doctor.js';

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
    tmux: { ok: true, path: '/usr/bin/tmux' },
    nodePty: { ok: true },
    spawnHelper: { ok: true, path: '/g/node-pty/prebuilds/darwin-arm64/spawn-helper', repaired: false },
    paths: [],
    network: { ok: true },
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

describe('networkReport', () => {
  it('reports a direct connection when no proxy variable is set', () => {
    expect(networkReport('https://app.termhub.dev', {})).toEqual({ ok: true });
    expect(formatDoctor({ ...baseFor(), network: { ok: true } }, { platform: 'linux' })).toContain('✓ Proxy: nenhum (conexão direta)');
  });

  it('shows the proxy for the server with its password hidden', () => {
    const report = networkReport('https://app.termhub.dev', { HTTPS_PROXY: 'http://me:s3cret@proxy.corp:3128' });
    expect(report).toEqual({ ok: true, proxy: 'http://me:***@proxy.corp:3128' });
    expect(formatDoctor({ ...baseFor(), network: report }, { platform: 'linux' })).toContain('✓ Proxy: http://me:***@proxy.corp:3128');
  });

  it('says when NO_PROXY exempts the server', () => {
    expect(networkReport('https://app.termhub.dev', { https_proxy: 'proxy.corp:3128', no_proxy: '.termhub.dev' })).toEqual({ ok: true, bypassed: true });
  });

  it('fails on a proxy the agent cannot use', () => {
    const report = networkReport('https://app.termhub.dev', { HTTPS_PROXY: 'socks5://proxy.corp:1080' });
    expect(report.ok).toBe(false);
    expect(formatDoctor({ ...baseFor(), network: report }, { platform: 'linux' })).toContain('✗ Proxy: unsupported proxy protocol socks5:');
  });

  it('checks the extra CA file', () => {
    const fakeFs = { readFileSync: (p: string) => {
      if (p === '/ca.pem') return '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n';
      throw Object.assign(new Error('nope'), { code: 'ENOENT' });
    } } as unknown as typeof fs;
    expect(networkReport(undefined, { NODE_EXTRA_CA_CERTS: '/ca.pem' }, fakeFs)).toEqual({ ok: true, extraCa: { path: '/ca.pem', ok: true } });
    const missing = networkReport(undefined, { NODE_EXTRA_CA_CERTS: '/missing.pem' }, fakeFs);
    expect(missing).toEqual({ ok: false, extraCa: { path: '/missing.pem', ok: false, error: 'ENOENT' } });
    expect(formatDoctor({ ...baseFor(), network: missing }, { platform: 'linux' })).toContain('✗ CA extra (NODE_EXTRA_CA_CERTS): /missing.pem: ENOENT');
  });
});

function baseFor(): DoctorReport {
  return {
    config: { ok: true, path: '/c' },
    server: { ok: true },
    tmux: { ok: true },
    nodePty: { ok: true },
    spawnHelper: { ok: true, path: null, repaired: false },
    paths: [],
    network: { ok: true },
  };
}
