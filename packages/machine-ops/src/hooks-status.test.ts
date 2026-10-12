import { describe, expect, it } from 'vitest';
import { HOOK_SCRIPT, mergeClaudeSettings, mergeCodexConfig, mergeCodexHooks, mergeCursorHooks } from './hooks.js';
import { HOOK_SCRIPT_VERSION, hookScriptVersion, hooksStatus, type HookFile, type HooksStatusInput } from './hooks-status.js';

const scriptPath = '/home/p/.termhub/bin/termhub-hook';
const hooksPath = '/home/p/.codex/hooks.json';
const present = (content: string): HookFile => ({ status: 'present', content });
const absent: HookFile = { status: 'absent', content: '' };
const unreadable: HookFile = { status: 'unreadable', content: '' };

/** A machine where an install just ran: every CLI there, every file what the merge writes. */
function installed(): HooksStatusInput {
  return {
    scriptPath,
    script: present(HOOK_SCRIPT),
    env: present("TERMHUB_HOOK_URL='https://x/api/hooks'\nTERMHUB_HOOK_TOKEN='t'\n"),
    claude: [{ dir: '~/.claude', settings: present(mergeClaudeSettings('{"model":"opus"}', scriptPath)) }],
    codex: { config: present(mergeCodexConfig('model = "o3"\n', scriptPath)), hooks: present(mergeCodexHooks('', scriptPath)), hooksPath },
    cursor: { hooks: present(mergeCursorHooks('', scriptPath)) },
  };
}

/** The trust tables Codex writes when the person picks "Trust all", one per hook of ours. */
const trustAll = (events: string[]) => events.map((e) => `[hooks.state."${hooksPath}:${e}:0:0"]\ntrusted_hash = "sha256:abc"\n`).join('\n');
const CODEX_KEYS = ['user_prompt_submit', 'pre_tool_use', 'permission_request', 'post_tool_use', 'stop', 'interrupt'];

describe('hooksStatus', () => {
  it('reads a fresh install as current everywhere, with the script at the version this code carries', () => {
    const s = hooksStatus(installed());
    expect(s.script).toEqual({ installed: true, version: HOOK_SCRIPT_VERSION, expected_version: HOOK_SCRIPT_VERSION, outdated: false });
    expect(s.claude).toEqual({ present: true, state: 'current', dirs: [{ dir: '~/.claude', state: 'current' }] });
    expect(s.codex).toEqual({ present: true, state: 'current', notify: true, trusted: 'none' });
    expect(s.cursor).toEqual({ present: true, state: 'current' });
  });

  it('keeps reading current when the person has hooks of their own around ours, in any key order', () => {
    const own = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } });
    const merged = JSON.parse(mergeClaudeSettings(own, scriptPath)) as { hooks: Record<string, unknown[]> };
    // our entry first and theirs after it: an order the merge never writes, same meaning
    merged.hooks.Stop.reverse();
    const input = { ...installed(), claude: [{ dir: '~/.claude', settings: present(JSON.stringify(merged)) }] };
    expect(hooksStatus(input).claude.state).toBe('current');
  });

  it('says outdated when an event of ours is missing or its entry changed', () => {
    const settings = JSON.parse(mergeClaudeSettings('', scriptPath)) as { hooks: Record<string, unknown> };
    delete settings.hooks.SubagentStop;
    const cursor = JSON.parse(mergeCursorHooks('', scriptPath)) as { hooks: Record<string, { command: string }[]> };
    cursor.hooks.stop[0].command = `${scriptPath} cursor --old`;
    const s = hooksStatus({ ...installed(), claude: [{ dir: '~/.claude', settings: present(JSON.stringify(settings)) }], cursor: { hooks: present(JSON.stringify(cursor)) } });
    expect(s.claude.state).toBe('outdated');
    expect(s.cursor.state).toBe('outdated');
  });

  it('says missing for a CLI whose file has nothing of ours, and not present for a CLI that is not there', () => {
    const s = hooksStatus({ ...installed(), claude: [{ dir: '~/.claude', settings: present('{"model":"opus"}') }], codex: null, cursor: { hooks: absent } });
    expect(s.claude.state).toBe('missing');
    expect(s.codex).toEqual({ present: false, state: 'missing', notify: false, trusted: null });
    expect(s.cursor).toEqual({ present: true, state: 'missing' });
  });

  it('says unreadable for a file it cannot read or parse, like an install that would refuse it', () => {
    const s = hooksStatus({ ...installed(), claude: [{ dir: '~/.claude', settings: unreadable }, { dir: '~/.claude-work', settings: present('{ not json') }] });
    expect(s.claude.dirs.map((d) => d.state)).toEqual(['unreadable', 'unreadable']);
    expect(s.claude.state).toBe('unreadable');
  });

  it('takes the worst dir for the CLI, and a machine without ~/.claude has no Claude', () => {
    const s = hooksStatus({ ...installed(), claude: [...installed().claude, { dir: '~/.claude-work', settings: absent }] });
    expect(s.claude.state).toBe('missing');
    expect(hooksStatus({ ...installed(), claude: [] }).claude).toEqual({ present: false, state: 'missing', dirs: [] });
  });

  it('flags a script from another release and a missing script or env file', () => {
    const old = hooksStatus({ ...installed(), script: present('#!/bin/sh\n# older\n') });
    expect(old.script).toMatchObject({ installed: true, version: hookScriptVersion('#!/bin/sh\n# older\n'), outdated: true });
    expect(hooksStatus({ ...installed(), script: absent }).script).toMatchObject({ installed: false, version: null, outdated: false });
    expect(hooksStatus({ ...installed(), env: absent }).script.installed).toBe(false);
  });

  it('reads the Codex trust from the hooks.state tables of config.toml', () => {
    const base = installed();
    const config = (trust: string) => ({ ...base, codex: { ...base.codex!, config: present(`${mergeCodexConfig('', scriptPath)}\n[hooks.state]\n\n${trust}`) } });
    expect(hooksStatus(config(trustAll(CODEX_KEYS))).codex.trusted).toBe('all');
    expect(hooksStatus(config(trustAll(CODEX_KEYS.slice(0, 2)))).codex.trusted).toBe('some');
    // a table without trusted_hash, or for another file, is no trust of ours
    expect(hooksStatus(config(`[hooks.state."${hooksPath}:stop:0:0"]\nenabled = true\n[hooks.state."/other/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:x"\n`)).codex.trusted).toBe('none');
  });

  it('places the trust key at our group index when the person has a hook of their own first', () => {
    const own = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } });
    const base = installed();
    const keys = CODEX_KEYS.map((k) => (k === 'stop' ? 'stop:1' : `${k}:0`));
    const trust = keys.map((k) => `[hooks.state."${hooksPath}:${k}:0"]\ntrusted_hash = "sha256:abc"\n`).join('\n');
    const s = hooksStatus({ ...base, codex: { hooksPath, hooks: present(mergeCodexHooks(own, scriptPath)), config: present(trust) } });
    expect(s.codex.trusted).toBe('all');
    expect(s.codex.notify).toBe(false);
  });

  it('never answers a file content, a command or the token', () => {
    const out = JSON.stringify(hooksStatus(installed()));
    expect(out).not.toContain('TERMHUB_HOOK_TOKEN');
    expect(out).not.toContain(scriptPath);
    expect(out).not.toContain('opus');
  });
});
