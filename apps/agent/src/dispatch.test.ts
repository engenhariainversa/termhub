import type { ServerMessage } from '@termhub/agent-protocol';
import { describe, expect, it, vi } from 'vitest';
import type { AgentSocket } from './client.js';
import { createDispatcher, type ClaudeManager, type PtyManager, type TcpManager } from './dispatch.js';
import { RpcFailure } from './exec.js';
import type { Handlers } from './rpc/index.js';

function makeSocket(): { socket: AgentSocket; sendControl: ReturnType<typeof vi.fn>; sendStream: ReturnType<typeof vi.fn> } {
  const sendControl = vi.fn();
  const sendStream = vi.fn();
  return { socket: { sendControl, sendStream }, sendControl, sendStream };
}

function makePty(): PtyManager {
  return { open: vi.fn().mockResolvedValue(undefined), write: vi.fn(), resize: vi.fn(), close: vi.fn(), closeAll: vi.fn() };
}

function makeClaude(): ClaudeManager {
  return { open: vi.fn().mockResolvedValue(undefined), write: vi.fn().mockReturnValue(false), close: vi.fn(), closeAll: vi.fn() };
}

function makeTcp(): TcpManager {
  return { open: vi.fn().mockResolvedValue(undefined), write: vi.fn().mockReturnValue(false), close: vi.fn(), closeAll: vi.fn() };
}

function makeHandlers(overrides: Partial<Handlers> = {}): Handlers {
  const notImplemented = async () => {
    throw new Error('not stubbed for this test');
  };
  return {
    'tmux.list': notImplemented,
    'tmux.kill': notImplemented,
    'tmux.capture': notImplemented,
    'tools.detect': notImplemented,
    'hw.probe': notImplemented,
    'fs.list': notImplemented,
    'fs.mkdir': notImplemented,
    'ai.usage': notImplemented,
    'file.paste': notImplemented,
    ...overrides,
  } as Handlers;
}

/** Lets the fire-and-forget `void handleRpc(...)` promise chain settle before assertions run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('createDispatcher', () => {
  it('replies rpc_result ok:false code:invalid on bad params, echoing the id', async () => {
    const { socket, sendControl } = makeSocket();
    const dispatch = createDispatcher({ handlers: makeHandlers(), pty: makePty(), claude: makeClaude(), tcp: makeTcp(), log: vi.fn() });

    // `session` fails the sessionName regex (empty string).
    dispatch({ type: 'rpc', id: 'r1', method: 'tmux.kill', params: { session: '' } }, socket);
    await flush();

    expect(sendControl).toHaveBeenCalledWith({ type: 'rpc_result', id: 'r1', ok: false, error: { code: 'invalid', message: 'invalid params' } });
  });

  it('maps a handler throw to a generic internal error and logs the method (never params)', async () => {
    const { socket, sendControl } = makeSocket();
    const log = vi.fn();
    const handlers = makeHandlers({
      'tmux.kill': async () => {
        throw new Error('boom');
      },
    });
    const dispatch = createDispatcher({ handlers, pty: makePty(), claude: makeClaude(), tcp: makeTcp(), log });

    dispatch({ type: 'rpc', id: 'r2', method: 'tmux.kill', params: { session: 'th-a' } }, socket);
    await flush();

    expect(sendControl).toHaveBeenCalledWith({ type: 'rpc_result', id: 'r2', ok: false, error: { code: 'internal', message: 'internal error' } });
    expect(log).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: 'tmux.kill' }));
    // Never leak params in the log call.
    for (const call of log.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('th-a');
    }
  });

  it('maps an RpcFailure to its own code/message/path', async () => {
    const { socket, sendControl } = makeSocket();
    const handlers = makeHandlers({
      'fs.list': async () => {
        throw new RpcFailure('eperm', 'permission denied', '/root');
      },
    });
    const dispatch = createDispatcher({ handlers, pty: makePty(), claude: makeClaude(), tcp: makeTcp(), log: vi.fn() });

    dispatch({ type: 'rpc', id: 'r3', method: 'fs.list', params: { path: '/root' } }, socket);
    await flush();

    expect(sendControl).toHaveBeenCalledWith({
      type: 'rpc_result',
      id: 'r3',
      ok: false,
      error: { code: 'eperm', message: 'permission denied', path: '/root' },
    });
  });

  it('maps a result that violates its own zod schema to internal', async () => {
    const { socket, sendControl } = makeSocket();
    const handlers = makeHandlers({ 'tmux.list': async () => ({ sessions: [123] }) as never });
    const dispatch = createDispatcher({ handlers, pty: makePty(), claude: makeClaude(), tcp: makeTcp(), log: vi.fn() });

    dispatch({ type: 'rpc', id: 'r4', method: 'tmux.list', params: {} }, socket);
    await flush();

    expect(sendControl).toHaveBeenCalledWith({ type: 'rpc_result', id: 'r4', ok: false, error: { code: 'internal', message: 'internal error' } });
  });

  it('replies ok:true with the parsed handler result on success', async () => {
    const { socket, sendControl } = makeSocket();
    const handlers = makeHandlers({ 'tmux.list': async () => ({ sessions: ['th-a'] }) });
    const dispatch = createDispatcher({ handlers, pty: makePty(), claude: makeClaude(), tcp: makeTcp(), log: vi.fn() });

    dispatch({ type: 'rpc', id: 'r5', method: 'tmux.list', params: {} }, socket);
    await flush();

    expect(sendControl).toHaveBeenCalledWith({ type: 'rpc_result', id: 'r5', ok: true, result: { sessions: ['th-a'] } });
  });

  it('routes open/resize/close to the pty manager with the same channel', async () => {
    const { socket } = makeSocket();
    const pty = makePty();
    const dispatch = createDispatcher({ handlers: makeHandlers(), pty, claude: makeClaude(), tcp: makeTcp(), log: vi.fn() });
    const openParams = { session: 'th-a', cwd: '/tmp', cols: 80, rows: 24 };

    const openMsg: ServerMessage = { type: 'open', ch: 3, kind: 'pty', params: openParams };
    dispatch(openMsg, socket);
    dispatch({ type: 'resize', ch: 3, cols: 100, rows: 40 }, socket);
    dispatch({ type: 'close', ch: 3 }, socket);
    await flush();

    expect(pty.open).toHaveBeenCalledWith(3, openParams, socket);
    expect(pty.resize).toHaveBeenCalledWith(3, 100, 40);
    expect(pty.close).toHaveBeenCalledWith(3);
  });

  it('logs (but does not throw or reply) when pty.open unexpectedly rejects', async () => {
    const { socket, sendControl } = makeSocket();
    const log = vi.fn();
    const pty = makePty();
    (pty.open as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('pty crashed'));
    const dispatch = createDispatcher({ handlers: makeHandlers(), pty, claude: makeClaude(), tcp: makeTcp(), log });

    const openParams = { session: 'th-a', cwd: '/tmp', cols: 80, rows: 24 };
    dispatch({ type: 'open', ch: 1, kind: 'pty', params: openParams }, socket);
    await flush();

    expect(log).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ ch: 1 }));
    expect(sendControl).not.toHaveBeenCalled();
  });
  it('routes an open with kind: claude to the claude manager and never to the pty one', async () => {
    const { socket } = makeSocket();
    const pty = makePty();
    const claude = makeClaude();
    const dispatch = createDispatcher({ handlers: makeHandlers(), pty, claude, tcp: makeTcp(), log: vi.fn() });
    const claudeParams = {
      session_id: '3f1e9b1e-0000-4000-8000-000000000001',
      resume: false,
      config_dir: null,
      mcp_url: 'https://termhub.dev/mcp',
      token: 'thb_pat_' + 'A'.repeat(43),
      model: null,
    };

    dispatch({ type: 'open', ch: 5, kind: 'claude', params: claudeParams }, socket);
    await flush();

    expect(claude.open).toHaveBeenCalledWith(5, claudeParams, socket);
    expect(pty.open).not.toHaveBeenCalled();
  });

  it('offers close to both managers, since the message carries no kind', async () => {
    const { socket } = makeSocket();
    const pty = makePty();
    const claude = makeClaude();
    const dispatch = createDispatcher({ handlers: makeHandlers(), pty, claude, tcp: makeTcp(), log: vi.fn() });

    dispatch({ type: 'close', ch: 7 }, socket);
    await flush();

    // The channel belongs to exactly one of them; the other ignores a channel it never opened.
    expect(pty.close).toHaveBeenCalledWith(7);
    expect(claude.close).toHaveBeenCalledWith(7);
  });

  it('logs (but does not throw or reply) when claude.open unexpectedly rejects', async () => {
    const { socket, sendControl } = makeSocket();
    const log = vi.fn();
    const claude = makeClaude();
    (claude.open as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('claude crashed'));
    const dispatch = createDispatcher({ handlers: makeHandlers(), pty: makePty(), claude, tcp: makeTcp(), log });

    dispatch(
      {
        type: 'open',
        ch: 2,
        kind: 'claude',
        params: { session_id: 'a', resume: true, config_dir: '/home/u/.claude', mcp_url: 'https://termhub.dev/mcp', token: 't' },
      },
      socket,
    );
    await flush();

    expect(log).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ ch: 2 }));
    expect(sendControl).not.toHaveBeenCalled();
  });

  it('routes open kind: tcp to the tcp manager', () => {
    const { socket } = makeSocket();
    const tcp = makeTcp();
    const dispatch = createDispatcher({ handlers: makeHandlers(), pty: makePty(), claude: makeClaude(), tcp, log: vi.fn() });
    dispatch({ type: 'open', ch: 9, kind: 'tcp', params: { port: 8137 } }, socket);
    expect(tcp.open).toHaveBeenCalledWith(9, { port: 8137 }, socket);
  });
  it('close reaches the tcp manager too', () => {
    const { socket } = makeSocket();
    const tcp = makeTcp();
    const dispatch = createDispatcher({ handlers: makeHandlers(), pty: makePty(), claude: makeClaude(), tcp, log: vi.fn() });
    dispatch({ type: 'close', ch: 9 }, socket);
    expect(tcp.close).toHaveBeenCalledWith(9);
  });
});
