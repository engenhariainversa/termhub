import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';

const { agentRpc, requireAgentVersion, requireTranscriptCapable, runOnMachine, runOnMachineWithInput } = vi.hoisted(() => ({
  agentRpc: vi.fn(),
  requireAgentVersion: vi.fn(),
  requireTranscriptCapable: vi.fn(),
  runOnMachine: vi.fn(),
  runOnMachineWithInput: vi.fn(),
}));
vi.mock('../agent/errors.js', () => ({ agentRpc, requireAgentVersion, requireTranscriptCapable }));
vi.mock('./machine-exec.js', async (orig) => ({ ...(await orig<typeof import('./machine-exec.js')>()), runOnMachine, runOnMachineWithInput }));
// Deterministic buffer name so the paste tests can assert the exact script instead of a pattern.
// A plain function, not vi.fn(): beforeEach's resetAllMocks() would otherwise wipe its return value.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomUUID: () => 'fixed-uuid' };
});

const {
  ensureSession,
  INPUT_MAX_CHARS,
  paneForeground,
  scrollSession,
  sendKeyToSession,
  sendTextToSession,
  TERMINAL_PASTE_MIN_AGENT_VERSION,
  TERMINAL_FOREGROUND_MIN_AGENT_VERSION,
  TERMINAL_RPC_MIN_AGENT_VERSION,
  TERMINAL_SCROLL_MIN_AGENT_VERSION,
  TYPED_LINE_MAX_BYTES,
  typeCommandLine,
} = await import('./session-ops.js');
const { buildPaneForegroundScript, buildScrollScript } = await import('@termhub/machine-ops');

const machine = (type: Machine['type']): Machine => ({ id: 'm1', name: 'jarvis', type, os: 'linux', capabilities: ['tmux'], owner_id: 'u1' }) as Machine;

// resetAllMocks (not clearAllMocks): also drops any mockImplementation from a previous test,
// so an outdated-agent throw set in one test can't leak into the next.
beforeEach(() => vi.resetAllMocks());

// Every other suite mocks this constant (control/terminals.test.ts, monitor/send-keys.test.ts,
// routes/tabs.test.ts): only this test, against the real module, would catch it silently drifting.
it('pins the input cap to 4000 characters', () => {
  expect(INPUT_MAX_CHARS).toBe(4000);
});

describe('agent machines', () => {
  it('checks the agent version before every operation and calls the named RPC', async () => {
    agentRpc.mockResolvedValue({ created: true });
    await ensureSession(machine('agent'), 's1', '/home/u/app');
    expect(requireAgentVersion).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), TERMINAL_RPC_MIN_AGENT_VERSION);
    expect(agentRpc).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), 'tmux.ensure', { session: 's1', cwd: '/home/u/app' });
    expect(runOnMachine).not.toHaveBeenCalled();
  });

  it('lets an outdated agent fail before anything is typed', async () => {
    requireAgentVersion.mockImplementation(() => {
      throw new HttpError(409, 'Atualize o agente desta máquina', 'AGENT_OUTDATED');
    });
    await expect(sendTextToSession(machine('agent'), 's1', 'oi', true)).rejects.toMatchObject({ code: 'AGENT_OUTDATED' });
    expect(agentRpc).not.toHaveBeenCalled();
  });

  it('sends text and key through their own RPCs', async () => {
    agentRpc.mockResolvedValue({ sent: true });
    await sendTextToSession(machine('agent'), 's1', 'echo oi', true);
    expect(agentRpc).toHaveBeenCalledWith(expect.anything(), 'tmux.sendText', { session: 's1', text: 'echo oi', enter: true });
    expect(requireAgentVersion).toHaveBeenCalledWith(expect.anything(), TERMINAL_RPC_MIN_AGENT_VERSION);
    await sendKeyToSession(machine('agent'), 's1', 'C-c');
    expect(agentRpc).toHaveBeenCalledWith(expect.anything(), 'tmux.sendKey', { session: 's1', key: 'C-c' });
  });

  it('sends Shift+Tab only to an agent that claims the transcript capability', async () => {
    agentRpc.mockResolvedValue({ sent: true });
    requireTranscriptCapable.mockReset();
    await sendKeyToSession(machine('agent'), 's1', 'Enter');
    expect(requireTranscriptCapable).not.toHaveBeenCalled();
    requireTranscriptCapable.mockImplementationOnce(() => {
      throw new HttpError(409, 'Atualize o agente', 'AGENT_OUTDATED');
    });
    agentRpc.mockClear();
    await expect(sendKeyToSession(machine('agent'), 's1', 'BTab')).rejects.toMatchObject({ code: 'AGENT_OUTDATED' });
    expect(agentRpc).not.toHaveBeenCalled();
  });

  it('requests paste and checks the higher, paste-only version floor when opts.paste is true', async () => {
    agentRpc.mockResolvedValue({ sent: true });
    await sendTextToSession(machine('agent'), 's1', 'linha um\nlinha dois', true, { paste: true });
    expect(requireAgentVersion).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), TERMINAL_PASTE_MIN_AGENT_VERSION);
    expect(agentRpc).toHaveBeenCalledWith(expect.anything(), 'tmux.sendText', { session: 's1', text: 'linha um\nlinha dois', enter: true, paste: true });
  });

  it('keeps the plain version floor when paste is not requested (0.2.x keeps typing)', async () => {
    agentRpc.mockResolvedValue({ sent: true });
    await sendTextToSession(machine('agent'), 's1', 'oi', true, { paste: false });
    expect(requireAgentVersion).toHaveBeenCalledWith(expect.anything(), TERMINAL_RPC_MIN_AGENT_VERSION);
    expect(agentRpc).toHaveBeenCalledWith(expect.anything(), 'tmux.sendText', { session: 's1', text: 'oi', enter: true });
  });

  it('refuses a paste request to an agent too old for it, without ever reaching the RPC', async () => {
    requireAgentVersion.mockImplementation((_m: unknown, min: string) => {
      if (min === TERMINAL_PASTE_MIN_AGENT_VERSION) throw new HttpError(409, 'Atualize o agente desta máquina', 'AGENT_OUTDATED');
    });
    await expect(sendTextToSession(machine('agent'), 's1', 'linha um\nlinha dois', true, { paste: true })).rejects.toMatchObject({ code: 'AGENT_OUTDATED' });
    expect(agentRpc).not.toHaveBeenCalled();
  });
});

// TER-987: an automatic launch line (prompt, allow and deny lists) is longer than one tmux.sendText carries,
// and a long burst typed into a fresh shell loses bytes on macOS: a long line goes through a file instead.
describe('typeCommandLine', () => {
  it('types a short line as it is, with Enter', async () => {
    agentRpc.mockResolvedValue({ sent: true });
    await typeCommandLine(machine('agent'), 's1', 'claude -- oi');
    expect(agentRpc).toHaveBeenCalledTimes(1);
    expect(agentRpc).toHaveBeenCalledWith(expect.anything(), 'tmux.sendText', { session: 's1', text: 'claude -- oi', enter: true });
  });

  it('writes a long line to a file on the machine and types only the line that runs it and removes it', async () => {
    const path = '/Users/u/.cache/termhub/paste/paste-x-launch.sh';
    agentRpc.mockImplementation(async (_m: unknown, method: string) => (method === 'file.paste' ? { path } : { sent: true }));
    const line = `claude --permission-mode acceptEdits -- '${'é'.repeat(TYPED_LINE_MAX_BYTES)}'`;
    await typeCommandLine(machine('agent'), 's1', line);
    expect(agentRpc.mock.calls.map((c) => c[1])).toEqual(['file.paste', 'tmux.sendText']);
    const written = agentRpc.mock.calls[0][2] as { name: string; data_b64: string };
    expect(written.name).toMatch(/^paste-.*-launch\.sh$/);
    expect(Buffer.from(written.data_b64, 'base64').toString('utf8')).toBe(`${line}\n`);
    expect(agentRpc.mock.calls[1][2]).toEqual({ session: 's1', text: `. '${path}'; command rm -f -- '${path}'`, enter: true });
  });

  // TER-988: the line that resumes an automatic tab's exited agent is short of the RPC cap but past 1 KB,
  // the most a fresh macOS tab keeps of what is typed: it goes through the file too.
  it('sources an automatic tab\'s resume and continue lines from a file, never typing them whole', async () => {
    const { continueLine, DEFAULT_AUTOMATION_TOOLS, resumeLine } = await import('../control/agents.js');
    const permission = { mode: 'acceptEdits' as const, allowedTools: DEFAULT_AUTOMATION_TOOLS, branch: 'TER-988-x' };
    const prompt = '[termhub automático] O processo anterior desta sessão foi encerrado no meio do trabalho. Continue a tarefa de onde parou.';
    const lines = [
      resumeLine(null, '123e4567-e89b-12d3-a456-426614174000', prompt, 'tab1', 'opus', permission),
      continueLine('claude', '~/.claude_b', { permission, prompt, mcpTabId: 'tab1' }),
    ];
    for (const line of lines) {
      expect(Buffer.byteLength(line, 'utf8')).toBeGreaterThan(1024);
      agentRpc.mockReset();
      agentRpc.mockImplementation(async (_m: unknown, method: string) => (method === 'file.paste' ? { path: '/h/p.sh' } : { sent: true }));
      await typeCommandLine(machine('agent'), 's1', line);
      expect(agentRpc.mock.calls.map((c) => c[1])).toEqual(['file.paste', 'tmux.sendText']);
      expect(Buffer.from((agentRpc.mock.calls[0][2] as { data_b64: string }).data_b64, 'base64').toString('utf8')).toBe(`${line}\n`);
      expect((agentRpc.mock.calls[1][2] as { text: string }).text).toBe(`. '/h/p.sh'; command rm -f -- '/h/p.sh'`);
    }
  });

  it('counts bytes, not characters: accented text reaches the limit sooner', async () => {
    agentRpc.mockImplementation(async (_m: unknown, method: string) => (method === 'file.paste' ? { path: '/h/p' } : { sent: true }));
    await typeCommandLine(machine('agent'), 's1', 'ç'.repeat(TYPED_LINE_MAX_BYTES / 2 + 1));
    expect(agentRpc.mock.calls[0][1]).toBe('file.paste');
  });

  it('types nothing when the file could not be written', async () => {
    agentRpc.mockRejectedValueOnce(new HttpError(502, 'Resposta inesperada da máquina'));
    await expect(typeCommandLine(machine('agent'), 's1', 'x'.repeat(TYPED_LINE_MAX_BYTES + 1))).rejects.toMatchObject({ statusCode: 502 });
    expect(agentRpc).toHaveBeenCalledTimes(1);
  });

  it('goes through the same file on a local or ssh machine', async () => {
    runOnMachineWithInput.mockResolvedValue({ code: 0, stdout: '/home/u/.cache/termhub/paste/p.sh\n', stderr: '', timedOut: false });
    runOnMachine.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false });
    const line = 'x'.repeat(TYPED_LINE_MAX_BYTES + 1);
    await typeCommandLine(machine('ssh'), 's1', line);
    expect((runOnMachineWithInput.mock.calls[0][3] as Buffer).toString('utf8')).toBe(`${line}\n`);
    const typed = runOnMachine.mock.calls.map((c) => c[2] as string).join('\n');
    expect(typed).not.toContain(line);
    expect(typed).toContain('command rm -f -- ');
    expect(typed).toContain('/home/u/.cache/termhub/paste/p.sh');
  });
});

describe('local and ssh machines', () => {
  it('quotes every value it puts in the remote command', async () => {
    runOnMachine.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false });
    await sendTextToSession(machine('ssh'), 's1', "rm -rf /; echo '$(whoami)'\n", false);
    const remote = runOnMachine.mock.calls[0][2] as string;
    expect(remote).toContain(`'rm -rf /; echo '\\''$(whoami)'\\''`);
    expect(remote.startsWith('export PATH=')).toBe(true);
    // the local argv form gets the same script, unquoted by any shell of ours
    expect(runOnMachine.mock.calls[0][1]).toMatchObject({ file: 'sh', args: ['-c', expect.stringContaining('send-keys')] });
  });

  it('creates the session with has-session || new-session', async () => {
    runOnMachine.mockResolvedValue({ code: 0, stdout: 'created\n', stderr: '', timedOut: false });
    await expect(ensureSession(machine('local'), 's1', '/home/u/app')).resolves.toEqual({ created: true });
    const remote = runOnMachine.mock.calls[0][2] as string;
    expect(remote).toContain("tmux has-session -t '=s1'");
    expect(remote).toContain("tmux new-session -d -s 's1' -c '/home/u/app'");
  });

  it('turns a non-zero exit into an HttpError the user can act on', async () => {
    runOnMachine.mockResolvedValue({ code: 1, stdout: '', stderr: 'no such file or directory\n', timedOut: false });
    await expect(ensureSession(machine('ssh'), 's1', '/gone')).rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining('no such file') });
  });

  it('says the machine did not answer on a timeout', async () => {
    runOnMachine.mockResolvedValue({ code: null, stdout: '', stderr: '', timedOut: true });
    await expect(sendKeyToSession(machine('ssh'), 's1', 'Enter')).rejects.toMatchObject({ code: 'MACHINE_TIMEOUT', message: 'A máquina não respondeu' });
  });

  it('rejects a session name that is not ours before touching the machine', async () => {
    await expect(sendKeyToSession(machine('ssh'), 'bad name', 'Enter')).rejects.toBeInstanceOf(Error);
    expect(runOnMachine).not.toHaveBeenCalled();
  });

  it('sends the Enter as its own send-keys call, after a pause, never merged into the text burst', async () => {
    // TUIs (Claude Code included) read a burst of bytes as a paste; the text and the Enter that
    // submits it must reach tmux as two separate send-keys calls with a pause between them.
    runOnMachine.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false });
    await sendTextToSession(machine('local'), 's1', 'oi', true);
    const remote = runOnMachine.mock.calls[0][2] as string;
    const textCallIdx = remote.indexOf(`send-keys -t '=s1:' -l -- 'oi'`);
    const sleepIdx = remote.indexOf('sleep 0.3');
    const enterCallIdx = remote.lastIndexOf(`send-keys -t '=s1:' Enter`);
    expect(textCallIdx).toBeGreaterThanOrEqual(0);
    expect(sleepIdx).toBeGreaterThan(textCallIdx);
    expect(enterCallIdx).toBeGreaterThan(sleepIdx);
    // exactly two send-keys invocations: one for the text, one for Enter — never merged into one
    expect(remote.match(/send-keys/g)).toHaveLength(2);
  });

  it('sends a lone Enter as a single send-keys call with no pause', async () => {
    runOnMachine.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false });
    await sendTextToSession(machine('local'), 's1', '', true);
    const remote = runOnMachine.mock.calls[0][2] as string;
    expect(remote).toContain(`send-keys -t '=s1:' Enter`);
    expect(remote).not.toContain('sleep');
    expect(remote.match(/send-keys/g)).toHaveLength(1);
  });

  it('does nothing when there is no text and no Enter to send', async () => {
    await sendTextToSession(machine('local'), 's1', '', false);
    expect(runOnMachine).not.toHaveBeenCalled();
  });

  it('pastes via a named tmux buffer instead of send-keys -l -- when opts.paste is true', async () => {
    runOnMachine.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false });
    await sendTextToSession(machine('ssh'), 's1', 'linha um\nlinha dois', true, { paste: true });
    const remote = runOnMachine.mock.calls[0][2] as string;
    expect(remote).toContain(`printf '%s' 'linha um\nlinha dois' | tmux load-buffer -b 'termhub-paste-fixed-uuid' -`);
    expect(remote).toContain(`tmux paste-buffer -p -d -b 'termhub-paste-fixed-uuid' -t '=s1:'`);
    expect(remote).toContain(`tmux delete-buffer -b 'termhub-paste-fixed-uuid'`);
    expect(remote).not.toContain('-l --');
    const pasteIdx = remote.indexOf('paste-buffer');
    const deleteIdx = remote.indexOf('delete-buffer');
    const sleepIdx = remote.indexOf('sleep 0.3');
    const enterIdx = remote.lastIndexOf(`send-keys -t '=s1:' Enter`);
    expect(deleteIdx).toBeGreaterThan(pasteIdx);
    expect(sleepIdx).toBeGreaterThan(deleteIdx);
    expect(enterIdx).toBeGreaterThan(sleepIdx);
  });

  it('sequences the delete-buffer to run unconditionally, even when the paste itself fails', async () => {
    // The script's own success/failure is decided by tmux on the real machine, not by this JS
    // string — what this test pins is the *shape* of the generated script: the buffer's removal
    // must be sequenced with `;` (always runs) after the paste attempt, not `&&` (skipped on
    // failure), and the original pass/fail must still be what the rest of the chain (Enter) sees.
    runOnMachine.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false });
    await sendTextToSession(machine('ssh'), 's1', 'linha um\nlinha dois', true, { paste: true });
    const remote = runOnMachine.mock.calls[0][2] as string;
    expect(remote).toContain(
      `; } || RC=$?; tmux delete-buffer -b 'termhub-paste-fixed-uuid' >/dev/null 2>&1; [ "$RC" -eq 0 ]`,
    );
  });

  it('turns a non-zero exit from the paste script into an HttpError, same as any other failed remote command', async () => {
    runOnMachine.mockResolvedValue({ code: 1, stdout: '', stderr: "can't find pane\n", timedOut: false });
    await expect(sendTextToSession(machine('ssh'), 's1', 'linha um\nlinha dois', true, { paste: true })).rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining("can't find pane") });
  });
});

describe('scrollSession', () => {
  it('pins the agent floor to 0.12.0, the first release with tmux.scroll', () => {
    expect(TERMINAL_SCROLL_MIN_AGENT_VERSION).toBe('0.12.0');
  });

  it('agent: checks the scroll floor, then calls tmux.scroll', async () => {
    agentRpc.mockResolvedValue({ done: true });
    await scrollSession(machine('agent'), 's1', -3);
    expect(requireAgentVersion).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), TERMINAL_SCROLL_MIN_AGENT_VERSION);
    expect(agentRpc).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), 'tmux.scroll', { session: 's1', lines: -3 });
    expect(runOnMachine).not.toHaveBeenCalled();
  });

  it('agent: an outdated agent never gets the RPC', async () => {
    requireAgentVersion.mockImplementation(() => {
      throw new HttpError(409, 'Atualize o agente desta máquina', 'AGENT_OUTDATED');
    });
    await expect(scrollSession(machine('agent'), 's1', 2)).rejects.toMatchObject({ code: 'AGENT_OUTDATED' });
    expect(agentRpc).not.toHaveBeenCalled();
  });

  it('ssh and local: run the same script as the agent, behind the PATH prefix', async () => {
    runOnMachine.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false });
    for (const type of ['ssh', 'local'] as const) {
      runOnMachine.mockClear();
      await scrollSession(machine(type), 's1', 0);
      const script = buildScrollScript('s1', 0);
      expect(runOnMachine.mock.calls[0][1]).toEqual({ file: 'sh', args: ['-c', script] });
      expect(runOnMachine.mock.calls[0][2]).toBe(`export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; ${script}`);
    }
    expect(requireAgentVersion).not.toHaveBeenCalled();
    expect(agentRpc).not.toHaveBeenCalled();
  });

  it('refuses a bad session name or line count before touching the machine', async () => {
    await expect(scrollSession(machine('ssh'), "s1'; id; '", -1)).rejects.toBeInstanceOf(Error);
    await expect(scrollSession(machine('ssh'), 's1', 501)).rejects.toBeInstanceOf(Error);
    await expect(scrollSession(machine('agent'), 's1', 1.5)).rejects.toBeInstanceOf(Error);
    expect(runOnMachine).not.toHaveBeenCalled();
    expect(agentRpc).not.toHaveBeenCalled();
  });
});

describe('paneForeground (TER-643)', () => {
  it('pins the agent floor to 0.14.0, the first release with tmux.foreground', () => {
    expect(TERMINAL_FOREGROUND_MIN_AGENT_VERSION).toBe('0.14.0');
  });

  it('agent: checks the floor, then calls tmux.foreground', async () => {
    agentRpc.mockResolvedValue({ pane: 'shell' });
    await expect(paneForeground(machine('agent'), 's1')).resolves.toBe('shell');
    expect(requireAgentVersion).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), TERMINAL_FOREGROUND_MIN_AGENT_VERSION);
    expect(agentRpc).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), 'tmux.foreground', { session: 's1' });
    expect(runOnMachine).not.toHaveBeenCalled();
  });

  it('agent: an outdated agent never gets the RPC', async () => {
    requireAgentVersion.mockImplementation(() => {
      throw new HttpError(409, 'Atualize o agente desta máquina', 'AGENT_OUTDATED');
    });
    await expect(paneForeground(machine('agent'), 's1')).rejects.toMatchObject({ code: 'AGENT_OUTDATED' });
    expect(agentRpc).not.toHaveBeenCalled();
  });

  it('ssh/local: runs the shared script and reads its word', async () => {
    runOnMachine.mockResolvedValue({ code: 0, stdout: 'busy\n', stderr: '', timedOut: false });
    await expect(paneForeground(machine('local'), 's1')).resolves.toBe('busy');
    expect(runOnMachine).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), { file: 'sh', args: ['-c', buildPaneForegroundScript('s1')] }, expect.stringContaining(buildPaneForegroundScript('s1')), expect.any(Number));
    runOnMachine.mockResolvedValue({ code: 0, stdout: 'zsh: ps: not found\n', stderr: '', timedOut: false });
    await expect(paneForeground(machine('ssh'), 's1')).rejects.toMatchObject({ code: 'MACHINE_FAILED' });
  });
});
