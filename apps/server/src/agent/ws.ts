import type { IncomingMessage } from 'node:http';
import { WebSocketServer } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import { CLOSE, MAX_FRAME, PROTOCOL_VERSION } from '@termhub/agent-protocol';
import type { Repositories } from '../db/repositories/index.js';
import { rejectUpgrade, type createUpgradeRouter } from '../ws/router.js';
import { AGENT_TOKEN_RE, hashAgentToken } from './token.js';
import { AgentConnection } from './connection.js';
import { agents, type AgentRegistry } from './registry.js';

const HEARTBEAT_INTERVAL_MS = 20_000;
const TOUCH_INTERVAL_MS = 60_000;

interface Deps {
  repos: Repositories;
  log: FastifyBaseLogger;
  registry?: AgentRegistry;
  helloTimeoutMs?: number;
}

/** Upgrades `/agent/ws`: agents authenticate with `Authorization: Bearer thb_ag_…`, not a cookie. */
export function registerAgentWs(router: ReturnType<typeof createUpgradeRouter>, deps: Deps): WebSocketServer {
  const registry = deps.registry ?? agents;
  // Agent → server frames are pty output and small JSON control messages: 1 MiB is plenty.
  // Only server → agent `file.paste` is large (MAX_PASTE_FRAME), and that bound is the agent's.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
  const log = deps.log.child({ mod: 'agent-ws' });

  router.addPublic(/^\/agent\/ws\/?$/, async ({ req, socket, head }) => {
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    // A refused upgrade is the only trace an agent with a stale/revoked token leaves, so log
    // it (never the token itself); `ip` is the client as seen through the proxy chain.
    const refuse = (reason: 'malformed-token' | 'unknown-token') => {
      log.warn({ ip: clientIp(req), reason }, 'agent upgrade rejected');
      rejectUpgrade(socket, 401, 'Unauthorized');
    };
    if (!AGENT_TOKEN_RE.test(token)) return refuse('malformed-token');
    const machine = await deps.repos.machines.findByAgentTokenHash(hashAgentToken(token));
    if (!machine) return refuse('unknown-token');

    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = new AgentConnection(ws, { machineId: machine.id, log });
      conn.waitHello(deps.helloTimeoutMs).then(
        async (hello) => {
          if (hello.protocol > PROTOCOL_VERSION) return conn.close(CLOSE.CONFLICT, 'protocol');
          if (hello.probe === true) {
            // `termhub-agent status`/`doctor`: token and protocol already checked out, answer
            // and hang up without attaching — attaching would replace (4409) the live session
            // the service is running on the same machine.
            log.info({ machineId: machine.id, agentVersion: hello.agent_version }, 'agent probe ok');
            return conn.close(1000, 'probe-ok');
          }
          registry.attach(machine.id, conn);

          // Register the close listener before the first `await`: if the agent disconnects
          // while `touch()` below is in flight, `closed` catches it so the intervals are never
          // created — otherwise they'd run forever on a dead connection (this listener would
          // never fire to clear them, since it wouldn't exist yet when 'close' fired).
          let closed = false;
          let seen: ReturnType<typeof setInterval> | undefined;
          let beat: ReturnType<typeof setInterval> | undefined;
          const attachedAt = Date.now();
          conn.on('close', (code: number, reason: string) => {
            closed = true;
            if (seen) clearInterval(seen);
            if (beat) clearInterval(beat);
            // 1006 with no reason = the TCP path died (or our heartbeat gave up on it); a code the
            // agent chose (1000/1001…) means it hung up on purpose. Together with `connectedMs`
            // this tells a crash-loop apart from an idle path that silently rotted.
            log.info({ machineId: machine.id, code, reason, connectedMs: Date.now() - attachedAt }, 'agent disconnected');
          });

          const touch = (extra: { version?: string; os?: string; capabilities?: string[] } = {}) =>
            deps.repos.machines
              .touchAgent(machine.id, { lastSeenAt: new Date(), ...extra })
              .catch((err) => log.warn({ err, machineId: machine.id }, 'touchAgent failed'));

          await touch({ version: hello.agent_version, os: hello.os, capabilities: hello.tools });
          if (closed) return;

          seen = setInterval(() => void touch(), TOUCH_INTERVAL_MS);
          seen.unref();
          beat = setInterval(() => conn.heartbeat(), HEARTBEAT_INTERVAL_MS);
          beat.unref();

          log.info({ machineId: machine.id, agentVersion: hello.agent_version, os: hello.os }, 'agent connected');
        },
        () => {
          // AgentConnection.waitHello() already closed the socket (1008) on timeout/violation.
          log.info({ machineId: machine.id }, 'agent disconnected before hello');
        },
      );
    });
  });

  return wss;
}

/** Client address for log lines: the real IP forwarded by nginx/Cloudflare, else the socket peer. */
function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-real-ip'] ?? req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return first?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
}
