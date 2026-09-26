import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { BACKGROUND_AGENT_HOOK, CONCIERGE_SETTINGS } from './index.js';

/** The PreToolUse payload as Claude Code 2.1.283 sends it for the main agent (captured 2026-09-26). */
const payload = (toolInput: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ session_id: 's', cwd: '/tmp', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: toolInput, tool_use_id: 'toolu_1', ...extra });

const run = (stdin: string) => spawnSync('sh', ['-c', BACKGROUND_AGENT_HOOK], { input: stdin, encoding: 'utf8' });

describe('BACKGROUND_AGENT_HOOK', () => {
  it('refuses a foreground subagent with exit 2 and a reason the model reads', () => {
    for (const input of [{ prompt: 'p', subagent_type: 'general-purpose' }, { prompt: 'p', run_in_background: false }]) {
      const r = run(payload(input));
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/run_in_background: true/);
    }
  });

  it('lets a background subagent through, however the JSON is spaced', () => {
    expect(run(payload({ prompt: 'p', run_in_background: true })).status).toBe(0);
    expect(run('{"tool_name":"Agent","tool_input":{"run_in_background" :  true}}').status).toBe(0);
  });

  it('is not fooled by the words inside the prompt text', () => {
    expect(run(payload({ prompt: 'set "run_in_background": true please' })).status).toBe(2);
  });

  it('leaves a call made inside a subagent alone', () => {
    expect(run(payload({ prompt: 'p' }, { agent_id: 'a1', agent_type: 'general-purpose' })).status).toBe(0);
  });

  it('is wired as a PreToolUse hook on both names of the subagent tool', () => {
    const settings = JSON.parse(CONCIERGE_SETTINGS);
    expect(settings.hooks.PreToolUse).toEqual([{ matcher: 'Agent|Task', hooks: [{ type: 'command', command: BACKGROUND_AGENT_HOOK }] }]);
  });
});
