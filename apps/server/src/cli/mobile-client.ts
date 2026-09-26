/**
 * A command-line phone for the mobile API (/api/m/v1, /ws/m/chat): it does what the app will do,
 * so the API can be exercised before any app exists. Usage:
 *   npm run mobile-client -w @termhub/server -- --email you@example.com [--server http://localhost:3000] [--public-url https://termhub.dev]
 * `--public-url` is the base the server has in MOBILE_PUBLIC_URL (every proof signs that exact URL);
 * it defaults to `--server`. State lives in ~/.cache/termhub/mobile-client.json (mode 0600).
 *
 * It prints ids and statuses only: never the access token, the PIN secret, a challenge or a proof.
 */
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { SignJWT, exportJWK, generateKeyPair, importJWK, type JWK, type KeyLike } from 'jose';
import WebSocket from 'ws';
import { canonicalHtu, decisionProofMessage, formatVerificationCode } from '@termhub/mobile-api';
import { pinProofFor } from '../mobile/codes.js';
import { describeError } from './mobile-client-errors.js';

const API = '/api/m/v1';
const APP_HEADER = 'ios/0.0.1+1';
const APP_VERSION = '0.0.1+1';

const { values } = parseArgs({
  options: {
    server: { type: 'string', default: 'http://localhost:3000' },
    'public-url': { type: 'string' },
    email: { type: 'string' },
    name: { type: 'string', default: 'termhub CLI' },
    state: { type: 'string', default: path.join(os.homedir(), '.cache', 'termhub', 'mobile-client.json') },
  },
});
const server = values.server!.replace(/\/$/, '');
const publicUrl = (values['public-url'] ?? server).replace(/\/$/, '');
const statePath = values.state!;

/** What survives between runs. `jwk` is the private key; `wrapped` is pin_secret XOR scrypt(PIN, salt). */
interface State {
  device_id: string;
  jwk: JWK;
  salt: string;
  wrapped: string;
}

// ---------- stdin: one line queue shared by the prompts and the REPL ----------

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
const lines: string[] = [];
const waiters: ((line: string | null) => void)[] = [];
let stdinClosed = false;
rl.on('line', (line) => {
  const w = waiters.shift();
  if (w) w(line);
  else lines.push(line);
});
rl.on('close', () => {
  stdinClosed = true;
  while (waiters.length) waiters.shift()!(null);
});

/** The next line typed, or null once stdin is closed. `hidden` stops the echo on a terminal. */
function nextLine(prompt: string, hidden = false, signal?: AbortSignal): Promise<string | null> {
  process.stdout.write(prompt);
  const io = rl as unknown as { _writeToOutput: (s: string) => void };
  const original = io._writeToOutput;
  if (hidden && process.stdin.isTTY) io._writeToOutput = () => {};
  const restore = (line: string | null) => {
    io._writeToOutput = original;
    if (hidden && process.stdin.isTTY) process.stdout.write('\n');
    return line;
  };
  const queued = lines.shift();
  if (queued !== undefined) return Promise.resolve(restore(queued));
  if (stdinClosed) return Promise.resolve(restore(null));
  return new Promise((resolve) => {
    const waiter = (line: string | null) => resolve(restore(line));
    waiters.push(waiter);
    // A cancelled wait gives its place back, so the line goes to the next prompt instead.
    signal?.addEventListener('abort', () => {
      const i = waiters.indexOf(waiter);
      if (i >= 0) waiters.splice(i, 1);
      resolve(restore(null));
    });
  });
}

async function askPin(prompt: string): Promise<string> {
  for (;;) {
    const pin = await nextLine(prompt, true);
    if (pin === null) throw new Error('stdin fechado');
    if (/^\d{6}$/.test(pin.trim())) return pin.trim();
    console.log('O PIN tem 6 dígitos.');
  }
}

// ---------- state ----------

function loadState(): State | null {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8')) as State;
  } catch {
    return null;
  }
}

function saveState(state: State): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by the umask and ignored for a directory that already exists.
  fs.chmodSync(path.dirname(statePath), 0o700);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.chmodSync(statePath, 0o600);
}

function deleteState(): void {
  fs.rmSync(statePath, { force: true });
}

// ---------- PIN wrapping: exactly what the app does (no tag, so any PIN unwraps to 32 bytes) ----------

const pinKey = (pin: string, salt: Buffer) => scryptSync(pin, salt, 32, { N: 16384, r: 8, p: 1 });
const xor = (a: Buffer, b: Buffer) => Buffer.from(a.map((byte, i) => byte ^ b[i]));

function wrapSecret(pinSecret: string, pin: string): { salt: string; wrapped: string } {
  const salt = randomBytes(16);
  return { salt: salt.toString('base64url'), wrapped: xor(Buffer.from(pinSecret, 'base64url'), pinKey(pin, salt)).toString('base64url') };
}

function unwrapSecret(state: State, pin: string): string {
  return xor(Buffer.from(state.wrapped, 'base64url'), pinKey(pin, Buffer.from(state.salt, 'base64url'))).toString('base64url');
}

// ---------- DPoP proofs ----------

let privateKey: KeyLike | Uint8Array;
let publicJwk: JWK;

async function loadKey(jwk: JWK): Promise<void> {
  privateKey = await importJWK(jwk, 'ES256');
  publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

async function proof(htm: string, pathAndQuery: string, opts: { token?: string; chal?: string } = {}): Promise<string> {
  const claims: Record<string, string> = { htm, htu: canonicalHtu(publicUrl, pathAndQuery), jti: randomBytes(16).toString('base64url') };
  if (opts.token) claims.ath = createHash('sha256').update(opts.token).digest('base64url');
  if (opts.chal) claims.chal = opts.chal;
  return new SignJWT(claims).setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: publicJwk }).setIssuedAt().sign(privateKey);
}

// ---------- HTTP ----------

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly body: Record<string, unknown>,
    readonly retryAfter: string | null,
  ) {
    super(
      describeError({
        status,
        code,
        message: typeof body.error === 'string' ? body.error : undefined,
        failures: typeof body.failures === 'number' ? body.failures : undefined,
        retryAfter,
      }),
    );
  }
}

let accessToken: string | null = null;
let state: State | null = null;

interface CallOpts {
  body?: unknown;
  /** 'device' = token + proof, 'proof' = proof alone, 'none' = no proof */
  auth?: 'device' | 'proof' | 'none';
  bearer?: string;
  chal?: string;
}

async function call<T = Record<string, unknown>>(method: string, apiPath: string, opts: CallOpts = {}): Promise<T> {
  const full = API + apiPath;
  const auth = opts.auth ?? 'device';
  const headers: Record<string, string> = { 'x-termhub-app': APP_HEADER, accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (auth === 'device') {
    if (!accessToken) throw new Error('sem token: rode "refresh" primeiro');
    headers.authorization = `Bearer ${accessToken}`;
    headers.dpop = await proof(method, full, { token: accessToken });
  } else if (auth === 'proof') {
    headers.dpop = await proof(method, full, { chal: opts.chal });
  }
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(server + full, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = {};
  }
  if (!res.ok) {
    const code = typeof json.code === 'string' ? json.code : undefined;
    if (res.status === 401 && code === 'DEVICE_REVOKED') {
      deleteState();
      accessToken = null;
      state = null;
      console.log(`Aparelho removido da conta (401 DEVICE_REVOKED): ${statePath} apagado. Rode de novo para cadastrar.`);
    }
    throw new ApiError(res.status, code, json, res.headers.get('retry-after'));
  }
  return json as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- enrolment ----------

async function enrol(): Promise<State> {
  const email = values.email ?? (await nextLine('E-mail da conta: '))?.trim();
  if (!email) throw new Error('informe --email');

  const { privateKey: key } = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(key);
  await loadKey(jwk);

  const req = await call<{ request_id: string; request_secret: string; verification_code: string; poll_after: number }>('POST', '/devices/requests', {
    auth: 'none',
    body: {
      email,
      public_key: publicJwk,
      device: { platform: 'ios', model: `CLI ${os.platform()}`, os_version: os.release().slice(0, 40), name: values.name },
      app_version: APP_VERSION,
    },
  });
  console.log(`Pedido ${req.request_id}. Código de verificação: ${formatVerificationCode(req.verification_code)}`);
  console.log('Aprove em Configurações → Aparelhos (confira o código). Aguardando...');

  for (;;) {
    await sleep(Math.max(1000, req.poll_after));
    const { status } = await call<{ status: string }>('GET', `/devices/requests/${req.request_id}`, { auth: 'none', bearer: req.request_secret });
    if (status === 'approved') break;
    if (status !== 'pending') throw new Error(`pedido ${status}`);
  }
  console.log('Aprovado.');

  let pin: string;
  for (;;) {
    pin = await askPin('Crie um PIN de 6 dígitos: ');
    if ((await askPin('Repita o PIN: ')) === pin) break;
    console.log('Os PINs não conferem.');
  }

  const act = await call<{ device_id: string; pin_secret: string; access_token: string }>('POST', '/devices/activate', {
    auth: 'proof',
    body: { request_id: req.request_id, request_secret: req.request_secret },
  });
  const next: State = { device_id: act.device_id, jwk, ...wrapSecret(act.pin_secret, pin) };
  saveState(next);
  accessToken = act.access_token;
  console.log(`Aparelho ${act.device_id} ativado; estado em ${statePath}.`);
  return next;
}

// ---------- commands ----------

async function refresh(s: State): Promise<void> {
  const secret = unwrapSecret(s, await askPin('PIN: '));
  const { challenge } = await call<{ challenge: string }>('POST', '/session/challenge', { auth: 'none', body: { device_id: s.device_id, purpose: 'refresh' } });
  const res = await call<{ access_token: string; expires_in: number }>('POST', '/session/token', {
    auth: 'proof',
    chal: challenge,
    body: { device_id: s.device_id, challenge, pin_proof: pinProofFor(secret, challenge) },
  });
  accessToken = res.access_token;
  console.log(`Token renovado (vale ${res.expires_in}s).`);
}

interface ChatView {
  conversation: { id: string };
  messages: { id: string; role: string; text: string; error_code: string | null }[];
  actions: { id: string; status: string; tool: string; summary?: string }[];
  host?: unknown;
}

async function showChat(): Promise<void> {
  const view = await call<ChatView>('GET', '/chat');
  console.log(`Conversa ${view.conversation.id}: ${view.messages.length} mensagens, ${view.actions.length} ações`);
  for (const m of view.messages.slice(-10)) console.log(`  [${m.role}] ${m.id}${m.error_code ? ` (${m.error_code})` : ''}: ${m.text.slice(0, 200)}`);
  for (const a of view.actions) console.log(`  ação ${a.id} ${a.status} ${a.tool}${a.summary ? ` — ${a.summary}` : ''}`);
}

async function decide(s: State, actionId: string, decision: 'approve' | 'deny'): Promise<void> {
  let body: Record<string, string> = { decision };
  if (decision === 'approve') {
    const secret = unwrapSecret(s, await askPin('PIN: '));
    const { challenge } = await call<{ challenge: string }>('POST', '/session/challenge', { auth: 'none', body: { device_id: s.device_id, purpose: 'decision', action_id: actionId } });
    body = { decision, challenge, pin_proof: pinProofFor(secret, decisionProofMessage(challenge, actionId, 'approve')) };
  }
  const res = await call<{ action: { id: string; status: string }; queued: boolean; note: string }>('POST', `/chat/actions/${actionId}/decision`, { body });
  console.log(`Ação ${res.action.id}: ${res.action.status}. ${res.note}`);
}

async function streamWs(): Promise<void> {
  if (!accessToken) throw new Error('sem token: rode "refresh" primeiro');
  const wsPath = '/ws/m/chat';
  const url = server.replace(/^http/, 'ws') + wsPath + '?v=1';
  const ws = new WebSocket(url, {
    headers: { authorization: `Bearer ${accessToken}`, dpop: await proof('GET', wsPath, { token: accessToken }), 'x-termhub-app': APP_HEADER },
  });
  ws.on('open', () => console.log('Socket aberto; Enter para sair.'));
  ws.on('unexpected-response', (_req, res) => console.log(`Upgrade recusado: ${res.statusCode}`));
  ws.on('error', (err) => console.log(`Erro no socket: ${err.message}`));
  ws.on('message', (data) => {
    try {
      const ev = JSON.parse(String(data)) as Record<string, unknown>;
      const ids = ['conversation_id', 'message_id', 'action_id', 'tool', 'status', 'protocol'].filter((k) => ev[k] !== undefined).map((k) => `${k}=${String(ev[k])}`);
      const msg = ev.message as { id?: string; role?: string } | undefined;
      if (msg?.id) ids.push(`message=${msg.id}(${msg.role})`);
      const delta = typeof ev.delta === 'string' ? ` "${ev.delta}"` : '';
      console.log(`  < ${String(ev.type)} ${ids.join(' ')}${delta}`);
    } catch {
      console.log('  < (quadro ilegível)');
    }
  });
  const closed = new Promise<void>((resolve) =>
    ws.on('close', (code) => {
      console.log(`Socket fechado: ${code}`);
      resolve();
    }),
  );
  const stop = new AbortController();
  await Promise.race([nextLine('', false, stop.signal), closed]);
  stop.abort();
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    ws.close(1000);
    await closed;
  }
}

async function showNotifications(): Promise<void> {
  const res = await call<{ notifications: { id: string; kind: string; title: string; read_at: string | null }[]; unread: number }>('GET', '/notifications');
  console.log(`${res.notifications.length} notificações, ${res.unread} não lidas`);
  for (const n of res.notifications) console.log(`  ${n.id} ${n.kind}${n.read_at ? '' : ' (nova)'}: ${n.title}`);
}

const HELP = 'Comandos: chat | projects | send <texto> | refresh | approve <action_id> | deny <action_id> | ws | notifications | revoke | quit';

async function repl(): Promise<void> {
  console.log(HELP);
  for (;;) {
    const line = await nextLine('> ');
    if (line === null) return;
    const [cmd, ...rest] = line.trim().split(/\s+/);
    const arg = rest.join(' ');
    if (!cmd) continue;
    if (!state) {
      console.log('Sem aparelho cadastrado; rode de novo para cadastrar.');
      return;
    }
    try {
      switch (cmd) {
        case 'quit':
        case 'exit':
          return;
        case 'refresh':
          await refresh(state);
          break;
        case 'chat':
          await showChat();
          break;
        case 'projects': {
          const res = await call<{ projects: { id: string; key: string; busy: boolean; pending_confirmations: number }[] }>('GET', '/chat/projects');
          for (const p of res.projects) console.log(`  ${p.id} ${p.key}${p.busy ? ' (ocupado)' : ''}${p.pending_confirmations ? `, ${p.pending_confirmations} pendentes` : ''}`);
          if (!res.projects.length) console.log('Nenhum projeto.');
          break;
        }
        case 'send': {
          if (!arg) {
            console.log('Uso: send <texto>');
            break;
          }
          const res = await call<{ conversation_id: string; user_message_id: string; assistant_message_id: string }>('POST', '/chat/messages', { body: { text: arg } });
          console.log(`Enviada: conversa ${res.conversation_id}, mensagem ${res.user_message_id}, resposta ${res.assistant_message_id}`);
          break;
        }
        case 'approve':
        case 'deny':
          if (!arg) {
            console.log(`Uso: ${cmd} <action_id>`);
            break;
          }
          await decide(state, arg, cmd);
          break;
        case 'ws':
          await streamWs();
          break;
        case 'notifications':
          await showNotifications();
          break;
        case 'revoke':
          await call('POST', '/devices/self/revoke');
          deleteState();
          state = null;
          accessToken = null;
          console.log(`Aparelho removido; ${statePath} apagado.`);
          return;
        default:
          console.log(HELP);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        console.log(err.message);
        if (err.code === 'DEVICE_REVOKED') return;
        // Expired, or deleted by a revoke: renewing tells the two apart (a revoked device gets DEVICE_REVOKED).
        if (err.code === 'TOKEN_EXPIRED') {
          accessToken = null;
          console.log('Token expirado ou removido: rode "refresh".');
        }
      } else {
        console.log(`Erro: ${(err as Error).message}`);
      }
    }
  }
}

async function main(): Promise<void> {
  console.log(`Servidor ${server} (assina contra ${publicUrl})`);
  state = loadState();
  if (state) {
    await loadKey(state.jwk);
    console.log(`Aparelho ${state.device_id} (de ${statePath}); rode "refresh" para abrir a sessão.`);
  } else {
    state = await enrol();
  }
  await repl();
}

main()
  .catch((err) => {
    console.error(err instanceof ApiError ? err.message : `Erro: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
