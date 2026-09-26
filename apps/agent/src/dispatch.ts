import type { ClaudeOpenParams, PtyOpenParams, RpcMethod, ServerMessage, TcpOpenParams } from '@termhub/agent-protocol';
import { RPC } from '@termhub/agent-protocol';
import type { AgentSocket } from './client.js';
import { RpcFailure } from './exec.js';
import type { Handlers } from './rpc/index.js';

/**
 * PTY side of the dispatcher — implemented by Task 12 (`src/pty.ts`) and injected here so
 * dispatch logic can be unit-tested without a real pseudo-terminal. `open` errors are reported
 * to the server by the manager itself (an `open_error` control message), not by the dispatcher.
 */
export interface PtyManager {
  open(ch: number, params: PtyOpenParams, socket: AgentSocket): Promise<void>;
  write(ch: number, data: Buffer): void;
  resize(ch: number, cols: number, rows: number): void;
  close(ch: number): void;
  closeAll(): void;
}

/**
 * The other channel kind (`src/claude/run.ts`): a headless Claude run whose stdout streams back on
 * the channel. Same shape as `PtyManager` so this dispatcher only routes by kind; like the PTY one,
 * it reports its own failures to the server (`open_error`, or `closed` with a reason).
 */
export interface ClaudeManager {
  open(ch: number, params: ClaudeOpenParams, socket: AgentSocket): Promise<void>;
  /** The prompt (a one-shot run) or the next lines of input (a streamed run), as channel data.
   *  `false` when `ch` is not one of its channels, so the caller can route the frame to the PTY
   *  manager instead. */
  write(ch: number, data: Buffer): boolean;
  close(ch: number): void;
  closeAll(): void;
}

/** Raw TCP pipes to the WDA ports (`src/tcp.ts`). Same contract as the Claude manager: `write` says
 *  whether the channel is its own, and it reports its own open/close outcomes to the server. */
export interface TcpManager {
  open(ch: number, params: TcpOpenParams, socket: AgentSocket): Promise<void>;
  write(ch: number, data: Buffer): boolean;
  close(ch: number): void;
  closeAll(): void;
}

export interface DispatcherDeps {
  handlers: Handlers;
  pty: PtyManager;
  claude: ClaudeManager;
  tcp: TcpManager;
  log: (msg: string, meta?: object) => void;
}

type RpcServerMessage = Extract<ServerMessage, { type: 'rpc' }>;

async function handleRpc(msg: RpcServerMessage, socket: AgentSocket, handlers: Handlers, log: DispatcherDeps['log']): Promise<void> {
  const method = msg.method as RpcMethod;
  const def = RPC[method];
  const handler = handlers[method];
  // Unreachable in practice: `method` was already validated against the RPC catalog by
  // serverMessage.safeParse() in client.ts before this ever runs. Kept as a defensive fallback.
  if (!def || !handler) {
    socket.sendControl({ type: 'rpc_result', id: msg.id, ok: false, error: { code: 'invalid', message: 'unknown method' } });
    return;
  }

  const parsedParams = def.params.safeParse(msg.params);
  if (!parsedParams.success) {
    socket.sendControl({ type: 'rpc_result', id: msg.id, ok: false, error: { code: 'invalid', message: 'invalid params' } });
    return;
  }

  let result: unknown;
  try {
    // The runtime call is keyed by the same `method` that picked both `def` and `handler`, so
    // params and handler always agree — TS just can't see that through the mapped type.
    result = await (handler as (params: unknown) => Promise<unknown>)(parsedParams.data);
  } catch (err) {
    if (err instanceof RpcFailure) {
      socket.sendControl({ type: 'rpc_result', id: msg.id, ok: false, error: { code: err.code, message: err.message, path: err.path } });
    } else {
      // Never log params (may contain a machine path or a credential's config dir) — method
      // name only, plus the stack for debugging.
      log('rpc handler failed', { method, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
      socket.sendControl({ type: 'rpc_result', id: msg.id, ok: false, error: { code: 'internal', message: 'internal error' } });
    }
    return;
  }

  const parsedResult = def.result.safeParse(result);
  if (!parsedResult.success) {
    log('rpc handler returned an invalid result', { method, issues: parsedResult.error.issues.length });
    socket.sendControl({ type: 'rpc_result', id: msg.id, ok: false, error: { code: 'internal', message: 'internal error' } });
    return;
  }

  socket.sendControl({ type: 'rpc_result', id: msg.id, ok: true, result: parsedResult.data });
}

/** Routes a validated server control message to its named RPC handler, or to the channel manager
 *  the message's kind belongs to (a terminal, or a headless Claude run). */
export function createDispatcher(deps: DispatcherDeps): (msg: ServerMessage, socket: AgentSocket) => void {
  return (msg, socket) => {
    switch (msg.type) {
      case 'rpc':
        void handleRpc(msg, socket, deps.handlers, deps.log);
        break;
      case 'open': {
        // The kind is the only thing this dispatcher knows about any of the three channels. Errors
        // are reported to the server by the manager itself (open_error / closed); this catch only
        // guards against an unexpected rejection leaking as an unhandled promise.
        const opened =
          msg.kind === 'claude' ? deps.claude.open(msg.ch, msg.params, socket)
          : msg.kind === 'tcp' ? deps.tcp.open(msg.ch, msg.params, socket)
          : deps.pty.open(msg.ch, msg.params, socket);
        opened.catch((err) => {
          deps.log(`${msg.kind}.open rejected unexpectedly`, { ch: msg.ch, error: err instanceof Error ? err.message : String(err) });
        });
        break;
      }
      case 'resize':
        // Only a terminal has a size: a `claude` channel is never resized.
        deps.pty.resize(msg.ch, msg.cols, msg.rows);
        break;
      case 'close':
        // `close` carries no kind. The server numbers channels globally, so at most one manager owns
        // this one and the others ignore a channel they never opened.
        deps.pty.close(msg.ch);
        deps.claude.close(msg.ch);
        deps.tcp.close(msg.ch);
        break;
    }
  };
}
