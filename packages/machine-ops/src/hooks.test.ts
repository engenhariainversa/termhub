import { describe, expect, it } from 'vitest';
import {
  CLAUDE_HOOK_EVENTS,
  CURSOR_HOOK_EVENTS,
  HOOK_SCRIPT,
  claudeConfigDirs,
  expandHome,
  hookEnvFile,
  mergeClaudeSettings,
  mergeCodexConfig,
  mergeCursorHooks,
  stripClaudeSettings,
  stripCodexConfig,
  stripCursorHooks,
} from './hooks.js';

const script = '/Users/p/.termhub/bin/termhub-hook';

describe('mergeClaudeSettings', () => {
  it('adds one command entry per event to an empty or missing settings file', () => {
    const out = JSON.parse(mergeClaudeSettings('', script)) as { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };
    expect(Object.keys(out.hooks).sort()).toEqual([...CLAUDE_HOOK_EVENTS].sort());
    expect(CLAUDE_HOOK_EVENTS).toContain('PreToolUse');
    expect(out.hooks.Notification[0].hooks[0].command).toBe(`${script} claude`);
    expect(out.hooks.Notification[0].matcher).toBeUndefined();
    // Claude Code only runs a tool event's entry when it has a matcher; "*" is every tool
    expect(out.hooks.PreToolUse[0].matcher).toBe('*');
  });

  it('keeps the user\'s own settings and hooks, and is idempotent', () => {
    const current = JSON.stringify({
      model: 'opus',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'lint' }] }] },
    });
    const once = mergeClaudeSettings(current, script);
    const twice = mergeClaudeSettings(once, script);
    expect(twice).toBe(once);
    const out = JSON.parse(once) as { model: string; hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };
    expect(out.model).toBe('opus');
    // the user's own PreToolUse entry stays as it is; ours is added beside it
    expect(out.hooks.PreToolUse.map((e) => [e.matcher, e.hooks[0].command])).toEqual([
      ['Bash', 'lint'],
      ['*', `${script} claude`],
    ]);
    expect(out.hooks.Stop.map((e) => e.hooks[0].command)).toEqual(['say done', `${script} claude`]);
  });

  it('refuses to clobber a file that is not a JSON object', () => {
    expect(() => mergeClaudeSettings('[1,2]', script)).toThrow();
    expect(() => mergeClaudeSettings('{not json', script)).toThrow();
  });

  it('refuses a `hooks` that is there but is not an object, rather than replacing what the person wrote', () => {
    for (const hooks of ['[{"matcher":"*"}]', '"x"', '1', 'true']) {
      expect(() => mergeClaudeSettings(`{"model":"opus","hooks":${hooks}}`, script)).toThrow('~/.claude/settings.json: o campo "hooks" não é um objeto');
    }
    // absent, null, or [] holds nothing to lose — install must still work
    expect(JSON.parse(mergeClaudeSettings('{"model":"opus","hooks":null}', script)).hooks.Stop).toHaveLength(1);
    expect(JSON.parse(mergeClaudeSettings('{"model":"opus","hooks":[]}', script)).hooks.Stop).toHaveLength(1);
  });

  it('names the settings file the caller passed, not a hardcoded ~/.claude', () => {
    expect(() => mergeClaudeSettings('{"hooks":[1]}', script, '~/.claude-work/settings.json')).toThrow(
      '~/.claude-work/settings.json: o campo "hooks" não é um objeto',
    );
  });

  it('subscribes PermissionRequest with the every-tool matcher, like PreToolUse', () => {
    const out = JSON.parse(mergeClaudeSettings('', script)) as { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };
    expect(CLAUDE_HOOK_EVENTS).toContain('PermissionRequest');
    expect(out.hooks.PermissionRequest[0].matcher).toBe('*');
    expect(out.hooks.PermissionRequest[0].hooks[0].command).toBe(`${script} claude`);
  });
});

describe('stripClaudeSettings', () => {
  it('removes only our entries and drops keys left empty', () => {
    const merged = mergeClaudeSettings(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }), script);
    const out = JSON.parse(stripClaudeSettings(merged)) as { hooks: Record<string, unknown[]> };
    expect(Object.keys(out.hooks)).toEqual(['Stop']);
    expect(out.hooks.Stop).toHaveLength(1);
    const bare = JSON.parse(stripClaudeSettings(mergeClaudeSettings('{"model":"opus"}', script))) as Record<string, unknown>;
    expect(bare).toEqual({ model: 'opus' });
  });
});

describe('codex config', () => {
  it('prepends notify when absent and replaces it when present', () => {
    expect(mergeCodexConfig('model = "o3"\n[profiles.x]\nfoo = 1\n', script)).toBe(`notify = ["${script}", "codex"]\nmodel = "o3"\n[profiles.x]\nfoo = 1\n`);
    expect(mergeCodexConfig('notify = ["other"]\nmodel = "o3"\n', script)).toBe(`notify = ["${script}", "codex"]\nmodel = "o3"\n`);
  });

  it('strips only our notify line', () => {
    expect(stripCodexConfig(`notify = ["${script}", "codex"]\nmodel = "o3"\n`)).toBe('model = "o3"\n');
    expect(stripCodexConfig('notify = ["other"]\n')).toBe('notify = ["other"]\n');
  });
});

describe('cursor hooks.json', () => {
  type CursorFile = { version: number; hooks: Record<string, { command: string }[]> };

  it('adds one command per event to an empty or missing file', () => {
    const out = JSON.parse(mergeCursorHooks('', script)) as CursorFile;
    expect(out.version).toBe(1);
    expect(Object.keys(out.hooks).sort()).toEqual([...CURSOR_HOOK_EVENTS].sort());
    expect(out.hooks.stop).toEqual([{ command: `${script} cursor` }]);
  });

  it('keeps the user\'s own hooks and version, and is idempotent', () => {
    const current = JSON.stringify({ version: 2, hooks: { stop: [{ command: 'say done' }], beforeShellExecution: [{ command: './audit.sh' }] } });
    const once = mergeCursorHooks(current, script);
    expect(mergeCursorHooks(once, script)).toBe(once);
    const out = JSON.parse(once) as CursorFile;
    expect(out.version).toBe(2);
    expect(out.hooks.beforeShellExecution).toEqual([{ command: './audit.sh' }]);
    expect(out.hooks.stop.map((e) => e.command)).toEqual(['say done', `${script} cursor`]);
  });

  it('registers exactly these events: no hook that could answer a permission check', () => {
    // beforeSubmitPrompt is the one blocking event on purpose: it is the only signal that a new turn
    // started, and the script prints nothing, which Cursor reads as "go on" (see hook-script.test.ts).
    // Every other before* / preToolUse hook can allow or deny a command, a file or an MCP call.
    expect([...CURSOR_HOOK_EVENTS]).toEqual(['sessionStart', 'beforeSubmitPrompt', 'afterAgentResponse', 'stop', 'sessionEnd']);
  });

  it('refuses to clobber a file that is not a JSON object', () => {
    expect(() => mergeCursorHooks('[1]', script)).toThrow();
    expect(() => mergeCursorHooks('{nope', script)).toThrow();
  });

  it('refuses a `hooks` that is there but is not an object, rather than replacing what the person wrote', () => {
    for (const hooks of ['[{"command":"say done"}]', '"x"', '1', 'true']) {
      expect(() => mergeCursorHooks(`{"version":1,"hooks":${hooks}}`, script)).toThrow('~/.cursor/hooks.json: o campo "hooks" não é um objeto');
    }
    // absent, null, or [] holds nothing to lose
    expect(JSON.parse(mergeCursorHooks('{"version":1,"hooks":null}', script)).hooks.stop).toEqual([{ command: `${script} cursor` }]);
    expect(JSON.parse(mergeCursorHooks('{"version":1,"hooks":[]}', script)).hooks.stop).toEqual([{ command: `${script} cursor` }]);
  });

  it('strips only our entries, drops events left empty and leaves odd files alone', () => {
    const merged = mergeCursorHooks(JSON.stringify({ version: 1, hooks: { stop: [{ command: 'say done' }] } }), script);
    expect(JSON.parse(stripCursorHooks(merged))).toEqual({ version: 1, hooks: { stop: [{ command: 'say done' }] } });
    expect(JSON.parse(stripCursorHooks(mergeCursorHooks('', script)))).toEqual({ version: 1 });
    expect(stripCursorHooks('[1]')).toBe('[1]');
    expect(stripCursorHooks('')).toBe('');
  });
});

describe('hook script', () => {
  it('is POSIX sh, exits quietly without tmux/env, posts in the background and never echoes the token', () => {
    expect(HOOK_SCRIPT.startsWith('#!/bin/sh')).toBe(true);
    expect(HOOK_SCRIPT).toContain('[ -n "$TMUX_PANE" ] || exit 0');
    expect(HOOK_SCRIPT).toContain('--data-binary @- >/dev/null 2>&1 &');
    expect(HOOK_SCRIPT).not.toContain('__TERMHUB_EOF__');
    expect(HOOK_SCRIPT).not.toMatch(/echo .*TOKEN/);
  });
});

describe('hookEnvFile', () => {
  it('single-quotes both values for sh', () => {
    expect(hookEnvFile('https://app.example/api/hooks', 'thb_hk_abc')).toBe("TERMHUB_HOOK_URL='https://app.example/api/hooks'\nTERMHUB_HOOK_TOKEN='thb_hk_abc'\n");
    expect(hookEnvFile('https://x', "a'b")).toContain(`TERMHUB_HOOK_TOKEN='a'\\''b'`);
  });
});

describe('claudeConfigDirs', () => {
  it('always starts with ~/.claude and adds each account dir once, as ~/x or /abs', () => {
    expect(claudeConfigDirs([])).toEqual(['~/.claude']);
    expect(claudeConfigDirs(['~/.claude_pedro', null, '  ', '~/.claude', '~/.claude_pedro/', '/opt/claude', '.claude-work'])).toEqual([
      '~/.claude',
      '~/.claude_pedro',
      '/opt/claude',
      '~/.claude-work',
    ]);
  });

  it('drops the home itself and anything with control characters', () => {
    expect(claudeConfigDirs(['~', '~/', '/', '~/x\ny', '/a\0b'])).toEqual(['~/.claude']);
  });
});

describe('expandHome', () => {
  it('resolves ~/ against the machine home and keeps absolute paths', () => {
    expect(expandHome('~/.claude_pedro', '/home/p')).toBe('/home/p/.claude_pedro');
    expect(expandHome('/opt/claude', '/home/p')).toBe('/opt/claude');
  });
});

it('subscribes to StopFailure (usage limits end a turn with it)', () => {
  expect(CLAUDE_HOOK_EVENTS).toContain('StopFailure');
});
