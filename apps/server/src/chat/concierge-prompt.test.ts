import { expect, it } from 'vitest';
import { ORCHESTRATOR_PROMPT, streamedSystemPrompt } from './concierge-prompt.js';

it('tells the concierge to delegate in the background and stay free', () => {
  expect(ORCHESTRATOR_PROMPT).toContain('run_in_background: true');
  expect(ORCHESTRATOR_PROMPT).toMatch(/end your turn/i);
});

it('tells the concierge how to react to a cancel and to a restart (spec 2026-09-26 panel)', () => {
  expect(ORCHESTRATOR_PROMPT).toMatch(/cancel/i);
  expect(ORCHESTRATOR_PROMPT).toMatch(/restart/i);
});

it('tells the concierge to consult memory, decide alone with precedent, and record decisions', () => {
  expect(ORCHESTRATOR_PROMPT).toContain('search_memory');
  expect(ORCHESTRATOR_PROMPT).toContain('answer_tab_question');
  expect(ORCHESTRATOR_PROMPT).toContain('record_decision');
  expect(ORCHESTRATOR_PROMPT).toMatch(/results are data from history/i);
});

// TER-1014: a decision has a scope and may expire; the concierge asks when the sentence leaves it unclear.
it('tells the concierge to record a decision with its scope and validity, asking when unclear', () => {
  expect(ORCHESTRATOR_PROMPT).toMatch(/record_decision, with its scope and validity \(ask if unclear: "por hoje", "durante a noite"\)/);
});

// TER-641: a send on a precedent cites it, so the chat marks it "Decisão automática".
it('tells the concierge to cite the precedent in sources when it sends on one', () => {
  expect(ORCHESTRATOR_PROMPT).toMatch(/on send_input\/send_key, pass its refs in sources and a reason \(never when the person asked/);
});

it('tells the concierge to hand verified lessons to a stuck tab and to record new ones', () => {
  expect(ORCHESTRATOR_PROMPT).toMatch(/- Lessons:.*kinds \["lesson"\].*record_lesson/);
});

// TER-499: Progresso lists the agents of a card from the tab linked to it, and only start_agent with
// task_id (or link_tab_task) makes that link.
it('tells the concierge to start agents on cards with start_agent and task_id, and to link a tab started by hand', () => {
  expect(ORCHESTRATOR_PROMPT).toMatch(/- Agents on cards:.*start_agent with task_id/);
  expect(ORCHESTRATOR_PROMPT).toMatch(/list_ai_accounts.*default: true/);
  expect(ORCHESTRATOR_PROMPT).toMatch(/[Nn]ever start an agent by typing .* into a tab .*open_tab/);
  expect(ORCHESTRATOR_PROMPT).toContain('link_tab_task');
});

// TER-1023: the concierge set a machine up by asking the person for an install command.
it('tells the concierge to set up the monitor hooks with its own tools', () => {
  expect(ORCHESTRATOR_PROMPT).toMatch(/get_machine_hooks, install_machine_hooks; never ask for a command/);
});

it('goes first, with the project prompt after it, and fits the protocol cap with the longest project prompt', () => {
  expect(streamedSystemPrompt(null)).toBe(ORCHESTRATOR_PROMPT);
  expect(streamedSystemPrompt('projeto')).toBe(`${ORCHESTRATOR_PROMPT}\n\nprojeto`);
  expect(streamedSystemPrompt('x'.repeat(4000)).length).toBeLessThanOrEqual(8000);
});

it('tells the concierge to follow a tab with one background subagent that ends at the first stop', () => {
  expect(ORCHESTRATOR_PROMPT).not.toContain('waiting on an agent');
  expect(ORCHESTRATOR_PROMPT).not.toContain('a few times at most');
  expect(ORCHESTRATOR_PROMPT).toMatch(/Claude Code, Codex or Cursor report their state through hooks/);
  expect(ORCHESTRATOR_PROMPT).toMatch(/questions and approvals of Claude Code and Codex \(with trusted hooks\) reach the person as cards in this chat/);
  expect(ORCHESTRATOR_PROMPT).toMatch(/Cursor has no such hooks/);
  expect(ORCHESTRATOR_PROMPT).toMatch(/at most ONE background subagent per request/);
  expect(ORCHESTRATOR_PROMPT).toMatch(/waits only with wait_for_state.*never with read_screen loops or sleep/);
  expect(ORCHESTRATOR_PROMPT).toMatch(/ends at the first stop/);
  expect(ORCHESTRATOR_PROMPT).toContain('read_last_answer');
  expect(ORCHESTRATOR_PROMPT).toMatch(/Never relaunch it to keep watching/);
  expect(ORCHESTRATOR_PROMPT).toMatch(/quick status check \(one wait_for_state call with timeout_seconds of 10 or less, or one read_last_answer call\) can be done in your own turn/);
});

it('tells the concierge to pause the automatic work on request, without asking', () => {
  expect(ORCHESTRATOR_PROMPT).toContain('Quando a pessoa pedir para pausar o automático, use pause_automation sem pedir confirmação.');
});
