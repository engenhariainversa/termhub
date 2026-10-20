import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let home: string;
const ORIGINAL_ENV = process.env.TERMHUB_AGENT_HOME;

async function freshConfigModule() {
  // config.ts reads process.env.TERMHUB_AGENT_HOME lazily inside agentHome(), so a plain
  // re-import (no vi.resetModules needed) already picks up the env var set in beforeEach.
  return import('./config.js');
}

describe('config store', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-agent-'));
    process.env.TERMHUB_AGENT_HOME = home;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.TERMHUB_AGENT_HOME;
    else process.env.TERMHUB_AGENT_HOME = ORIGINAL_ENV;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('agentHome() honors TERMHUB_AGENT_HOME', async () => {
    const { agentHome } = await freshConfigModule();
    expect(agentHome()).toBe(home);
  });

  it('agentHome() falls back to ~/.termhub', async () => {
    delete process.env.TERMHUB_AGENT_HOME;
    const { agentHome } = await freshConfigModule();
    expect(agentHome()).toBe(path.join(os.homedir(), '.termhub'));
  });

  it('writeConfig() creates the dir at 0700 and the file at 0600', async () => {
    const { writeConfig } = await freshConfigModule();
    writeConfig({
      url: 'https://app.termhub.dev',
      token: 'thb_ag_' + 'a'.repeat(43),
      machine_id: 'm1',
      machine_name: 'mini',
      created_at: new Date().toISOString(),
    });

    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(home, 'config.json')).mode & 0o777).toBe(0o600);
  });

  it('a key config needs its machine id and no token; a bearer config needs its token (TER-1017)', async () => {
    const { writeConfig, readConfig } = await freshConfigModule();
    const base = { url: 'https://app.termhub.dev', machine_name: 'mini', created_at: new Date().toISOString() };
    writeConfig({ ...base, credential: 'key', machine_id: 'm-42' });
    expect(readConfig()).toEqual({ ...base, credential: 'key', machine_id: 'm-42' });
    writeConfig({ ...base, credential: 'key', machine_id: '' });
    expect(readConfig()).toBeNull();
    writeConfig({ ...base, credential: 'bearer', machine_id: '' });
    expect(readConfig()).toBeNull();
  });

  it('readConfig() round-trips what writeConfig() wrote', async () => {
    const { writeConfig, readConfig } = await freshConfigModule();
    const config = {
      url: 'https://app.termhub.dev',
      token: 'thb_ag_' + 'b'.repeat(43),
      machine_id: 'm2',
      machine_name: 'workstation',
      created_at: new Date().toISOString(),
    };
    writeConfig(config);
    // a config written before TER-1017 has no `credential`: it reads as the bearer it is
    expect(readConfig()).toEqual({ ...config, credential: 'bearer' });
  });

  it('readConfig() returns null when there is no config file', async () => {
    const { readConfig } = await freshConfigModule();
    expect(readConfig()).toBeNull();
  });

  it('readConfig() returns null on corrupt JSON', async () => {
    const { readConfig } = await freshConfigModule();
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'config.json'), '{ not json', 'utf8');
    expect(readConfig()).toBeNull();
  });

  it('readConfig() returns null when the shape does not match the schema', async () => {
    const { readConfig } = await freshConfigModule();
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ url: 'https://x' }), 'utf8');
    expect(readConfig()).toBeNull();
  });

  it('deleteConfig() removes the file and is a no-op when already gone', async () => {
    const { writeConfig, readConfig, deleteConfig } = await freshConfigModule();
    writeConfig({
      url: 'https://app.termhub.dev',
      token: 'thb_ag_' + 'c'.repeat(43),
      machine_id: 'm3',
      machine_name: 'laptop',
      created_at: new Date().toISOString(),
    });
    deleteConfig();
    expect(readConfig()).toBeNull();
    expect(() => deleteConfig()).not.toThrow();
  });
});
