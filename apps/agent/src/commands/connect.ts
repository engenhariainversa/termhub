import readline from 'node:readline';
import { CLOSE, type HelloMessage } from '@termhub/agent-protocol';
import { connectOnce, UpgradeRejectedError } from '../client.js';
import { writeConfig, type AgentConfig } from '../config.js';
import { deleteDeviceKey, generateDeviceKey, writeDeviceKey } from '../device-key.js';
import { buildHello, detectOs, runAgent } from '../run.js';
import type { Logger } from './types.js';

/** `thb_ag_` + 43 base64url characters — matches the token format the server issues. */
const TOKEN_RE = /^thb_ag_[A-Za-z0-9_-]{43}$/;

function promptToken(): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Cole o token do agente: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Runs the agent in the foreground until Ctrl-C (SIGINT/SIGTERM), then exits 0. Used by `run`. */
export async function runForegroundUntilSignal(config: AgentConfig, log: Logger): Promise<never> {
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    await runAgent(config, { signal: controller.signal, log });
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  process.exit(0);
}

export interface ConnectValues {
  url?: string;
  token?: string;
}

export async function connectCommand(values: ConnectValues, log: Logger): Promise<void> {
  const url = values.url ?? process.env.TERMHUB_URL;
  if (!url) {
    console.error('Uso: termhub-agent connect --url <url> [--token <token>]');
    process.exitCode = 2;
    return;
  }

  let token = values.token ?? process.env.TERMHUB_TOKEN;
  if (!token) {
    if (!process.stdin.isTTY) {
      console.error('Uso: termhub-agent connect --url <url> --token <token>');
      process.exitCode = 2;
      return;
    }
    token = await promptToken();
  }

  if (!TOKEN_RE.test(token)) {
    console.error('Token inválido.');
    process.exitCode = 2;
    return;
  }

  const osName = detectOs();
  if (!osName) {
    console.error('Sistema não suportado');
    process.exitCode = 1;
    return;
  }

  const hello = await buildHello(osName);
  const key = generateDeviceKey();
  const outcome = await pairOnce(url, token, { ...hello, probe: true, pair: { public_key: key.publicKey } }, log);
  if (!outcome.ok) {
    console.error(outcome.error);
    process.exitCode = 1;
    return;
  }

  const createdAt = new Date().toISOString();
  if (outcome.paired) {
    // The server burnt the token and keeps the public key: from now on every dial signs its nonce.
    writeDeviceKey(key);
    writeConfig({ url, credential: 'key', machine_id: outcome.paired.machine_id, machine_name: outcome.paired.machine_name, created_at: createdAt });
  } else {
    // An older server took the token as a permanent bearer (probe-ok): keep it, as agents before 0.25.0 did.
    deleteDeviceKey();
    writeConfig({ url, credential: 'bearer', token, machine_id: '', machine_name: '', created_at: createdAt });
  }
  // Pairing is done: hand the terminal back. The long-lived session belongs to the service
  // (`service install`) or to an explicit `termhub-agent run`; keeping it in the foreground here
  // made users type the next command into the running agent.
  console.log(outcome.paired ? `Pareado com a máquina ${outcome.paired.machine_name || outcome.paired.machine_id}. Configuração salva.` : 'Conectado. Configuração salva.');
  console.log('Próximos passos:');
  console.log('  termhub-agent service install   # mantém o agente rodando em segundo plano');
  console.log('  termhub-agent doctor            # confere tmux e acesso às pastas');
  console.log('(ou termhub-agent run para rodar em primeiro plano)');
}

const PAIR_TIMEOUT_MS = 15_000;
const SPENT_MESSAGE = 'Token inválido, expirado ou já usado. Gere outro no app (Máquinas → Parear de novo).';

/**
 * One pairing dial (TER-1017): the pairing token as a bearer, plus the new public key in the hello. The
 * server answers `paired` and closes 1000 `paired`; an older server, which knows nothing of pairing,
 * takes the token as a permanent bearer and answers the probe with 1000 `probe-ok` (`paired` null).
 * `probe: true` keeps an older server from attaching, so pairing never bumps a running service.
 */
async function pairOnce(
  url: string,
  token: string,
  hello: Omit<HelloMessage, 'type' | 'protocol'>,
  log: Logger,
): Promise<{ ok: true; paired: { machine_id: string; machine_name: string } | null } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAIR_TIMEOUT_MS);
  let paired: { machine_id: string; machine_name: string } | null = null;
  try {
    const { closed } = await connectOnce(
      {
        url,
        token,
        hello,
        onHandshake: (msg) => {
          if (msg.type === 'paired') paired = { machine_id: msg.machine_id, machine_name: msg.machine_name };
        },
        onServerMessage: () => {},
        onStream: () => {},
        log,
      },
      controller.signal,
    );
    const info = await closed;
    if (info.code === 1000 && info.reason === 'paired' && paired) return { ok: true, paired };
    if (info.code === 1000 && info.reason === 'probe-ok') return { ok: true, paired: null };
    if (info.code === CLOSE.UNAUTHORIZED) return { ok: false, error: SPENT_MESSAGE };
    if (controller.signal.aborted) return { ok: false, error: 'Não foi possível conectar: o servidor não respondeu' };
    return { ok: false, error: `Não foi possível conectar: conexão encerrada (${info.code}${info.reason ? ` ${info.reason}` : ''})` };
  } catch (err) {
    if (err instanceof UpgradeRejectedError && err.status === 401) return { ok: false, error: SPENT_MESSAGE };
    return { ok: false, error: `Não foi possível conectar: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
