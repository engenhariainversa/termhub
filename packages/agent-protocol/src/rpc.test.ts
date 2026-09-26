import { describe, expect, it } from 'vitest';
import { RPC, RPC_METHODS, isWdaPort, rpcErrorSchema } from './rpc.js';

describe('rpc catalog', () => {
  it('lists the v1 methods', () => {
    expect([...RPC_METHODS].sort()).toEqual([
      'agent.update', 'ai.credential', 'claude.linkSession', 'file.paste', 'fs.list', 'fs.mkdir', 'hooks.install', 'hooks.uninstall', 'hw.probe',
      'sim.boot', 'sim.list', 'tmux.capture', 'tmux.ensure', 'tmux.kill', 'tmux.list', 'tmux.sendKey', 'tmux.sendText', 'tools.detect',
      'wda.runner.alive', 'wda.runner.start', 'wda.runner.tail', 'wda.setup.start', 'wda.setup.state',
    ]);
  });
  it('validates udids and the WDA port ranges for the simulator rpcs', () => {
    const good = 'BAE07EB5-8CA8-4C6E-819A-A0240342FF00';
    expect(RPC['sim.boot'].params.safeParse({ udid: good }).success).toBe(true);
    expect(RPC['sim.boot'].params.safeParse({ udid: 'x; rm -rf /' }).success).toBe(false);
    expect(RPC['sim.boot'].timeoutMs).toBe(60_000);
    expect(RPC['sim.list'].timeoutMs).toBe(15_000);
    expect(RPC['wda.runner.start'].params.safeParse({ udid: good, wda_port: 8137, mjpeg_port: 9137 }).success).toBe(true);
    expect(RPC['wda.runner.start'].params.safeParse({ udid: good, wda_port: 8200, mjpeg_port: 9137 }).success).toBe(false);
    expect(RPC['wda.runner.start'].params.safeParse({ udid: good, wda_port: 8137, mjpeg_port: 22 }).success).toBe(false);
    expect(RPC['wda.runner.tail'].params.safeParse({ udid: good, lines: 30 }).success).toBe(true);
    expect(RPC['wda.runner.tail'].params.safeParse({ udid: good, lines: 0 }).success).toBe(false);
    expect(RPC['wda.runner.tail'].params.safeParse({ udid: good, lines: 201 }).success).toBe(false);
    expect(RPC['wda.setup.start'].params.safeParse({}).success).toBe(true);
    expect(RPC['wda.setup.state'].result.safeParse({ stdout: 'STATE:idle\n' }).success).toBe(true);
    expect(RPC['wda.runner.alive'].result.safeParse({ alive: true }).success).toBe(true);
    expect(RPC['wda.runner.tail'].result.safeParse({ lines: ['a', 'b'] }).success).toBe(true);
    expect(RPC['wda.runner.start'].result.safeParse({ started: false }).success).toBe(true);
  });
  it('knows the WDA port ranges', () => {
    expect(isWdaPort(8100)).toBe(true);
    expect(isWdaPort(8199)).toBe(true);
    expect(isWdaPort(9100)).toBe(true);
    expect(isWdaPort(9199)).toBe(true);
    expect(isWdaPort(8099)).toBe(false);
    expect(isWdaPort(8200)).toBe(false);
    expect(isWdaPort(9200)).toBe(false);
    expect(isWdaPort(80)).toBe(false);
    expect(isWdaPort(8100.5)).toBe(false);
  });
  it('accepts refused as an rpc error code', () => {
    expect(rpcErrorSchema.safeParse({ code: 'refused', message: 'nothing listening' }).success).toBe(true);
  });
  it('validates agent.update versions', () => {
    expect(RPC['agent.update'].params.safeParse({ version: '0.2.1' }).success).toBe(true);
    expect(RPC['agent.update'].params.safeParse({ version: 'latest' }).success).toBe(false);
    expect(RPC['agent.update'].params.safeParse({ version: '0.2.1; rm -rf /' }).success).toBe(false);
    expect(RPC['agent.update'].timeoutMs).toBe(180_000);
  });
  it('validates tmux session names', () => {
    expect(RPC['tmux.kill'].params.safeParse({ session: 'th-abc_1' }).success).toBe(true);
    expect(RPC['tmux.kill'].params.safeParse({ session: 'bad name' }).success).toBe(false);
    expect(RPC['tmux.capture'].params.safeParse({ session: 'a', lines: 6000 }).success).toBe(false);
  });
  it('validates paths for fs.list', () => {
    expect(RPC['fs.list'].params.safeParse({ path: '~/proj' }).success).toBe(true);
    expect(RPC['fs.list'].params.safeParse({ path: 'relative' }).success).toBe(false);
    expect(RPC['fs.list'].params.safeParse({ path: '/a\nb' }).success).toBe(false);
  });
  it('fs.mkdir takes an optional recursive flag', () => {
    expect(RPC['fs.mkdir'].params.safeParse({ parent: '/a', name: 'b' }).success).toBe(true);
    expect(RPC['fs.mkdir'].params.safeParse({ parent: '/a', name: 'b', recursive: true }).success).toBe(true);
    expect(RPC['fs.mkdir'].params.safeParse({ parent: '/a', name: 'b', recursive: 'yes' }).success).toBe(false);
    expect(RPC['fs.mkdir'].params.safeParse({ parent: '/a', name: 'b/c' }).success).toBe(false);
  });
  it('bounds file.paste', () => {
    expect(RPC['file.paste'].params.safeParse({ name: 'paste-1.png', data_b64: 'AAAA' }).success).toBe(true);
    expect(RPC['file.paste'].params.safeParse({ name: '../x', data_b64: 'AAAA' }).success).toBe(false);
    expect(RPC['file.paste'].timeoutMs).toBe(60_000);
    expect(RPC['hw.probe'].timeoutMs).toBe(15_000);
    expect(RPC['tmux.list'].timeoutMs).toBe(8_000);
    expect(RPC['ai.credential'].timeoutMs).toBe(10_000); // same as the ssh path's credential read
  });
  it('validates claude.linkSession params and result', () => {
    const good = { transcript_path: '/h/.claude/projects/-p/6d127d73-4bd0-42d6-b4a6-d96899507e62.jsonl', session_id: '6d127d73-4bd0-42d6-b4a6-d96899507e62', config_dir: '~/.claude-work' };
    expect(RPC['claude.linkSession'].params.safeParse(good).success).toBe(true);
    expect(RPC['claude.linkSession'].params.safeParse({ ...good, session_id: 'not-a-uuid' }).success).toBe(false);
    expect(RPC['claude.linkSession'].params.safeParse({ ...good, config_dir: null }).success).toBe(true);
    expect(RPC['claude.linkSession'].result.safeParse({ status: 'linked' }).success).toBe(true);
    expect(RPC['claude.linkSession'].result.safeParse({ status: 'bogus' }).success).toBe(false);
    expect(RPC['claude.linkSession'].timeoutMs).toBe(10_000);
  });
  it('bounds hooks.install', () => {
    expect(RPC['hooks.install'].params.safeParse({ hooks_url: 'https://app.termhub.dev/api/hooks', token: 'thb_hk_abc-123' }).success).toBe(true);
    expect(RPC['hooks.install'].params.safeParse({ hooks_url: 'ftp://x', token: 'a' }).success).toBe(false);
    expect(RPC['hooks.install'].params.safeParse({ hooks_url: "https://x/'; rm -rf ~", token: 'a' }).success).toBe(false);
    expect(RPC['hooks.install'].params.safeParse({ hooks_url: 'https://x', token: "a'b" }).success).toBe(false);
    expect(RPC['hooks.install'].timeoutMs).toBe(15_000);
    expect(RPC['hooks.uninstall'].params.safeParse({}).success).toBe(true);
  });
  it('shapes rpc errors', () => {
    expect(rpcErrorSchema.parse({ code: 'eperm', message: 'x', path: '/v' }).code).toBe('eperm');
    expect(rpcErrorSchema.safeParse({ code: 'boom', message: 'x' }).success).toBe(false);
  });
  it('tmux.capture takes an optional escapes flag and may say so in its result', () => {
    expect(RPC['tmux.capture'].params.safeParse({ session: 'a', lines: 15, escapes: true }).success).toBe(true);
    expect(RPC['tmux.capture'].params.safeParse({ session: 'a', lines: 15 }).success).toBe(true);
    expect(RPC['tmux.capture'].params.safeParse({ session: 'a', lines: 15, escapes: 'yes' }).success).toBe(false);
    expect(RPC['tmux.capture'].result.safeParse({ text: 'x' }).success).toBe(true); // an agent older than 0.5.2
    expect(RPC['tmux.capture'].result.safeParse({ text: 'x', escapes: true }).success).toBe(true);
  });
});

describe('terminal RPCs', () => {
  it('tmux.ensure takes a session and an absolute or ~ cwd', () => {
    expect(RPC['tmux.ensure'].params.safeParse({ session: 'termhub-p1-t1', cwd: '/home/u/app' }).success).toBe(true);
    expect(RPC['tmux.ensure'].params.safeParse({ session: 'termhub-p1-t1', cwd: '~/app' }).success).toBe(true);
    expect(RPC['tmux.ensure'].params.safeParse({ session: 'termhub-p1-t1', cwd: 'app' }).success).toBe(false);
    expect(RPC['tmux.ensure'].params.safeParse({ session: 'bad name', cwd: '/tmp' }).success).toBe(false);
  });

  it('tmux.sendText caps the text at 4000 chars and keeps enter explicit', () => {
    expect(RPC['tmux.sendText'].params.safeParse({ session: 's', text: 'oi', enter: true }).success).toBe(true);
    expect(RPC['tmux.sendText'].params.safeParse({ session: 's', text: '', enter: true }).success).toBe(true);
    expect(RPC['tmux.sendText'].params.safeParse({ session: 's', text: 'x'.repeat(4001), enter: false }).success).toBe(false);
    expect(RPC['tmux.sendText'].params.safeParse({ session: 's', text: 'oi' }).success).toBe(false);
  });

  it('tmux.sendText accepts an optional paste flag, defaulting to unset', () => {
    expect(RPC['tmux.sendText'].params.safeParse({ session: 's', text: 'linha um\nlinha dois', enter: true, paste: true }).success).toBe(true);
    expect(RPC['tmux.sendText'].params.safeParse({ session: 's', text: 'oi', enter: true, paste: false }).success).toBe(true);
    const parsed = RPC['tmux.sendText'].params.safeParse({ session: 's', text: 'oi', enter: true });
    expect(parsed.success && parsed.data.paste).toBeUndefined();
  });

  it('tmux.sendKey only accepts the closed key list', () => {
    for (const key of ['Enter', 'Escape', 'C-c', 'Up', 'Down', 'Tab', 'y', 'n', '1', '9']) {
      expect(RPC['tmux.sendKey'].params.safeParse({ session: 's', key }).success).toBe(true);
    }
    for (const key of ['C-d', 'q', '0', 'Left', '']) {
      expect(RPC['tmux.sendKey'].params.safeParse({ session: 's', key }).success).toBe(false);
    }
  });

  it('gives the terminal RPCs a 10 s budget (a machine that does not answer fails fast)', () => {
    expect(RPC['tmux.ensure'].timeoutMs).toBe(10_000);
    expect(RPC['tmux.sendText'].timeoutMs).toBe(10_000);
    expect(RPC['tmux.sendKey'].timeoutMs).toBe(10_000);
  });
});
