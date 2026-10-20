import { EventEmitter } from 'node:events';
import {
  CLOSE,
  CONTROL_CHANNEL,
  MAX_CHANNELS,
  RPC,
  agentMessage,
  decodeFrame,
  encodeFrame,
  type AgentMessage,
  type ClaudeOpenParams,
  type HandshakeMessage,
  type HelloMessage,
  type RpcError,
  type RpcMethod,
  type RpcParams,
  type RpcResult,
  type PtyOpenParams,
  type ServerMessage,
  type TcpOpenParams,
} from '@termhub/agent-protocol';

export interface SocketLike extends EventEmitter {
  send(data: Buffer, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  readyState: number;
}

/** The protocol's closed set of end-of-run reasons, read off the message type so this file cannot
 *  drift from it. A terminal never carries one; a headless Claude run does. */
export type ChannelClosedReason = NonNullable<Extract<AgentMessage, { type: 'closed' }>['reason']>;

export interface ChannelHandlers {
  onData(data: Buffer): void;
  /**
   * The channel ended. `code` is the process's exit code, `null` when there was none (a signal, or
   * the connection itself going away). `reason` is present only when the agent named one: it is the
   * difference between "the run failed" and "this machine has no `claude` installed", and dropping
   * it here would make that distinction unreachable for everyone above.
   */
  onExit(code: number | null, reason?: ChannelClosedReason): void;
}

/** The terminal side's name for the same pair of callbacks; a pty close never names a reason. */
export type PtyHandlers = ChannelHandlers;

export interface AgentChannel {
  readonly ch: number;
  write(data: Buffer | string): void;
  close(): void;
}

export interface AgentPtyChannel extends AgentChannel {
  resize(cols: number, rows: number): void;
}

export type LoggerLike = {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  debug?(obj: object, msg?: string): void;
};

export class AgentTimeoutError extends Error {}

export class AgentRpcError extends Error {
  constructor(public readonly rpcError: RpcError) {
    super(rpcError.message);
  }
}

export class AgentClosedError extends Error {}

/**
 * Every channel number this machine has is taken (`MAX_CHANNELS`). Its own class because it is the one
 * open failure that says nothing about the machine: it is connected, healthy and simply full of
 * terminals, so a caller must be able to tell it from a machine that went away — the chat does, and
 * says "the run could not start" instead of "your machine saiu do ar".
 */
export class ChannelLimitError extends Error {}

const HELLO_TIMEOUT_MS = 5_000;
const OPEN_TIMEOUT_MS = 10_000;

interface PendingRpc {
  method: RpcMethod;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
  resolve(result: unknown): void;
  reject(err: Error): void;
}

interface ChannelEntry {
  handlers: ChannelHandlers;
  open: { resolve(ch: AgentPtyChannel): void; reject(err: Error): void } | null;
  openTimer: ReturnType<typeof setTimeout> | null;
  /** Set when our local open timeout fired first: the number stays reserved (tombstoned)
   *  until the agent acknowledges with `closed`/`open_error`, so it can't be handed to a
   *  new openPty() while a stale `opened` for this attempt might still be in flight. */
  timedOut: boolean;
  /** Set by channel.close(): we told the agent to close this pty and are waiting for its
   *  `closed` ack. Until then the number stays reserved and any stream frame the agent still
   *  emits for it (tmux's "[lost tty]", resets, in-flight output) is dropped silently — it is
   *  the expected tail of a close handshake, not a protocol violation. */
  closing: boolean;
}

export class AgentConnection extends EventEmitter {
  readonly machineId: string;
  readonly connectedAt: number;
  hello: HelloMessage | null = null;

  private readonly socket: SocketLike;
  private readonly log: LoggerLike;
  private readonly now: () => number;

  private helloWaiters: { resolve(h: HelloMessage): void; reject(err: Error): void }[] = [];
  private helloTimer: ReturnType<typeof setTimeout> | null = null;

  private seq = 0;
  private readonly pending = new Map<string, PendingRpc>();
  private readonly channels = new Map<number, ChannelEntry>();

  private alive = true;
  /** True as soon as a close has been initiated locally (close()/violation()) or the
   *  socket's 'close' event has fired — gates new rpc()/openPty() calls and incoming
   *  frame processing immediately, without waiting for the (possibly async) 'close' event. */
  private closing = false;
  /** True once onClose()'s cleanup has fully run; guards that cleanup from running twice. */
  private closed = false;

  constructor(socket: SocketLike, opts: { machineId: string; log: LoggerLike; now?: () => number }) {
    super();
    this.socket = socket;
    this.machineId = opts.machineId;
    this.log = opts.log;
    this.now = opts.now ?? Date.now;
    this.connectedAt = this.now();

    this.socket.on('message', (data: Buffer) => this.onMessage(data));
    this.socket.on('close', (code: number, reason: Buffer) => this.onClose(code, reason?.toString() ?? ''));
    this.socket.on('pong', () => (this.alive = true));
    this.socket.on('error', (err: Error) => this.log.error({ machineId: this.machineId, err: err.message }, 'agent socket error'));
  }

  waitHello(timeoutMs = HELLO_TIMEOUT_MS): Promise<HelloMessage> {
    if (this.hello) return Promise.resolve(this.hello);
    return new Promise((resolve, reject) => {
      this.helloWaiters.push({ resolve, reject });
      if (!this.helloTimer) {
        this.helloTimer = setTimeout(() => {
          this.violation('hello timeout');
        }, timeoutMs);
      }
    });
  }

  rpc<M extends RpcMethod>(method: M, params: RpcParams<M>, timeoutMs?: number): Promise<RpcResult<M>> {
    if (this.closing) {
      return Promise.reject(new AgentClosedError('agent connection closed'));
    }
    // Validate before anything hits the wire: the agent would answer `invalid` anyway, but a
    // round trip for a request we can already see is malformed is wasted, and a synchronous
    // rejection keeps the failure next to the caller that built the params.
    const checked = RPC[method].params.safeParse(params);
    if (!checked.success) {
      this.log.warn({ machineId: this.machineId, method, issues: checked.error.issues.length }, 'agent rpc params rejected before send');
      return Promise.reject(new AgentRpcError({ code: 'invalid', message: 'invalid rpc params' }));
    }
    const id = `r${++this.seq}`;
    const effectiveTimeout = timeoutMs ?? RPC[method].timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AgentTimeoutError(`agent rpc timeout: ${method}`));
      }, effectiveTimeout);
      this.pending.set(id, {
        method,
        startedAt: this.now(),
        timer,
        resolve: resolve as (result: unknown) => void,
        reject,
      });
      this.sendControl({ type: 'rpc', id, method, params });
    });
  }

  openPty(params: PtyOpenParams, handlers: PtyHandlers): Promise<AgentPtyChannel> {
    return this.openChannel(handlers, (ch) => ({ type: 'open', ch, kind: 'pty', params }));
  }

  /** A headless Claude run on this machine (`apps/agent/src/claude/run.ts`): same open/close
   *  handshake as a terminal, and the prompt goes in as channel data once it is open. */
  openClaude(params: ClaudeOpenParams, handlers: ChannelHandlers): Promise<AgentChannel> {
    return this.openChannel(handlers, (ch) => ({ type: 'open', ch, kind: 'claude', params }));
  }

  /** A raw TCP pipe to a loopback WDA port on the machine (`apps/agent/src/tcp.ts`). Same handshake as
   *  the other kinds; bytes flow both ways once it is open. */
  openTcp(params: TcpOpenParams, handlers: ChannelHandlers): Promise<AgentChannel> {
    return this.openChannel(handlers, (ch) => ({ type: 'open', ch, kind: 'tcp', params }));
  }

  /** The open handshake every channel kind shares — the reserved number, the local timeout and its
   *  tombstone — with only the `open` message itself left to the kind. */
  private openChannel(handlers: ChannelHandlers, openMessage: (ch: number) => ServerMessage): Promise<AgentPtyChannel> {
    if (this.closing) {
      return Promise.reject(new AgentClosedError('agent connection closed'));
    }
    if (this.channels.size >= MAX_CHANNELS) {
      return Promise.reject(new ChannelLimitError('too many channels'));
    }
    const ch = this.nextChannel();
    return new Promise((resolve, reject) => {
      const entry: ChannelEntry = { handlers, open: null, openTimer: null, timedOut: false, closing: false };
      const timer = setTimeout(() => {
        // We gave up locally, but the agent may still reply to the original 'open' — keep
        // the channel number reserved (tombstoned) and tell the agent to close it, instead
        // of freeing the number for a late 'opened'/'open_error' to land on a new request.
        entry.timedOut = true;
        entry.open = null;
        entry.openTimer = null;
        this.sendControl({ type: 'close', ch });
        reject(new AgentTimeoutError(`agent open timeout: ch ${ch}`));
      }, OPEN_TIMEOUT_MS);
      entry.openTimer = timer;
      entry.open = {
        resolve: (channel: AgentPtyChannel) => {
          clearTimeout(timer);
          entry.open = null;
          entry.openTimer = null;
          resolve(channel);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          this.channels.delete(ch);
          reject(err);
        },
      };
      this.channels.set(ch, entry);
      this.sendControl(openMessage(ch));
    });
  }

  /** The hooks and MCP addresses, sent to a `probe` hello right before `probe-ok` (TER-586). */
  sendProbeInfo(info: { hooks_url: string; mcp_url: string | null }): void {
    this.sendControl({ type: 'probe_info', ...info });
  }

  close(code: number, reason?: string): void {
    this.closing = true;
    this.socket.close(code, reason);
  }

  /**
   * Open channels of every kind — a terminal, and since the user-hosted concierge a headless Claude
   * run as well. 0 is what the auto-update scheduler reads as "idle" (`agent/latest-version.ts`), and
   * a chat counts as busy on purpose: installing a new agent restarts it, which kills a run in
   * progress just as surely as it kills a terminal — the user would watch their answer stop
   * mid-sentence for a reason nothing on the screen could explain.
   */
  get openChannels(): number {
    return this.channels.size;
  }

  heartbeat(): void {
    if (!this.alive) {
      this.socket.terminate();
      return;
    }
    this.alive = false;
    this.socket.ping();
  }

  // --- internals ---

  private nextChannel(): number {
    for (let ch = 1; ch <= MAX_CHANNELS; ch++) {
      if (!this.channels.has(ch)) return ch;
    }
    throw new ChannelLimitError('too many channels');
  }

  /** A handshake message (`challenge`, `paired`), sent before any session attaches. See `@termhub/agent-protocol` auth.ts. */
  sendHandshake(msg: HandshakeMessage): void {
    if (this.closing) return;
    this.socket.send(encodeFrame(CONTROL_CHANNEL, JSON.stringify(msg)));
  }

  private sendControl(msg: ServerMessage): void {
    this.socket.send(encodeFrame(CONTROL_CHANNEL, JSON.stringify(msg)));
  }

  private violation(reason: string): void {
    this.closing = true;
    this.log.warn({ machineId: this.machineId, reason }, 'agent protocol violation');
    for (const w of this.helloWaiters) w.reject(new Error(`protocol violation: ${reason}`));
    this.helloWaiters = [];
    if (this.helloTimer) {
      clearTimeout(this.helloTimer);
      this.helloTimer = null;
    }
    this.socket.close(CLOSE.VIOLATION, reason);
  }

  private onMessage(data: Buffer): void {
    if (this.closing) return;
    let frame: { ch: number; payload: Buffer };
    try {
      frame = decodeFrame(data);
    } catch {
      this.violation('malformed frame');
      return;
    }

    if (frame.ch === CONTROL_CHANNEL) {
      this.onControl(frame.payload);
      return;
    }

    if (!this.hello) {
      this.violation('stream frame before hello');
      return;
    }

    const entry = this.channels.get(frame.ch);
    if (!entry) {
      this.violation(`unknown channel ${frame.ch}`);
      return;
    }
    if (entry.closing || entry.timedOut) {
      // Tail of a close handshake (or of an open we gave up on): the agent hasn't acked yet
      // and may still flush output. Never log the bytes — metadata only.
      this.log.debug?.({ machineId: this.machineId, ch: frame.ch, bytes: frame.payload.length }, 'stream frame for a closing channel dropped');
      return;
    }
    entry.handlers.onData(frame.payload);
  }

  private onControl(payload: Buffer): void {
    let json: unknown;
    try {
      json = JSON.parse(payload.toString('utf8'));
    } catch {
      this.violation('malformed control json');
      return;
    }
    const parsed = agentMessage.safeParse(json);
    if (!parsed.success) {
      this.violation('invalid control message');
      return;
    }
    const msg = parsed.data;

    if (!this.hello) {
      if (msg.type !== 'hello') {
        this.violation('expected hello');
        return;
      }
      this.hello = msg;
      if (this.helloTimer) {
        clearTimeout(this.helloTimer);
        this.helloTimer = null;
      }
      const waiters = this.helloWaiters;
      this.helloWaiters = [];
      for (const w of waiters) w.resolve(msg);
      return;
    }

    switch (msg.type) {
      case 'hello':
        // Ignore a repeated hello after the handshake; not a violation.
        return;
      case 'rpc_result':
        this.onRpcResult(msg);
        return;
      case 'opened':
        this.onOpened(msg.ch);
        return;
      case 'open_error':
        this.onOpenError(msg.ch, msg.error);
        return;
      case 'closed':
        this.onChannelClosed(msg.ch, msg.code, msg.reason);
        return;
    }
  }

  private onRpcResult(msg: { id: string; ok: boolean; result?: unknown; error?: RpcError }): void {
    const entry = this.pending.get(msg.id);
    if (!entry) {
      this.log.debug?.({ machineId: this.machineId, id: msg.id }, 'rpc result for unknown id');
      return;
    }
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    const ms = this.now() - entry.startedAt;

    if (msg.ok) {
      const resultSchema = RPC[entry.method].result;
      const validated = resultSchema.safeParse(msg.result);
      if (!validated.success) {
        entry.reject(new Error(`invalid rpc result for ${entry.method}`));
        return;
      }
      this.log.info({ machineId: this.machineId, method: entry.method, ms }, 'agent rpc completed');
      entry.resolve(validated.data);
      return;
    }

    if (!msg.error) {
      // The pending entry is already removed from `this.pending`, so onClose()'s cleanup
      // loop can no longer find it — reject it here or the original caller's promise would
      // never settle.
      entry.reject(new Error(`protocol violation: rpc_result not ok without error for ${entry.method}`));
      this.violation('rpc_result not ok without error');
      return;
    }
    this.log.info({ machineId: this.machineId, method: entry.method, ms, ok: false }, 'agent rpc completed');
    entry.reject(new AgentRpcError(msg.error));
  }

  private onOpened(ch: number): void {
    const entry = this.channels.get(ch);
    if (!entry) {
      this.violation(`opened for unknown channel ${ch}`);
      return;
    }
    if (entry.timedOut) {
      // Late reply to a request we already gave up on locally: tell the agent (again) to
      // close it and ignore — not a violation, the agent just raced our local timeout.
      this.sendControl({ type: 'close', ch });
      return;
    }
    if (entry.closing) {
      // Can't happen for a well-behaved agent (we only close channels that already opened),
      // but a stray `opened` while we wait for the ack is harmless: drop it.
      this.log.debug?.({ machineId: this.machineId, ch }, 'opened for a closing channel ignored');
      return;
    }
    if (!entry.open) {
      this.violation(`opened for unknown channel ${ch}`);
      return;
    }
    const channel = this.buildChannel(ch);
    entry.open.resolve(channel);
  }

  private onOpenError(ch: number, error: RpcError): void {
    const entry = this.channels.get(ch);
    if (!entry) {
      this.violation(`open_error for unknown channel ${ch}`);
      return;
    }
    if (entry.timedOut || entry.closing) {
      // The agent acknowledged the close we sent (after our local timeout, or from
      // channel.close()): free the number. Nothing to notify — the caller already moved on.
      this.channels.delete(ch);
      return;
    }
    if (!entry.open) {
      this.violation(`open_error for unknown channel ${ch}`);
      return;
    }
    entry.open.reject(new AgentRpcError(error));
  }

  private onChannelClosed(ch: number, code: number | null, reason?: ChannelClosedReason): void {
    const entry = this.channels.get(ch);
    if (!entry) {
      this.violation(`closed for unknown channel ${ch}`);
      return;
    }
    if (entry.timedOut || entry.closing) {
      // The agent acknowledged the close we sent (after our local timeout, or from
      // channel.close()): free the number. A locally closed channel never reports an exit —
      // its owner asked for the close and has already let go of the session.
      this.channels.delete(ch);
      return;
    }
    if (entry.open) {
      // The agent closed the pty before ever confirming it opened: settle the openPty()
      // promise as a failure, never as an exit — the caller never got a channel object.
      if (entry.openTimer) clearTimeout(entry.openTimer);
      this.channels.delete(ch);
      entry.open.reject(new Error('pty closed before opened'));
      return;
    }
    this.channels.delete(ch);
    // Called with one argument when the agent named no reason, not with an explicit `undefined`:
    // every pty close arrives that way, and its owners read the exit as "the code, and nothing else".
    if (reason === undefined) entry.handlers.onExit(code);
    else entry.handlers.onExit(code, reason);
  }

  private buildChannel(ch: number): AgentPtyChannel {
    return {
      ch,
      write: (data: Buffer | string) => {
        this.socket.send(encodeFrame(ch, data));
      },
      resize: (cols: number, rows: number) => {
        this.sendControl({ type: 'resize', ch, cols, rows });
      },
      close: () => {
        const entry = this.channels.get(ch);
        // Already closed locally (double kill), acked by the agent, or the socket is gone.
        if (!entry || entry.closing) return;
        // Handshake: the entry stays in the map (like the timedOut tombstone) until the
        // agent acks with `closed`/`open_error`. Deleting it here would turn the output tmux
        // still flushes for this pty into an "unknown channel" violation that tears down the
        // whole connection — every other tab on the machine with it.
        entry.closing = true;
        this.sendControl({ type: 'close', ch });
      },
    };
  }

  private onClose(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closing = true;

    for (const w of this.helloWaiters) w.reject(new AgentClosedError('agent connection closed'));
    this.helloWaiters = [];
    if (this.helloTimer) {
      clearTimeout(this.helloTimer);
      this.helloTimer = null;
    }

    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new AgentClosedError('agent connection closed'));
    }
    this.pending.clear();

    for (const entry of this.channels.values()) {
      if (entry.openTimer) clearTimeout(entry.openTimer);
      if (entry.timedOut || entry.closing) {
        // Already settled locally (open timeout rejected the caller / channel.close() was
        // the caller's own doing); nothing to notify.
        continue;
      }
      if (entry.open) {
        entry.open.reject(new AgentClosedError('agent connection closed'));
      } else {
        entry.handlers.onExit(null);
      }
    }
    this.channels.clear();

    this.emit('close', code, reason);
  }
}
