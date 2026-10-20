import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const CONFIG_FILE = 'config.json';

export const agentConfigSchema = z
  .object({
    url: z.string().min(1),
    /**
     * How this agent proves itself (TER-1017). `key`: the device key in `device-key.pem`, paired with a
     * single-use token; `bearer`: the permanent `thb_ag_` token in `token`, what every config written
     * before 0.25.0 holds (hence the default) and what `connect` still saves against an older server.
     */
    credential: z.enum(['bearer', 'key']).default('bearer'),
    token: z.string().min(1).optional(),
    // A bearer pairing never learns its machine (the server does not say), so these stay '' there;
    // a key pairing gets both from the server's `paired` answer, and needs the id to dial.
    machine_id: z.string(),
    machine_name: z.string(),
    created_at: z.string().min(1),
  })
  .refine((c) => (c.credential === 'key' ? c.machine_id.length > 0 : c.token !== undefined), {
    message: 'a bearer config needs its token, a key config its machine id',
  });

export type AgentConfig = z.infer<typeof agentConfigSchema>;
/** What `writeConfig` takes: `credential` may be left out for a bearer config. */
export type AgentConfigInput = z.input<typeof agentConfigSchema>;

/** `$TERMHUB_AGENT_HOME`, or `~/.termhub` — where the agent keeps its config file. */
export function agentHome(): string {
  const override = process.env.TERMHUB_AGENT_HOME?.trim();
  return override && override.length > 0 ? override : path.join(os.homedir(), '.termhub');
}

/** Full path to the config file — exposed for `doctor.ts`, which reports it without reading it itself. */
export function configPath(): string {
  return path.join(agentHome(), CONFIG_FILE);
}

/** Reads and validates the config file. Missing file, corrupt JSON or a schema mismatch all return null. */
export function readConfig(): AgentConfig | null {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath(), 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = agentConfigSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/** Writes the config atomically (temp file + rename) with restrictive permissions (dir 0700, file 0600). */
export function writeConfig(config: AgentConfigInput): void {
  const home = agentHome();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  // mkdirSync's mode is masked by the process umask, so force it explicitly.
  fs.chmodSync(home, 0o700);

  const dest = configPath();
  const tmp = path.join(home, `.${CONFIG_FILE}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, dest);
}

/** Removes the config file, if any. Never throws when it is already gone. */
export function deleteConfig(): void {
  try {
    fs.unlinkSync(configPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
