import { describe, expect, it } from 'vitest';
import { FILE_LIST_MAX_ENTRIES, FILE_READ_MAX_BYTES, RPC, RPC_METHODS, TMUX_KEYS, docPath, isWdaPort, rpcErrorSchema, tmuxKey } from './rpc.js';

describe('rpc catalog', () => {
  it('lists the v1 methods', () => {
    expect([...RPC_METHODS].sort()).toEqual([
      'agent.uninstall', 'agent.update', 'ai.login.cancel', 'ai.login.start', 'ai.login.status', 'ai.login.submit', 'ai.usage', 'claude.linkSession', 'docs.read', 'docs.scan', 'file.list', 'file.paste', 'file.read', 'fs.list', 'fs.mkdir', 'git.worktree.ensure', 'git.worktree.remove', 'hooks.install',
      'hooks.status', 'hooks.uninstall', 'hw.probe', 'net.check', 'secret.read', 'sim.boot', 'sim.list', 'tab.mcp.remove', 'tab.mcp.write', 'tmux.capture', 'tmux.ensure', 'tmux.foreground',
      'tmux.kill', 'tmux.list', 'tmux.scroll', 'tmux.sendKey', 'tmux.sendText', 'tools.detect', 'transcript.read', 'wda.runner.alive', 'wda.runner.start', 'wda.runner.tail',
      'wda.setup.start', 'wda.setup.state',
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
    expect(rpcErrorSchema.safeParse({ code: 'worktree_conflict', message: 'x' }).success).toBe(true);
    expect(rpcErrorSchema.safeParse({ code: 'path_outside_root', message: 'x' }).success).toBe(true);
  });
  it('validates git.worktree params: branch names and machine paths', () => {
    const ok = { repo_dir: '~/code/app', root: '~/.termhub/worktrees', path: '~/.termhub/worktrees/p1/TER-1', branch: 'TER-1-slug', base: 'epic/TER-2' };
    const ensure = RPC['git.worktree.ensure'];
    expect(ensure.timeoutMs).toBe(180_000);
    expect(ensure.params.safeParse(ok).success).toBe(true);
    for (const branch of ['--upload-pack=x', '-b', 'a..b', 'a b', 'a:b', 'a;rm', '', 'x'.repeat(201)]) {
      expect(ensure.params.safeParse({ ...ok, branch }).success, branch).toBe(false);
      expect(ensure.params.safeParse({ ...ok, base: branch }).success, branch).toBe(false);
    }
    expect(ensure.params.safeParse({ ...ok, path: 'relative/dir' }).success).toBe(false);
    expect(ensure.result.safeParse({ path: '/x', head: 'a'.repeat(40), created: true }).success).toBe(true);
    const remove = RPC['git.worktree.remove'];
    expect(remove.params.safeParse({ repo_dir: ok.repo_dir, root: ok.root, path: ok.path }).success).toBe(true);
    expect(remove.result.safeParse({ removed: false, dirty: true }).success).toBe(true);
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
  });
  it('ai.usage answers bounded usage numbers, never a credential', () => {
    const def = RPC['ai.usage'];
    expect(def.timeoutMs).toBe(60_000); // up to four sequential 12 s provider calls
    expect(def.params.safeParse({ provider: 'claude', config_dir: null }).success).toBe(true);
    expect(def.params.safeParse({ provider: 'claude', config_dir: '~/.claude-work' }).success).toBe(true);
    expect(def.params.safeParse({ provider: 'claude', config_dir: 'relative' }).success).toBe(false);
    expect(def.params.safeParse({ provider: 'other', config_dir: null }).success).toBe(false);
    const ok = { ok: true, plan: 'max', windows: [{ key: 'five_hour', label: '5 horas', utilization: 12.5, resets_at: '2026-10-07T12:00:00.000Z', model: 'opus' }], error: null, hint: null };
    expect(def.result.safeParse(ok).success).toBe(true);
    expect(def.result.safeParse({ ok: false, plan: null, windows: [], error: 'x', hint: null, rate_limited: true, retry_after_ms: null }).success).toBe(true);
    expect(def.result.safeParse({ ...ok, windows: [{ ...ok.windows[0], utilization: 101 }] }).success).toBe(false);
    expect(def.result.safeParse({ ...ok, windows: Array(51).fill(ok.windows[0]) }).success).toBe(false);
    expect(def.result.safeParse({ ...ok, error: 'x'.repeat(501) }).success).toBe(false);
    expect(def.result.safeParse({ ...ok, retry_after_ms: -1 }).success).toBe(false);
    expect('ai.credential' in RPC).toBe(false);
  });
  it('ai.login.* take a provider, a config dir and a tmux session name, and bound the code', () => {
    expect(RPC['ai.login.status'].timeoutMs).toBe(20_000);
    expect(RPC['ai.login.start'].timeoutMs).toBe(45_000);
    expect(RPC['ai.login.submit'].timeoutMs).toBe(60_000);
    expect(RPC['ai.login.status'].params.safeParse({ provider: 'chatgpt', config_dir: null }).success).toBe(true);
    expect(RPC['ai.login.start'].params.safeParse({ provider: 'claude', config_dir: '~/.claude-work', session: 'termhub-login-abc' }).success).toBe(true);
    expect(RPC['ai.login.start'].params.safeParse({ provider: 'claude', config_dir: null, session: 'bad name' }).success).toBe(false);
    const submit = RPC['ai.login.submit'].params;
    expect(submit.safeParse({ provider: 'claude', config_dir: null, session: 's', code: 'abc#def' }).success).toBe(true);
    expect(submit.safeParse({ provider: 'chatgpt', config_dir: null, session: 's', code: null }).success).toBe(true);
    expect(submit.safeParse({ provider: 'claude', config_dir: null, session: 's', code: '' }).success).toBe(false);
    expect(submit.safeParse({ provider: 'claude', config_dir: null, session: 's', code: 'x'.repeat(2001) }).success).toBe(false);
    expect(RPC['ai.login.start'].result.safeParse({ url: 'https://auth.openai.com/codex/device', user_code: 'LCWQ-WSPV8', needs_code: false }).success).toBe(true);
    expect(RPC['ai.login.start'].result.safeParse({ url: '', user_code: null, needs_code: true }).success).toBe(false);
    // TER-1054: an older agent leaves `logged_in` out; a newer one says the CLI finished on its own.
    expect(RPC['ai.login.start'].result.parse({ url: 'https://x/oauth/authorize', user_code: null, needs_code: true })).toMatchObject({ logged_in: false });
    expect(RPC['ai.login.start'].result.safeParse({ url: null, user_code: null, needs_code: false, logged_in: true }).success).toBe(true);
    expect(RPC['ai.login.submit'].result.safeParse({ logged_in: false, message: null }).success).toBe(true);
    expect(RPC['ai.login.cancel'].params.safeParse({ session: 'termhub-login-abc' }).success).toBe(true);
  });
  it('secret.read takes the gh_auth_token source only and bounds the value', () => {
    expect(RPC['secret.read'].params.safeParse({ source: 'gh_auth_token' }).success).toBe(true);
    expect(RPC['secret.read'].params.safeParse({ source: 'file' }).success).toBe(false);
    expect(RPC['secret.read'].params.safeParse({}).success).toBe(false);
    expect(RPC['secret.read'].result.safeParse({ value: 'gho_x' }).success).toBe(true);
    expect(RPC['secret.read'].result.safeParse({ value: 'x'.repeat(4097) }).success).toBe(false);
    expect(RPC['secret.read'].timeoutMs).toBe(10_000);
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
    expect(RPC['hooks.status'].params.safeParse({ claude_dirs: ['~/.claude-work'] }).success).toBe(true);
    expect(RPC['hooks.status'].params.safeParse({ claude_dirs: ['~/x\n'] }).success).toBe(false);
  });
  it('docs.scan takes an absolute/~ cwd and has a 15 s budget', () => {
    expect(RPC['docs.scan'].params.safeParse({ cwd: '/home/u/proj' }).success).toBe(true);
    expect(RPC['docs.scan'].params.safeParse({ cwd: 'relative' }).success).toBe(false);
    expect(RPC['docs.scan'].timeoutMs).toBe(15_000);
  });
  it('docs.read refuses paths outside docs/superpowers/{specs,plans}, a non-.md, and more than 20', () => {
    const good = { cwd: '/home/u/proj', paths: ['docs/superpowers/specs/a.md'] };
    expect(RPC['docs.read'].params.safeParse(good).success).toBe(true);
    expect(RPC['docs.read'].params.safeParse({ ...good, paths: ['../x.md'] }).success).toBe(false);
    expect(RPC['docs.read'].params.safeParse({ ...good, paths: ['docs/superpowers/other/a.md'] }).success).toBe(false);
    expect(RPC['docs.read'].params.safeParse({ ...good, paths: ['docs/superpowers/specs/a.txt'] }).success).toBe(false);
    expect(RPC['docs.read'].params.safeParse({ ...good, paths: ['docs/superpowers/specs/has space.md'] }).success).toBe(false);
    expect(RPC['docs.read'].params.safeParse({ ...good, paths: [] }).success).toBe(false);
    expect(RPC['docs.read'].params.safeParse({ ...good, paths: Array.from({ length: 21 }, (_, i) => `docs/superpowers/specs/a${i}.md`) }).success).toBe(false);
    expect(RPC['docs.read'].params.safeParse({ ...good, paths: Array.from({ length: 20 }, (_, i) => `docs/superpowers/specs/a${i}.md`) }).success).toBe(true);
    expect(RPC['docs.read'].timeoutMs).toBe(20_000);
  });
  it('docPath accepts docs/lessons/<name>.md, never README.md or a nested path (spec 2026-09-27 failure lessons)', () => {
    expect(docPath.safeParse('docs/lessons/2026-09-27-x.md').success).toBe(true);
    expect(docPath.safeParse('docs/lessons/README.md').success).toBe(false);
    expect(docPath.safeParse('docs/lessons/sub/y.md').success).toBe(false);
    expect(docPath.safeParse('docs/lessons/../x.md').success).toBe(false);
    expect(docPath.safeParse('docs/superpowers/specs/a.md').success).toBe(true);
  });
  it('bounds tab.mcp.write/remove', () => {
    expect(RPC['tab.mcp.write'].params.safeParse({ tab_id: 'abc', file: 'token', body: 'x' }).success).toBe(true);
    expect(RPC['tab.mcp.write'].params.safeParse({ tab_id: '../x', file: 'token', body: 'x' }).success).toBe(false);
    expect(RPC['tab.mcp.write'].params.safeParse({ tab_id: 'abc', file: 'other', body: 'x' }).success).toBe(false);
    expect(RPC['tab.mcp.write'].params.safeParse({ tab_id: 'abc', file: 'token', body: 'x'.repeat(8193) }).success).toBe(false);
    expect(RPC['tab.mcp.write'].params.safeParse({ tab_id: 'abc', file: 'token', body: 'x'.repeat(8192) }).success).toBe(true);
    expect(RPC['tab.mcp.write'].timeoutMs).toBe(10_000);
    expect(RPC['tab.mcp.remove'].params.safeParse({ tab_id: 'abc' }).success).toBe(true);
    expect(RPC['tab.mcp.remove'].params.safeParse({ tab_id: '../x' }).success).toBe(false);
    expect(RPC['tab.mcp.remove'].timeoutMs).toBe(10_000);
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

  it('tmux.scroll takes a signed whole line count within ±500 and answers done', () => {
    for (const lines of [-500, -3, 0, 7, 500]) expect(RPC['tmux.scroll'].params.safeParse({ session: 's', lines }).success).toBe(true);
    for (const lines of [-501, 501, 1.5, '3', null]) expect(RPC['tmux.scroll'].params.safeParse({ session: 's', lines }).success).toBe(false);
    expect(RPC['tmux.scroll'].params.safeParse({ session: 'bad name', lines: 1 }).success).toBe(false);
    expect(RPC['tmux.scroll'].result.safeParse({ done: true }).success).toBe(true);
    expect(RPC['tmux.scroll'].result.safeParse({ done: false }).success).toBe(false);
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

const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const base = { transcript_path: `/home/u/.claude/projects/-w/${SID}.jsonl`, session_id: SID, direction: 'forward', offset: 0, max_bytes: 262_144, types: ['user', 'assistant'], max_string: 4000 };

describe('transcript.read', () => {
  it('accepts a forward and a backward read', () => {
    expect(RPC['transcript.read'].params.safeParse(base).success).toBe(true);
    expect(RPC['transcript.read'].params.safeParse({ ...base, direction: 'backward', offset: null }).success).toBe(true);
  });
  it('refuses a bad session id, a relative path, no types and an oversized window', () => {
    for (const bad of [{ session_id: 'x' }, { transcript_path: 'a/b.jsonl' }, { types: [] }, { max_bytes: 600_000 }, { max_string: 10 }]) {
      expect(RPC['transcript.read'].params.safeParse({ ...base, ...bad }).success).toBe(false);
    }
  });
  it('validates the result', () => {
    expect(RPC['transcript.read'].result.safeParse({ status: 'ok', lines: ['{}'], start: 0, end: 3, size: 3 }).success).toBe(true);
    expect(RPC['transcript.read'].result.safeParse({ status: 'gone', lines: [], start: 0, end: 0, size: 0 }).success).toBe(false);
  });
});

it('BTab is a key a terminal tool may press', () => {
  expect(TMUX_KEYS).toContain('BTab');
  expect(tmuxKey.safeParse('BTab').success).toBe(true);
});

describe('file.read', () => {
  const ok = { status: 'ok', path: '/home/u/p/a.md', size: 3, mtime_ms: 1, content_b64: 'YWJj' };
  it('takes an absolute or ~ path and up to 16 roots', () => {
    expect(RPC['file.read'].params.safeParse({ path: '~/r.md', roots: ['/home/u/p'] }).success).toBe(true);
    expect(RPC['file.read'].params.safeParse({ path: '/tmp/r.md', roots: [] }).success).toBe(true);
  });
  it('refuses a relative path, a newline and too many roots', () => {
    for (const bad of [{ path: 'docs/a.md', roots: [] }, { path: '/a\n.md', roots: [] }, { path: '/a.md', roots: Array(17).fill('/x') }, { path: '/a.md', roots: ['rel'] }]) {
      expect(RPC['file.read'].params.safeParse(bad).success).toBe(false);
    }
  });
  it('validates both shapes of the result', () => {
    expect(RPC['file.read'].result.safeParse(ok).success).toBe(true);
    expect(RPC['file.read'].result.safeParse({ status: 'too_large', size: 9_999_999 }).success).toBe(true);
    expect(RPC['file.read'].result.safeParse({ status: 'outside' }).success).toBe(true);
    expect(RPC['file.read'].result.safeParse({ status: 'gone' }).success).toBe(false);
    expect(RPC['file.read'].result.safeParse({ ...ok, size: FILE_READ_MAX_BYTES + 1 }).success).toBe(false);
  });
});

describe('file.list', () => {
  const params = { cwd: '/home/u/p', dirs: ['docs/lessons', 'docs/superpowers/specs'], paths: ['~/r.md', '/tmp/x.md'], roots: ['/home/u/p'] };
  const entry = { path: '/home/u/p/docs/lessons/a.md', asked: '/home/u/p/docs/lessons/a.md', size: 3, mtime_ms: 1, too_large: false };
  it('takes relative folders under a cwd, cited paths and roots', () => {
    expect(RPC['file.list'].params.safeParse(params).success).toBe(true);
    expect(RPC['file.list'].params.safeParse({ ...params, cwd: null, dirs: [] }).success).toBe(true);
    expect(RPC['file.list'].params.safeParse({ ...params, dirs: ['docs/legal', 'a_b-c/d.e'] }).success).toBe(true);
  });
  it.each(['/docs', '~/docs', '../x', 'docs/../x', 'docs/.git', '.hidden', 'docs//x', 'docs/', '', 'docs/./x', 'a\nb', 'a b', 'docs\\x'])(
    'refuses %j as a folder',
    (dir) => {
      expect(RPC['file.list'].params.safeParse({ ...params, dirs: [dir] }).success).toBe(false);
    },
  );
  it('refuses a relative cited path, a relative cwd and too many of anything', () => {
    for (const bad of [
      { ...params, paths: ['docs/a.md'] },
      { ...params, cwd: 'proj' },
      { ...params, dirs: Array(9).fill('docs') },
      { ...params, paths: Array(101).fill('/a.md') },
      { ...params, roots: Array(17).fill('/x') },
    ]) {
      expect(RPC['file.list'].params.safeParse(bad).success).toBe(false);
    }
  });
  it('validates the result and caps it at FILE_LIST_MAX_ENTRIES', () => {
    expect(RPC['file.list'].result.safeParse({ entries: [entry, { ...entry, size: FILE_READ_MAX_BYTES + 1, too_large: true }] }).success).toBe(true);
    expect(RPC['file.list'].result.safeParse({ entries: Array(FILE_LIST_MAX_ENTRIES).fill(entry) }).success).toBe(true);
    expect(RPC['file.list'].result.safeParse({ entries: Array(FILE_LIST_MAX_ENTRIES + 1).fill(entry) }).success).toBe(false);
    expect(RPC['file.list'].result.safeParse({ entries: [{ ...entry, too_large: undefined }] }).success).toBe(false);
    expect(RPC['file.list'].result.safeParse({ entries: [{ ...entry, size: -1 }] }).success).toBe(false);
  });
});

describe('net.check', () => {
  it('takes one to four http(s) urls', () => {
    expect(RPC['net.check'].params.safeParse({ urls: ['https://termhub.dev/api/hooks/events', 'http://localhost:3000/mcp'] }).success).toBe(true);
    expect(RPC['net.check'].params.safeParse({ urls: [] }).success).toBe(false);
    expect(RPC['net.check'].params.safeParse({ urls: Array(5).fill('https://termhub.dev/mcp') }).success).toBe(false);
    expect(RPC['net.check'].params.safeParse({ urls: ['file:///etc/passwd'] }).success).toBe(false);
  });
  it('answers a status or an error per url', () => {
    expect(RPC['net.check'].result.safeParse({ results: [{ url: 'https://termhub.dev/mcp', status: 401, error: null }, { url: 'https://x', status: null, error: 'ENOTFOUND' }] }).success).toBe(true);
  });
});
