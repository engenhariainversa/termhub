import type { IncomingMessage } from 'node:http';
import { WebSocketServer } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import { CLOSE, DEVICE_AUTH_SCHEME, MAX_FRAME, PROTOCOL_VERSION, type HelloMessage } from '@termhub/agent-protocol';
import type { Repositories } from '../db/repositories/index.js';
import { rejectUpgrade, type createUpgradeRouter } from '../ws/router.js';
import type { Machine } from '../db/repositories/types.js';
import { AGENT_TOKEN_RE, checkDeviceProof, hashAgentToken, newChallengeNonce, normalizeDevicePublicKey } from './token.js';
import { AgentConnection } from './connection.js';
import { agents, type AgentRegistry } from './registry.js';

const HEARTBEAT_INTERVAL_MS = 20_000;
const TOUCH_INTERVAL_MS = 60_000;

interface Deps {
  repos: Repositories;
  log: FastifyBaseLogger;
  registry?: AgentRegistry;
  helloTimeoutMs?: number;
  /** Sent to a `probe` hello before `probe-ok`, so `termhub-agent doctor` tests the other addresses the
   *  machine must reach: the monitor hooks and the tabs' MCP (TER-586). Absent: nothing is sent. */
  probeInfo?: { hooks_url: string; mcp_url: string | null };
}

/** Upgrades `/agent/ws`: agents authenticate with a device key or a `thb_ag_…` token (see `dial` below), not a cookie. */
export function registerAgentWs(router: ReturnType<typeof createUpgradeRouter>, deps: Deps): WebSocketServer {
  const registry = deps.registry ?? agents;
  // Agent → server frames are pty output and small JSON control messages: 1 MiB is plenty.
  // Only server → agent `file.paste` is large (MAX_PASTE_FRAME), and that bound is the agent's.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
  const log = deps.log.child({ mod: 'agent-ws' });

  router.addPublic(/^\/agent\/ws\/?$/, async ({ req, socket, head }) => {
    const auth = req.headers.authorization ?? '';
    // A refused upgrade is the only trace an agent with a stale/revoked credential leaves, so log
    // it (never the token itself); `ip` is the client as seen through the proxy chain.
    const refuse = (reason: 'malformed-token' | 'unknown-token' | 'malformed-device' | 'unknown-device') => {
      log.warn({ ip: clientIp(req), reason }, 'agent upgrade rejected');
      rejectUpgrade(socket, 401, 'Unauthorized');
    };

    // Which credential this dial carries (TER-1017, see `@termhub/agent-protocol` auth.ts): a device key,
    // a legacy bearer token, or a pairing token about to be traded for a device key.
    let dial: { kind: 'key'; machine: Machine; publicKey: string } | { kind: 'bearer'; machine: Machine } | { kind: 'pair'; machine: Machine; hash: string };
    if (auth.startsWith(`${DEVICE_AUTH_SCHEME} `)) {
      const id = auth.slice(DEVICE_AUTH_SCHEME.length + 1).trim();
      if (!MACHINE_ID_RE.test(id)) return refuse('malformed-device');
      const found = await deps.repos.machines.findDeviceKey(id);
      if (!found) return refuse('unknown-device');
      dial = { kind: 'key', ...found };
    } else {
      const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      if (!AGENT_TOKEN_RE.test(token)) return refuse('malformed-token');
      const hash = hashAgentToken(token);
      const legacy = await deps.repos.machines.findByAgentTokenHash(hash);
      if (legacy) dial = { kind: 'bearer', machine: legacy };
      else {
        const pairing = await deps.repos.machines.findByPairingHash(hash);
        if (!pairing) return refuse('unknown-token');
        dial = { kind: 'pair', machine: pairing, hash };
      }
    }
    const { machine } = dial;

    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = new AgentConnection(ws, { machineId: machine.id, log });
      const nonce = dial.kind === 'key' ? newChallengeNonce() : null;
      if (nonce) conn.sendHandshake({ type: 'challenge', nonce });
      conn.waitHello(deps.helloTimeoutMs).then(
        async (hello) => {
          if (hello.protocol > PROTOCOL_VERSION) return conn.close(CLOSE.CONFLICT, 'protocol');
          if (dial.kind === 'pair') return pair(conn, hello, dial.hash);
          if (dial.kind === 'key') {
            const check = checkDeviceProof({ publicKey: dial.publicKey, machineId: machine.id, nonce: nonce!, proof: hello.proof });
            if (!check.ok) {
              log.warn({ machineId: machine.id, ip: clientIp(req), reason: check.reason }, 'agent device proof rejected');
              return conn.close(CLOSE.UNAUTHORIZED, 'proof');
            }
          }
          if (hello.probe === true) {
            // `termhub-agent status`/`doctor`: credential and protocol already checked out, answer
            // and hang up without attaching — attaching would replace (4409) the live session
            // the service is running on the same machine.
            log.info({ machineId: machine.id, agentVersion: hello.agent_version, credential: dial.kind }, 'agent probe ok');
            // An agent older than 0.23.0 drops `probe_info` as an unknown message and reads the close as before.
            if (deps.probeInfo) conn.sendProbeInfo(deps.probeInfo);
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
          const touch = (extra: { version?: string; os?: string; capabilities?: string[] } = {}) =>
            deps.repos.machines
              .touchAgent(machine.id, { lastSeenAt: new Date(), ...extra })
              .catch((err) => log.warn({ err, machineId: machine.id }, 'touchAgent failed'));

          conn.on('close', (code: number, reason: string) => {
            closed = true;
            if (seen) clearInterval(seen);
            if (beat) clearInterval(beat);
            // 1006 with no reason = the TCP path died (or our heartbeat gave up on it); a code the
            // agent chose (1000/1001…) means it hung up on purpose. Together with `connectedMs`
            // this tells a crash-loop apart from an idle path that silently rotted.
            log.info({ machineId: machine.id, code, reason, connectedMs: Date.now() - attachedAt }, 'agent disconnected');
            // When it left, not only when it was last polled: the other colour reads this to tell an agent that is
            // moving over (a deploy) from one long gone (spec 2026-09-27 §5.3).
            void touch();
          });

          await touch({ version: hello.agent_version, os: hello.os, capabilities: hello.tools });
          if (closed) return;

          seen = setInterval(() => void touch(), TOUCH_INTERVAL_MS);
          seen.unref();
          beat = setInterval(() => conn.heartbeat(), HEARTBEAT_INTERVAL_MS);
          beat.unref();

          log.info({ machineId: machine.id, agentVersion: hello.agent_version, os: hello.os, credential: dial.kind }, 'agent connected');
        },
        () => {
          // AgentConnection.waitHello() already closed the socket (1008) on timeout/violation.
          log.info({ machineId: machine.id }, 'agent disconnected before hello');
        },
      );
    });
  });

  /**
   * A pairing dial: trade the single-use token for the device key in `hello.pair`, answer `paired` with
   * the machine and hang up — the agent dials again with the key. An agent from before TER-1017 sends no
   * key: it gets the same "update the agent" refusal as a protocol mismatch, and the token stays unused.
   */
  async function pair(conn: AgentConnection, hello: HelloMessage, hash: string): Promise<void> {
    const machineId = conn.machineId;
    if (!hello.pair) {
      log.warn({ machineId, agentVersion: hello.agent_version }, 'agent pairing refused: agent too old for a pairing token');
      return conn.close(CLOSE.CONFLICT, 'protocol');
    }
    const publicKey = normalizeDevicePublicKey(hello.pair.public_key);
    if (!publicKey) {
      log.warn({ machineId }, 'agent pairing refused: not an Ed25519 key');
      return conn.close(CLOSE.VIOLATION, 'pair-key');
    }
    const ok = await deps.repos.machines.completeAgentPairing(machineId, hash, publicKey).catch((err: unknown) => {
      log.error({ err, machineId }, 'agent pairing failed');
      return false;
    });
    if (!ok) {
      log.warn({ machineId }, 'agent pairing refused: token used, expired or rotated');
      return conn.close(CLOSE.UNAUTHORIZED, 'pairing');
    }
    log.info({ machineId, agentVersion: hello.agent_version }, 'agent paired');
    const machine = await deps.repos.machines.findById(machineId);
    conn.sendHandshake({ type: 'paired', machine_id: machineId, machine_name: machine?.name ?? '' });
    conn.close(1000, 'paired');
  }

  return wss;
}

/** Machine ids are `newId()` strings; anything else is refused before touching the database. */
const MACHINE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Client address for log lines: the real IP forwarded by nginx/Cloudflare, else the socket peer. */
function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-real-ip'] ?? req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return first?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
}
