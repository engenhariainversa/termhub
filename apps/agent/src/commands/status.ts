import { readConfig } from '../config.js';
import { checkServerConnection } from '../run.js';
import { AGENT_VERSION } from '../version.js';

const CHECK_TIMEOUT_MS = 5_000;

export async function statusCommand(json: boolean): Promise<void> {
  const config = readConfig();
  if (!config) {
    console.error('Nenhuma configuração. Rode: termhub-agent connect --url <url>');
    process.exitCode = 1;
    return;
  }

  const check = await checkServerConnection(config, CHECK_TIMEOUT_MS);

  if (json) {
    console.log(JSON.stringify({ url: config.url, machine_name: config.machine_name || null, version: AGENT_VERSION, credential: config.credential, connected: check.ok }));
    return;
  }

  console.log(`Servidor: ${config.url}`);
  console.log(`Máquina: ${config.machine_name || '—'}`);
  console.log(`Versão: ${AGENT_VERSION}`);
  console.log(
    config.credential === 'key'
      ? 'Credencial: chave do dispositivo'
      : 'Credencial: token permanente (antigo). Para trocar por uma chave do dispositivo, use "Parear de novo" no app.',
  );
  console.log(check.ok ? 'conectado ✓' : `desconectado ✗${check.error ? ` (${check.error})` : ''}`);
}
