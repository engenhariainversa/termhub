import { beforeEach, expect, it, vi } from 'vitest';
import type { ClaudeOpenParams } from '@termhub/agent-protocol';
import type { AgentChannel, ChannelClosedReason, ChannelHandlers } from '../agent/connection.js';
import { ChannelLimitError } from '../agent/connection.js';
import { parseFrame } from './stream.js';

/** The real config reads the process env and exits on a bad one; this suite only needs the public
 * MCP endpoint, which it flips per case through a stand-in the runner reads on every call. */
const state = vi.hoisted(() => ({ config: {} as { mcpUrl: string | null } }));
vi.mock('../config.js', () => ({ config: state.config }));

const { agentRunner } = await import('./agent-runner.js');

const input = {
  session_id: '3f1e9b1e-0000-4000-8000-000000000001',
  resume: true,
  text: 'o que está rodando?',
  config_dir: '/home/u/.claude-work',
  model: 'sonnet',
  token: 'thb_pat_' + 'A'.repeat(43),
};

/** One channel on one machine, driven by hand: no socket, no agent, no CLI. */
function fakeHost(opts: { capabilities?: string[] | null; failOpen?: Error } = {}) {
  let announceOpen = () => {};
  const opened = new Promise<void>((resolve) => (announceOpen = resolve));
  const seen = {
    machineIds: [] as string[],
    /**
     * The open frame as it would go on the wire, and deliberately **not** typed `ClaudeOpenParams`:
     * that type's own excess-property check is what makes a prompt field impossible in the runner's
     * source, so a test asserting against it could never fail. Recorded loose, the assertion below is
     * about what this fake was actually handed — which a cast in the runner would not get past.
     */
    params: [] as Record<string, unknown>[],
    writes: [] as Buffer[],
    closes: 0,
    handlers: null as ChannelHandlers | null,
  };
  const host = {
    capabilities: () => (opts.capabilities === undefined ? ['pty', 'claude'] : opts.capabilities),
    openClaude: async (machineId: string, params: ClaudeOpenParams, handlers: ChannelHandlers): Promise<AgentChannel> => {
      seen.machineIds.push(machineId);
      seen.params.push(params);
      if (opts.failOpen) throw opts.failOpen;
      seen.handlers = handlers;
      announceOpen();
      return {
        ch: 7,
        write: (data: Buffer | string) => void seen.writes.push(Buffer.from(data)),
        close: () => void (seen.closes += 1),
      };
    },
  };
  return {
    host,
    seen,
    opened,
    /** What the agent streams back on the channel, as it frames it: bytes, not lines. */
    send: (chunk: string) => seen.handlers?.onData(Buffer.from(chunk, 'utf8')),
    /** The channel ended: `closed` from the agent, or the connection dropping under it. */
    exit: (code: number | null, reason?: ChannelClosedReason) => seen.handlers?.onExit(code, reason),
  };
}

/** Drains a whole run in the background, so the test can drive the fake agent while it reads. */
function collect(iterable: AsyncIterable<string>): { lines: string[]; done: Promise<unknown> } {
  const lines: string[] = [];
  const done = (async () => {
    for await (const line of iterable) lines.push(line);
  })().then(
    () => null,
    (err) => err,
  );
  return { lines, done };
}

const lastFrame = (lines: string[]) => parseFrame(lines[lines.length - 1]);

beforeEach(() => {
  state.config.mcpUrl = 'https://termhub.dev/mcp';
});

it('opens a claude channel on that machine with the params derived from the input, and yields a line per line', async () => {
  const agent = fakeHost();
  const run = collect(agentRunner('m-1', { host: agent.host }).run(input));

  await agent.opened;
  expect(agent.seen.machineIds).toEqual(['m-1']);
  expect(agent.seen.params[0]).toEqual({
    session_id: input.session_id,
    resume: true,
    config_dir: '/home/u/.claude-work',
    mcp_url: 'https://termhub.dev/mcp',
    token: input.token,
    model: 'sonnet',
    append_system_prompt: null,
  });

  agent.send('{"type":"stream_event"}\n');
  agent.exit(0);
  await run.done;
  expect(run.lines).toEqual(['{"type":"stream_event"}']);
});

it('forwards append_system_prompt when the input carries one (a project chat)', async () => {
  const agent = fakeHost();
  const run = collect(agentRunner('m-1', { host: agent.host }).run({ ...input, append_system_prompt: 'foco' }));

  await agent.opened;
  expect(agent.seen.params[0]).toMatchObject({ append_system_prompt: 'foco' });

  agent.exit(0);
  await run.done;
});

it('writes the prompt as one frame after the channel is open, and never as an open parameter', async () => {
  // Ruling: `claudeOpenParams` has no prompt field and safeParse strips unknown keys, so a prompt
  // put in the open frame is dropped in silence and the run hangs until a timeout.
  const agent = fakeHost();
  const run = collect(agentRunner('m-1', { host: agent.host }).run({ ...input, text: '-n --help' }));

  await agent.opened;
  // The whole frame, as the agent would receive it: the prompt is nowhere in it, under no key.
  expect(Object.values(agent.seen.params[0])).not.toContain('-n --help');
  expect(JSON.stringify(agent.seen.params[0])).not.toContain('--help');
  expect(agent.seen.writes).toHaveLength(1);
  expect(agent.seen.writes[0].toString('utf8')).toBe('-n --help');

  agent.exit(0);
  await run.done;
});

it('reassembles the stream by newline: two lines in one frame, one line across two frames', async () => {
  const agent = fakeHost();
  const run = collect(agentRunner('m-1', { host: agent.host }).run(input));

  await agent.opened;
  agent.send('{"a":1}\n{"b":2}\n');
  agent.send('{"c":');
  agent.send('3}\n');
  agent.exit(0);
  await run.done;

  expect(run.lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
});

it('ends the iteration on a non-zero exit, with no done frame in what it yielded', async () => {
  const agent = fakeHost();
  const run = collect(agentRunner('m-1', { host: agent.host }).run(input));

  await agent.opened;
  agent.send(`${JSON.stringify({ type: 'stream_event' })}\n`);
  agent.exit(1, 'run_failed');
  await run.done;

  // The service's existing rule — a run with no `done` frame is a failed run — is what marks this
  // one failed, so the absence is the assertion.
  expect(run.lines.map((l) => parseFrame(l)?.type)).not.toContain('done');
  expect(lastFrame(run.lines)).toMatchObject({ type: 'error', reason: 'run_failed' });
});

it('ends with a reason of its own when the host goes away mid-answer', async () => {
  const agent = fakeHost();
  const run = collect(agentRunner('m-1', { host: agent.host }).run(input));

  await agent.opened;
  agent.send(`${JSON.stringify({ type: 'stream_event' })}\n`);
  // The connection dropped with the channel open: no exit code and nothing said about the run,
  // because the machine — a laptop that slept, a network that went — is what ended it.
  agent.exit(null);
  await run.done;

  expect(await run.done).toBeNull(); // a host that went away is a failed run, never a thrown route error
  expect(run.lines).toHaveLength(2);
  expect(lastFrame(run.lines)).toMatchObject({ type: 'error', reason: 'host_gone' });
});

it('refuses an agent without the claude capability before it opens anything', async () => {
  const agent = fakeHost({ capabilities: ['pty'] });
  const run = collect(agentRunner('m-1', { host: agent.host }).run(input));
  await run.done;

  expect(agent.seen.machineIds).toEqual([]); // no channel was ever minted on that machine
  expect(run.lines).toHaveLength(1);
  expect(lastFrame(run.lines)).toMatchObject({ type: 'error', reason: 'agent_too_old' });
});

it('closes the channel when the caller stops reading', async () => {
  const agent = fakeHost();
  const iterable = agentRunner('m-1', { host: agent.host }).run(input);
  const seen: string[] = [];
  const reading = (async () => {
    for await (const line of iterable) {
      seen.push(line);
      break; // the browser disconnected, the deadline passed: nobody is listening any more
    }
  })();

  await agent.opened;
  agent.send('{"a":1}\n');
  await reading;

  expect(seen).toEqual(['{"a":1}']);
  // Not "a function returned": the channel the machine is running a CLI on is actually closed.
  expect(agent.seen.closes).toBe(1);
});

it('never closes a channel the agent already ended, whose number the next terminal may already have', async () => {
  const agent = fakeHost();
  const run = collect(agentRunner('m-1', { host: agent.host }).run(input));

  await agent.opened;
  agent.exit(0);
  await run.done;

  // Channel numbers are reserved, not unique for ever: the connection frees one as soon as it is
  // closed, so a late close by number would land on whatever channel now holds it.
  expect(agent.seen.closes).toBe(0);
});

it('closes the channel when the run outstays its deadline, and ends the iteration', async () => {
  const agent = fakeHost();
  const run = collect(agentRunner('m-1', { host: agent.host, deadlineMs: 20 }).run(input));

  await agent.opened;
  await run.done;

  expect(agent.seen.closes).toBe(1);
  expect(lastFrame(run.lines)).toMatchObject({ type: 'error', reason: 'run_failed' });
});

it('passes missing_session through, so the service retries once on a fresh session', async () => {
  const agent = fakeHost();
  const run = collect(agentRunner('m-1', { host: agent.host }).run(input));

  await agent.opened;
  agent.exit(1, 'missing_session');
  await run.done;

  // The very reason the container's stream carries, on the very frame it carries it on: the
  // service's self-healing retry is one path, not one per runner.
  expect(lastFrame(run.lines)).toMatchObject({ type: 'error', reason: 'missing_session' });
});

it('carries cli_missing, the likeliest first failure, as its own reason', async () => {
  const agent = fakeHost();
  const run = collect(agentRunner('m-1', { host: agent.host }).run(input));

  await agent.opened;
  agent.exit(null, 'cli_missing');
  await run.done;

  expect(JSON.parse(run.lines[0])).toMatchObject({ type: 'termhub_error', reason: 'cli_missing' });
});

it('carries cli_rejected through, so the CLI that refused our flags keeps its own sentence', async () => {
  const agent = fakeHost();
  const run = collect(agentRunner('m-1', { host: agent.host }).run(input));

  await agent.opened;
  // A `claude` on the user's own machine too old (or too new) for the argv we build. Collapsed into
  // `run_failed` anywhere along this chain, the person reads "the answer failed" and retries for ever,
  // while the instruction that fixes it ("update claude on that machine") is never shown.
  agent.exit(1, 'cli_rejected');
  await run.done;

  expect(lastFrame(run.lines)).toMatchObject({ type: 'error', reason: 'cli_rejected' });
});

it('reports a machine that is not connected without opening anything', async () => {
  const agent = fakeHost({ capabilities: null });
  const run = collect(agentRunner('m-1', { host: agent.host }).run(input));
  await run.done;

  expect(agent.seen.machineIds).toEqual([]);
  expect(lastFrame(run.lines)).toMatchObject({ type: 'error', reason: 'host_gone' });
});

it('reports an open that the agent refused, without leaving the iteration hanging', async () => {
  const agent = fakeHost({ failOpen: new Error('agent offline: m-1') });
  const run = collect(agentRunner('m-1', { host: agent.host }).run(input));
  await run.done;

  expect(agent.seen.closes).toBe(0); // there is no channel to close
  expect(lastFrame(run.lines)).toMatchObject({ type: 'error', reason: 'host_gone' });
});

it('tells a machine with no channel left apart from a machine that went away', async () => {
  // 64 terminals open on a healthy machine: the connection is fine and nothing about it is wrong, so
  // this must not say "a sua máquina saiu do ar" — the person would go hunting for a machine that is
  // right there, and the thing that unblocks the chat is closing a few tabs.
  const agent = fakeHost({ failOpen: new ChannelLimitError('too many channels') });
  const run = collect(agentRunner('m-1', { host: agent.host }).run(input));
  await run.done;

  expect(lastFrame(run.lines)).toMatchObject({ type: 'error', reason: 'host_busy' });
  expect(agent.seen.closes).toBe(0);
});

it('refuses with 503 CONCIERGE_DISABLED when the server has no public MCP endpoint', () => {
  // Same failure the container path answers, for the same reason: without an MCP endpoint outside
  // Cloudflare Access the CLI on the user's machine has nothing to reach termhub through.
  state.config.mcpUrl = null;
  expect(() => agentRunner('m-1', { host: fakeHost().host }).run(input)).toThrowError(
    expect.objectContaining({ statusCode: 503, code: 'CONCIERGE_DISABLED' }),
  );
});

it('streams: writes before the open are buffered, then framed in order, and refused once the channel ended', async () => {
  const h = fakeHost({ capabilities: ['pty', 'claude', 'claude.stream_input'] });
  const stream = agentRunner('m1', { host: h.host }).run({ ...input, text: '{"a":1}\n', stream_input: true });
  expect(stream.write?.('{"b":2}')).toBe(true);
  const run = collect(stream);
  await h.opened;
  expect(stream.write?.('{"c":3}')).toBe(true);
  expect(h.seen.writes.map((b) => b.toString('utf8'))).toEqual(['{"a":1}\n', '{"b":2}\n', '{"c":3}\n']);
  expect(h.seen.params[0]).toMatchObject({ stream_input: true });
  h.exit(0);
  await run.done;
  expect(stream.write?.('{"d":4}')).toBe(false);
});

it('leaves the open frame of a one-shot run exactly as it was', async () => {
  const h = fakeHost();
  const run = collect(agentRunner('m1', { host: h.host }).run(input));
  await h.opened;
  expect(h.seen.params[0]).not.toHaveProperty('stream_input');
  h.exit(0);
  await run.done;
});

it('refuses writes to a run that never opened (machine offline)', async () => {
  const h = fakeHost({ capabilities: null });
  const stream = agentRunner('m1', { host: h.host }).run({ ...input, stream_input: true });
  await collect(stream).done;
  expect(stream.write?.('{"a":1}')).toBe(false);
});
