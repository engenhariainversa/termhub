/**
 * Runs the real hook script under `sh`, as Claude Code runs it: the event JSON on stdin, the tool
 * name as $1, a fake `tmux` and a fake `curl` first on PATH. The fake curl appends each request
 * body to a log, so the assertions are about what would have reached the server.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOOK_ENV_REL, HOOK_SCRIPT } from './hooks.js';

let home: string;
let bin: string;
let log: string;
let tmp: string;
let pane: string;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs the script as Claude Code would: event JSON on stdin, `claude` as $1. */
function run(event: unknown): void {
  execFileSync('sh', [join(bin, 'termhub-hook'), 'claude'], {
    input: JSON.stringify(event),
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, TMUX_PANE: '%1', TMPDIR: tmp },
    timeout: 5000,
  });
}

/** Runs the script as another tool would ($1 = tool) and answers what it wrote on stdout. */
function runAs(tool: string, event: unknown): string {
  return execFileSync('sh', [join(bin, 'termhub-hook'), tool], {
    input: JSON.stringify(event),
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, TMUX_PANE: '%1', TMPDIR: tmp },
    timeout: 5000,
  }).toString();
}

/** `run`, with extra environment, answering what the script wrote to stderr. */
function runWithStderr(event: unknown, env: Record<string, string>): string {
  const r = spawnSync('sh', [join(bin, 'termhub-hook'), 'claude'], {
    input: JSON.stringify(event),
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, TMUX_PANE: '%1', TMPDIR: tmp, ...env },
    timeout: 5000,
  });
  expect(r.status).toBe(0);
  return r.stderr.toString();
}

const logged = (): string[] => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);

/** The script posts in the background: waits for the fake curl to have logged `n` bodies. */
async function bodies(n: number): Promise<string[]> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const lines = logged();
    if (lines.length >= n || Date.now() > deadline) return lines;
    await sleep(10);
  }
}

const eventOf = (body: string) => (JSON.parse(body) as { event: Record<string, unknown> }).event;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hook-home-'));
  tmp = mkdtempSync(join(tmpdir(), 'hook-tmp-'));
  bin = join(home, 'bin');
  log = join(home, 'curl.log');
  pane = join(home, 'pane.txt');
  mkdirSync(join(home, '.termhub'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(home, HOOK_ENV_REL), `TERMHUB_HOOK_URL='http://x/api/hooks/events'\nTERMHUB_HOOK_TOKEN='thk_test'\n`);
  writeFileSync(join(bin, 'termhub-hook'), HOOK_SCRIPT);
  // capture-pane prints the fake screen (nothing, and a failure, when there is none); anything else is display-message
  writeFileSync(join(bin, 'tmux'), `#!/bin/sh\ncase "$1" in capture-pane) cat "${pane}" 2>/dev/null ;; *) echo th-abc ;; esac\n`);
  // a synchronous fake: reads the body from stdin (--data-binary @-) and appends it as one line
  writeFileSync(join(bin, 'curl'), `#!/bin/sh\ncat >> "${log}"; printf '\\n' >> "${log}"\n`);
  for (const f of ['termhub-hook', 'tmux', 'curl']) chmodSync(join(bin, f), 0o755);
});
afterEach(() => {
  // The script posts in the background: a fake curl from the last run may still be appending to
  // the log while the directory is removed (ENOTEMPTY on CI), so the removal retries briefly.
  const opts = { recursive: true, force: true, maxRetries: 20, retryDelay: 25 } as const;
  rmSync(home, opts);
  rmSync(tmp, opts);
});

describe('termhub-hook script', () => {
  it('posts a PreToolUse event with the tool name and nothing else', async () => {
    run({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/secret', new_string: 'x' }, session_id: 's' });
    const sent = await bodies(1);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0])).toEqual({ tool: 'claude', session: 'th-abc', event: { hook_event_name: 'PreToolUse', tool_name: 'Edit' } });
    expect(sent[0]).not.toContain('secret');
  });

  it('takes the event\'s own tool name, not one nested in the tool input', async () => {
    run({ hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { tool_name: 'Bash' } });
    const sent = await bodies(1);
    expect(eventOf(sent[0])).toEqual({ hook_event_name: 'PreToolUse', tool_name: 'Task' });
  });

  it('posts an MCP-style tool name that contains a hyphen, intact', async () => {
    run({ hook_event_name: 'PreToolUse', tool_name: 'mcp__claude-in-chrome__click' });
    const sent = await bodies(1);
    expect(eventOf(sent[0])).toEqual({ hook_event_name: 'PreToolUse', tool_name: 'mcp__claude-in-chrome__click' });
  });

  it('posts the same tool once and a different tool again', async () => {
    run({ hook_event_name: 'PreToolUse', tool_name: 'Edit' });
    run({ hook_event_name: 'PreToolUse', tool_name: 'Edit' });
    run({ hook_event_name: 'PreToolUse', tool_name: 'Read' });
    const sent = await bodies(2);
    expect(sent.map((b) => eventOf(b).tool_name)).toEqual(['Edit', 'Read']);
  });

  it('resets on UserPromptSubmit and SessionStart, so the first tool of a new turn is sent', async () => {
    run({ hook_event_name: 'PreToolUse', tool_name: 'Edit' });
    run({ hook_event_name: 'UserPromptSubmit', prompt: 'do it' });
    run({ hook_event_name: 'PreToolUse', tool_name: 'Edit' });
    run({ hook_event_name: 'SessionStart' });
    run({ hook_event_name: 'PreToolUse', tool_name: 'Edit' });
    const sent = await bodies(5);
    expect(sent.map((b) => eventOf(b).hook_event_name)).toEqual(['PreToolUse', 'UserPromptSubmit', 'PreToolUse', 'SessionStart', 'PreToolUse']);
  });

  it('resets on Notification, so the tool retried after an approved prompt is sent again', async () => {
    run({ hook_event_name: 'PreToolUse', tool_name: 'Bash' });
    run({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' });
    run({ hook_event_name: 'PreToolUse', tool_name: 'Bash' });
    const sent = await bodies(3);
    expect(sent.map((b) => eventOf(b).hook_event_name)).toEqual(['PreToolUse', 'Notification', 'PreToolUse']);
  });

  it('posts nothing for a PreToolUse without a plain identifier as the tool name', async () => {
    run({ hook_event_name: 'PreToolUse' });
    run({ hook_event_name: 'PreToolUse', tool_name: 42 });
    run({ hook_event_name: 'PreToolUse', tool_name: 'Ev"il' });
    run({ hook_event_name: 'PreToolUse', tool_name: 'Ev\\il' });
    await sleep(300);
    expect(existsSync(log)).toBe(false);
  });

  it('still posts the other events whole', async () => {
    run({ hook_event_name: 'Stop', last_assistant_message: 'Pronto?' });
    const sent = await bodies(1);
    expect(JSON.parse(sent[0])).toEqual({ tool: 'claude', session: 'th-abc', event: { hook_event_name: 'Stop', last_assistant_message: 'Pronto?' } });
  });

  it('keeps the marker inside TMPDIR whatever the session name contains', async () => {
    writeFileSync(join(bin, 'tmux'), "#!/bin/sh\necho '../evil name'\n");
    chmodSync(join(bin, 'tmux'), 0o755);
    run({ hook_event_name: 'PreToolUse', tool_name: 'Edit' });
    await bodies(1);
    expect(existsSync(join(tmp, '..', 'evil name'))).toBe(false);
    expect(existsSync(join(home, 'evil name'))).toBe(false);
    // the marker itself must actually have been written, inside TMPDIR — otherwise a script that
    // stopped writing markers entirely (silently breaking de-dup) would pass this test too.
    const markers = readdirSync(tmp);
    expect(markers).toHaveLength(1);
    expect(readFileSync(join(tmp, markers[0]), 'utf8')).toBe('Edit');
  });

  describe('questions and permission prompts (spec 2026-09-25 §4.1)', () => {
    const ask = {
      session_id: 's1',
      transcript_path: '/home/dev/.claude/projects/-home-dev-project/s1.jsonl',
      cwd: '/home/dev/project',
      permission_mode: 'default',
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Qual cor?', header: 'Cor', options: [{ label: 'Azul (Recommended)', description: 'Calma' }, { label: 'Verde', description: 'Fresca' }], multiSelect: false }] },
      tool_use_id: 'toolu_01',
    };

    it('forwards an AskUserQuestion PreToolUse whole, and prints nothing', async () => {
      expect(runAs('claude', ask)).toBe('');
      const sent = await bodies(1);
      expect(JSON.parse(sent[0])).toEqual({ tool: 'claude', session: 'th-abc', event: ask });
    });

    it('never de-duplicates a question and never touches the marker', async () => {
      run({ hook_event_name: 'PreToolUse', tool_name: 'Edit' });
      run(ask);
      run(ask);
      run({ hook_event_name: 'PreToolUse', tool_name: 'Edit' });
      await bodies(3);
      await sleep(200);
      expect(logged().map((b) => eventOf(b).tool_name)).toEqual(['Edit', 'AskUserQuestion', 'AskUserQuestion']);
      expect(readFileSync(join(tmp, readdirSync(tmp)[0]), 'utf8')).toBe('Edit');
    });

    it('does not forward whole a tool whose input merely names AskUserQuestion', async () => {
      run({ hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { tool_name: 'AskUserQuestion', prompt: 'secret' } });
      const sent = await bodies(1);
      expect(eventOf(sent[0])).toEqual({ hook_event_name: 'PreToolUse', tool_name: 'Task' });
    });

    it('never forwards the input when tool_input (naming AskUserQuestion) is serialised before the real tool_name', async () => {
      // Claude Code writes hook_event_name and tool_name before tool_input, but the whole-forward
      // path must not rely on that order alone: if the first "tool_name" found is actually nested
      // inside another tool's input, the fallback is the ordinary name-only path — never the input.
      const event = { hook_event_name: 'PreToolUse', tool_input: { tool_name: 'AskUserQuestion', prompt: 'secret' }, tool_name: 'Task' };
      run(event);
      const sent = await bodies(1);
      expect(sent[0]).not.toContain('secret');
      expect(sent[0]).not.toContain('tool_input');
      expect(Object.keys(eventOf(sent[0])).sort()).toEqual(['hook_event_name', 'tool_name']);
    });

    it('drops an AskUserQuestion PermissionRequest even when its input nests a fake "hook_event_name":"PreToolUse"', async () => {
      // The branch is picked on the event's own (first) hook_event_name, not by searching the whole
      // payload for the substring: a nested lookalike must not steer a PermissionRequest into the
      // PreToolUse path, where AskUserQuestion would be forwarded whole.
      const event = {
        hook_event_name: 'PermissionRequest',
        tool_name: 'AskUserQuestion',
        tool_input: {
          questions: ask.tool_input.questions,
          evidence: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /secret' } },
        },
      };
      expect(runAs('claude', event)).toBe('');
      await sleep(300);
      expect(existsSync(log)).toBe(false);
    });

    it('reduces a PermissionRequest to the tool name, and prints nothing', async () => {
      const event = { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf /secret' }, permission_suggestions: [{ type: 'addDirectories', directories: ['/secret'] }] };
      expect(runAs('claude', event)).toBe('');
      const sent = await bodies(1);
      expect(JSON.parse(sent[0])).toEqual({ tool: 'claude', session: 'th-abc', event: { hook_event_name: 'PermissionRequest', tool_name: 'Bash' } });
      expect(sent[0]).not.toContain('secret');
    });

    it('drops AskUserQuestion\'s own PermissionRequest (its PreToolUse carried the question) and odd names', async () => {
      expect(runAs('claude', { hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: ask.tool_input })).toBe('');
      run({ hook_event_name: 'PermissionRequest', tool_name: 'Ev"il' });
      run({ hook_event_name: 'PermissionRequest' });
      await sleep(300);
      expect(existsSync(log)).toBe(false);
    });
  });

  describe('spinner verb', () => {
    /** What the fake tmux answers to capture-pane: the visible pane, top to bottom. */
    const screen = (...lines: string[]) => writeFileSync(pane, `${lines.join('\n')}\n`);
    /** Claude Code's bottom area as it looks mid-turn: transcript, spinner, todo list, input box, hints, blank rows. */
    const claudeScreen = (spinner: string) => [
      '● Update(src/app.ts)',
      '  ⎿  Updated src/app.ts with 2 additions',
      '',
      spinner,
      '  ⎿  ☐ Write the failing test',
      '     ☐ Make it pass',
      '',
      '╭──────────────────────────────────────────╮',
      '│ >                                        │',
      '╰──────────────────────────────────────────╯',
      '  ⏵⏵ accept edits on (shift+tab to cycle)',
      '',
      '',
    ];

    it('posts the verb of the spinner line with the tool name, and no other screen text', async () => {
      screen(...claudeScreen('✻ Moonwalking… (12s · esc to interrupt)'), 'API_KEY=sk-secret');
      run({ hook_event_name: 'PreToolUse', tool_name: 'Edit' });
      const sent = await bodies(1);
      expect(JSON.parse(sent[0])).toEqual({ tool: 'claude', session: 'th-abc', event: { hook_event_name: 'PreToolUse', tool_name: 'Edit', verb: 'Moonwalking' } });
      for (const leak of ['secret', 'Update', 'failing', 'accept', '12s']) expect(sent[0]).not.toContain(leak);
    });

    it('reads the verb whatever the spinner glyph, with "…" or "..."', async () => {
      const cases: [string, string][] = [
        ['✻ Brewing… (3s · esc to interrupt)', 'Brewing'],
        ['✽ Clauding… (esc to interrupt · 40s · ↓ 1.2k tokens)', 'Clauding'],
        ['✶ Pondering…', 'Pondering'],
        ['✳ Noodling… (1m 2s)', 'Noodling'],
        ['· Vibing…', 'Vibing'],
        ['✢ Honking… (esc to interrupt)', 'Honking'],
        ['* Schlepping... (esc to interrupt)', 'Schlepping'],
      ];
      // one tool per case: the verb changes each time, so every one is posted
      for (const [line] of cases) {
        screen(...claudeScreen(line));
        run({ hook_event_name: 'PreToolUse', tool_name: 'Read' });
      }
      const sent = await bodies(cases.length);
      expect(sent.map((b) => eventOf(b).verb)).toEqual(cases.map(([, verb]) => verb));
    });

    it('posts the tool without a verb when no spinner is on screen, or tmux cannot capture', async () => {
      screen('$ ls', 'README.md  src', 'Loading… done', '- Thinking about it...', '✻ Brewed for 2m 3s');
      run({ hook_event_name: 'PreToolUse', tool_name: 'Edit' });
      rmSync(pane);
      run({ hook_event_name: 'PreToolUse', tool_name: 'Read' });
      const sent = await bodies(2);
      expect(sent.map(eventOf)).toEqual([
        { hook_event_name: 'PreToolUse', tool_name: 'Edit' },
        { hook_event_name: 'PreToolUse', tool_name: 'Read' },
      ]);
    });

    it('drops a spinner word that is not plain ASCII letters, 2 to 24 of them', async () => {
      const hostile = [
        '✻ Ev"il… (1s)',
        '✻ Back\\slash… (1s)',
        '✻ Moonwalking…"},"x":"y',
        '✻ Two words… (1s)',
        '✻ Construção… (1s)',
        '✻ X… (1s)',
        `✻ ${'A'.repeat(25)}… (1s)`,
        '✻ Brewing(1s)…',
        '✻  Brewing… (1s)',
      ];
      hostile.forEach((line, i) => {
        screen(...claudeScreen(line));
        // a different tool each time, so the de-dup never hides a post
        run({ hook_event_name: 'PreToolUse', tool_name: `Tool${i}` });
      });
      const sent = await bodies(hostile.length);
      expect(sent).toHaveLength(hostile.length);
      for (const body of sent) expect(Object.keys(eventOf(body)).sort()).toEqual(['hook_event_name', 'tool_name']);
    });

    it('accepts a 24-letter verb', async () => {
      screen(...claudeScreen(`✻ ${'A'.repeat(24)}… (1s)`));
      run({ hook_event_name: 'PreToolUse', tool_name: 'Edit' });
      const sent = await bodies(1);
      expect(eventOf(sent[0]).verb).toBe('A'.repeat(24));
    });

    it('takes the lowest spinner-looking line, the live one', async () => {
      screen('✻ Pondering… (old line in the transcript)', ...claudeScreen('✻ Moseying… (2s)'));
      run({ hook_event_name: 'PreToolUse', tool_name: 'Edit' });
      const sent = await bodies(1);
      expect(eventOf(sent[0]).verb).toBe('Moseying');
    });

    it('only takes a spinner at column 0: indented look-alikes below it (a draft, tool output) never win', async () => {
      screen(
        '✽ Mulling… (11s · ↓ 498 tokens)',
        '  ⎿  ☐ Write the failing test',
        '╭──────────────────────────────────────────╮',
        '│ > first line of a draft                  │',
        '  * Fixing... the secret bug',
        '    · Password…',
        '   ✻ Secret… (1s)',
        '╰──────────────────────────────────────────╯',
      );
      run({ hook_event_name: 'PreToolUse', tool_name: 'Edit' });
      const sent = await bodies(1);
      expect(eventOf(sent[0]).verb).toBe('Mulling');
    });

    it('posts no verb when the only spinner-looking line is indented', async () => {
      screen('$ cat notes.md', '  * Fixing... the bug', '    · Password…');
      run({ hook_event_name: 'PreToolUse', tool_name: 'Edit' });
      const sent = await bodies(1);
      expect(eventOf(sent[0])).toEqual({ hook_event_name: 'PreToolUse', tool_name: 'Edit' });
    });

    it('still finds the verb, silently, with invalid UTF-8 on screen under a UTF-8 locale', async () => {
      const lines = claudeScreen('✻ Brewing… (3s · esc to interrupt)');
      writeFileSync(pane, Buffer.concat([Buffer.from('garbage \xff\xfe\xc3( bytes\n', 'latin1'), Buffer.from(`${lines.join('\n')}\n`), Buffer.from('tail \xff\n', 'latin1')]));
      const stderr = runWithStderr({ hook_event_name: 'PreToolUse', tool_name: 'Edit' }, { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });
      const sent = await bodies(1);
      expect(eventOf(sent[0]).verb).toBe('Brewing');
      expect(stderr).toBe('');
    });

    it('de-duplicates on tool and verb together', async () => {
      screen(...claudeScreen('✻ Brewing… (1s)'));
      run({ hook_event_name: 'PreToolUse', tool_name: 'Edit' });
      run({ hook_event_name: 'PreToolUse', tool_name: 'Edit' });
      screen(...claudeScreen('✻ Musing… (9s)'));
      run({ hook_event_name: 'PreToolUse', tool_name: 'Edit' });
      rmSync(pane);
      run({ hook_event_name: 'PreToolUse', tool_name: 'Edit' });
      const sent = await bodies(3);
      await sleep(200);
      expect(logged().map((b) => eventOf(b).verb ?? null)).toEqual(['Brewing', 'Musing', null]);
    });
  });
});

describe('hook script — Cursor CLI', () => {
  // beforeSubmitPrompt is a blocking event in Cursor: whatever the hook prints on stdout is its
  // answer, and it can cancel the prompt. An empty stdout lets the prompt through (checked against
  // cursor-agent 2026.09.18), so the script must never print anything, on any path.
  it('prints nothing on stdout for beforeSubmitPrompt, and forwards the payload as it came', async () => {
    const event = { hook_event_name: 'beforeSubmitPrompt', conversation_id: 'c1', prompt: 'p', attachments: [] };
    expect(runAs('cursor', event)).toBe('');
    const [body] = await bodies(1);
    expect(JSON.parse(body)).toMatchObject({ tool: 'cursor', session: 'th-abc', event });
  });

  it('prints nothing on stdout when it has nothing to send either', () => {
    rmSync(join(home, HOOK_ENV_REL));
    expect(runAs('cursor', { hook_event_name: 'beforeSubmitPrompt' })).toBe('');
  });
});
