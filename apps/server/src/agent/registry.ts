import { EventEmitter } from 'node:events';
import {
  CLOSE,
  type ClaudeOpenParams,
  type PtyOpenParams,
  type RpcMethod,
  type RpcParams,
  type RpcResult,
  type TcpOpenParams,
} from '@termhub/agent-protocol';
import type { AgentChannel, AgentConnection, AgentPtyChannel, ChannelHandlers, PtyHandlers } from './connection.js';
import type { Machine } from '../db/repositories/types.js';

export class AgentOfflineError extends Error {}

/** An agent offline here but seen this recently is moving between instances (deploy, reconnect): worth a short wait. */
export const MOVING_WINDOW_MS = 150_000;
/** How long a caller waits for a moving agent before answering "offline". */
export const MOVING_WAIT_MS = 15_000;

export interface AgentInfo {
  agent_version: string;
  os: 'macos' | 'linux';
  tools: string[];
  connected_at: string;
}

/**
 * Process-wide map from machine id to its live AgentConnection.
 * Later tasks (RPC routes, terminal wiring) go through the `agents` singleton
 * instead of holding connections themselves.
 */
export class AgentRegistry extends EventEmitter {
  private readonly conns = new Map<string, AgentConnection>();
  /** Machines whose agent this process has held at some point: when one of them is offline here, it left from here. */
  private readonly held = new Set<string>();

  constructor() {
    super();
    // Many terminals may be waiting on the same or different machines during a deploy drain.
    this.setMaxListeners(0);
  }

  attach(machineId: string, conn: AgentConnection): void {
    const existing = this.conns.get(machineId);
    if (existing) {
      existing.close(CLOSE.CONFLICT, 'replaced');
    }
    this.conns.set(machineId, conn);
    this.held.add(machineId);
    conn.on('close', () => {
      if (this.conns.get(machineId) === conn) {
        this.conns.delete(machineId);
        this.emit('offline', machineId);
      }
    });
    this.emit('online', machineId, conn.hello);
  }

  isOnline(machineId: string): boolean {
    return this.conns.has(machineId);
  }

  info(machineId: string): AgentInfo | null {
    const conn = this.conns.get(machineId);
    if (!conn || !conn.hello) return null;
    return {
      agent_version: conn.hello.agent_version,
      os: conn.hello.os,
      tools: conn.hello.tools,
      connected_at: new Date(conn.connectedAt).toISOString(),
    };
  }

  /** How many agents are connected to this process (the npm version poll is skipped at 0). */
  connectedCount(): number {
    return this.conns.size;
  }

  openChannels(machineId: string): number {
    return this.conns.get(machineId)?.openChannels ?? 0;
  }

  rpc<M extends RpcMethod>(machineId: string, method: M, params: RpcParams<M>, timeoutMs?: number): Promise<RpcResult<M>> {
    const conn = this.conns.get(machineId);
    if (!conn) {
      return Promise.reject(new AgentOfflineError(`agent offline: ${machineId}`));
    }
    return conn.rpc(method, params, timeoutMs);
  }

  openPty(machineId: string, params: PtyOpenParams, handlers: PtyHandlers): Promise<AgentPtyChannel> {
    const conn = this.conns.get(machineId);
    if (!conn) {
      return Promise.reject(new AgentOfflineError(`agent offline: ${machineId}`));
    }
    return conn.openPty(params, handlers);
  }

  /** A headless Claude run on that machine (the chat's `agentRunner`). */
  openClaude(machineId: string, params: ClaudeOpenParams, handlers: ChannelHandlers): Promise<AgentChannel> {
    const conn = this.conns.get(machineId);
    if (!conn) {
      return Promise.reject(new AgentOfflineError(`agent offline: ${machineId}`));
    }
    return conn.openClaude(params, handlers);
  }

  /** A tcp pipe to a WDA port on that machine (the simulator's agent tunnel). */
  openTcp(machineId: string, params: TcpOpenParams, handlers: ChannelHandlers): Promise<AgentChannel> {
    const conn = this.conns.get(machineId);
    if (!conn) {
      return Promise.reject(new AgentOfflineError(`agent offline: ${machineId}`));
    }
    return conn.openTcp(params, handlers);
  }

  /**
   * What the machine's agent said it understands beyond a terminal, or `null` when there is nobody to
   * ask: not connected, or connected but still before `hello` — the same thing to a caller that needs
   * the answer now. An agent from before the field existed reports `[]`, so "understands nothing
   * extra" and "too old to know" read alike, which is exactly what they are.
   */
  capabilities(machineId: string): string[] | null {
    return this.conns.get(machineId)?.hello?.capabilities ?? null;
  }

  disconnect(machineId: string, code: number, reason?: string): void {
    const conn = this.conns.get(machineId);
    if (!conn) return;
    conn.close(code, reason);
  }

  /** Test-only: clears the map without closing connections. */
  reset(): void {
    this.conns.clear();
    this.held.clear();
  }

  /** Resolves true once `machineId` is attached (at once if it already is), false after `timeoutMs`. */
  waitOnline(machineId: string, timeoutMs: number): Promise<boolean> {
    if (this.conns.has(machineId)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const onOnline = (id: string) => {
        if (id !== machineId) return;
        clearTimeout(timer);
        this.off('online', onOnline);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.off('online', onOnline);
        resolve(false);
      }, timeoutMs);
      this.on('online', onOnline);
    });
  }

  /**
   * Whether the machine's agent can be used now, waiting a little for one that is moving: offline here but seen
   * moments ago, which is what a blue/green switch or a quick reconnect looks like (spec 2026-09-27 §5.3). A machine
   * long gone answers false at once. Non-agent machines have nothing to wait for.
   */
  async awaitAgent(machine: Pick<Machine, 'id' | 'type' | 'agent_last_seen_at'>, opts: { now?: number; timeoutMs?: number } = {}): Promise<boolean> {
    if (machine.type !== 'agent') return true;
    if (this.conns.has(machine.id)) return true;
    const seen = machine.agent_last_seen_at ? Date.parse(machine.agent_last_seen_at) : NaN;
    if (!Number.isFinite(seen) || (opts.now ?? Date.now()) - seen > MOVING_WINDOW_MS) return false;
    return this.waitOnline(machine.id, opts.timeoutMs ?? MOVING_WAIT_MS);
  }

  /**
   * `awaitAgent` for a read (a status, the chat's host, an inventory): waits only for an agent this process has never
   * held. That is a colour that just started: the agents seen moments ago are still on the other colour, or on their
   * way from it, and the browsers get here first (they reconnect in under a second, an agent in about two), so
   * answering "offline" would be wrong and would stay on screen until the next read. An agent that was here and
   * left is answered at once, so a read never stalls on a laptop that went to sleep.
   */
  async awaitHandover(machine: Pick<Machine, 'id' | 'type' | 'agent_last_seen_at'>, opts: { now?: number; timeoutMs?: number } = {}): Promise<boolean> {
    if (machine.type !== 'agent') return true;
    if (this.held.has(machine.id)) return this.conns.has(machine.id);
    return this.awaitAgent(machine, opts);
  }

  /** Closes every agent connection (the drain on shutdown); returns how many there were. */
  closeAll(code: number, reason: string): number {
    const all = [...this.conns.values()];
    for (const conn of all) conn.close(code, reason);
    return all.length;
  }
}

export const agents = new AgentRegistry();
