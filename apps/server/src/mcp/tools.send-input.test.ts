import { expect, it, vi } from 'vitest';

// TER-1168: what the tool adapters hand the control layer, and the rule the concierge reads in their description
// (the orchestrator prompt has no room left: lesson 2026-11-06-orchestrator-prompt-budget).
const { sendInput, sendKey } = vi.hoisted(() => ({ sendInput: vi.fn(async () => ({ tab_id: 't1', sent: true })), sendKey: vi.fn(async () => ({ tab_id: 't1', key: 'Enter', sent: true })) }));
vi.mock('../control/terminals.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../control/terminals.js')>()), sendInput, sendKey }));

import type { ControlContext } from '../control/context.js';
import { TOOLS } from './tools.js';

const tool = (name: string) => TOOLS.find((t) => t.name === name)!;
const ctx = {} as ControlContext;
const signal = new AbortController().signal;

it('send_input refuses an exited agent and confirms delivery, unless to_shell asks for the shell', async () => {
  await tool('send_input').run(ctx, { tab_id: 't1', text: 'oi' }, signal);
  expect(sendInput).toHaveBeenLastCalledWith(ctx, { tab_id: 't1', text: 'oi' }, undefined, { requireAgent: true, confirm: true });
  await tool('send_input').run(ctx, { tab_id: 't1', text: 'ls', to_shell: true }, signal);
  expect(sendInput).toHaveBeenLastCalledWith(ctx, { tab_id: 't1', text: 'ls' }, undefined, { requireAgent: false, confirm: false });
});

it('send_key refuses an exited agent unless to_shell asks for the shell', async () => {
  await tool('send_key').run(ctx, { tab_id: 't1', key: 'Enter' }, signal);
  expect(sendKey).toHaveBeenLastCalledWith(ctx, { tab_id: 't1', key: 'Enter' }, { requireAgent: true });
  await tool('send_key').run(ctx, { tab_id: 't1', key: 'C-c', to_shell: true }, signal);
  expect(sendKey).toHaveBeenLastCalledWith(ctx, { tab_id: 't1', key: 'C-c' }, { requireAgent: false });
});

it('the descriptions say when a promise to report back may be made, and what gone means', () => {
  const d = tool('send_input').description;
  expect(d).toContain('AGENT_NOT_RUNNING');
  expect(d).toContain('Promise the person to report back ("te aviso") only after delivered is true');
  expect(tool('send_key').description).toContain('AGENT_NOT_RUNNING');
  expect(tool('watch').description).toContain('its agent exited (also before the watch) or the text sent to it started no turn');
  expect(tool('get_project_health').description).toContain('agent_exited');
});
