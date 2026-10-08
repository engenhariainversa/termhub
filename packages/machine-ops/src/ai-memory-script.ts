/**
 * ai-memory on a machine (TER-1018): is the binary there, its version, and does its local server
 * answer. The script prints tags only (`BIN:`, `VERSION:`, `STATUS:`, `SERVER:`), never what
 * `ai-memory status` writes: nothing ai-memory stores may leave the machine.
 *
 * - `STATUS:ok|fail`: exit code of `ai-memory status`, cut after 4 s.
 * - `SERVER:up|down|unknown`: any HTTP answer at the configured URL counts as up (curl, 3 s);
 *   `unknown` when the machine has no curl, then `STATUS` decides.
 *
 * `quotedUrl` must already be shell-quoted (`shellQuote`) and validated as a loopback or private origin.
 */
export function buildAiMemoryStatusScript(quotedUrl: string): string {
  return [
    'command -v ai-memory >/dev/null 2>&1 || { echo BIN:no; exit 0; }',
    'echo BIN:yes',
    'echo "VERSION:$(ai-memory --version 2>/dev/null | head -n 1)"',
    'ai-memory status >/dev/null 2>&1 </dev/null & p=$!',
    '{ sleep 4; kill $p 2>/dev/null; } >/dev/null 2>&1 & w=$!',
    'if wait $p; then echo STATUS:ok; else echo STATUS:fail; fi',
    'kill $w 2>/dev/null',
    'if command -v curl >/dev/null 2>&1; then',
    `  c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 ${quotedUrl} 2>/dev/null)`,
    '  case "$c" in ""|000) echo SERVER:down ;; *) echo SERVER:up ;; esac',
    'else echo SERVER:unknown; fi',
    'exit 0',
  ].join('\n');
}

export interface AiMemoryProbe {
  installed: boolean;
  /** `2.6.0` out of `ai-memory 2.6.0`; null when the binary does not say */
  version: string | null;
  server_up: boolean;
}

const VERSION_RE = /\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/;

export function parseAiMemoryStatus(stdout: string): AiMemoryProbe {
  let installed = false;
  let version: string | null = null;
  let status = false;
  let server: 'up' | 'down' | 'unknown' = 'unknown';
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === 'BIN:yes') installed = true;
    else if (line.startsWith('VERSION:')) version = VERSION_RE.exec(line.slice(8))?.[0].slice(0, 32) ?? null;
    else if (line === 'STATUS:ok') status = true;
    else if (line === 'SERVER:up') server = 'up';
    else if (line === 'SERVER:down') server = 'down';
  }
  if (!installed) return { installed: false, version: null, server_up: false };
  return { installed, version, server_up: server === 'unknown' ? status : server === 'up' };
}
