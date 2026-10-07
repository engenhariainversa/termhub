import { type AiProvider, CREDENTIAL_SEPARATOR, DEFAULT_CONFIG_DIRS, configDirPrefix, credentialScript } from './ai-credentials.js';
import { type UsageContext, type UsageReply, type UsageRequest, parseJsonBody, parseRetryAfter } from './ai-usage-shared.js';
import { shellQuote } from './shell.js';

/**
 * AI usage over SSH (spec 2026-10-07 ai-usage-on-machine, D3): the server cannot run code on the
 * machine, so each provider HTTP request is one SSH exec of usageRequestScript. The script reads the
 * credential with credentialScript, extracts the token with awk into a shell variable and hands it to
 * curl on stdin (`-H @-`): the token is never printed and never appears on a command line. Only the
 * meta block (expiry, plan) and curl's response come back to the server.
 */
export const USAGE_NO_CREDENTIAL = 'termhub-usage-no-credential';
export const USAGE_NO_CURL = 'termhub-usage-no-curl';
const META_MARK = 'termhub-usage-meta';
const RESPONSE_MARK = 'termhub-usage-response';
const STATUS_MARK = 'termhub-usage-status=';

/**
 * POSIX awk (match/RSTART/RLENGTH/substr/sub/index only). Reads credentialScript's output and prints
 * four lines: token, expiry (unix ms, numeric only), plan, ChatGPT account id. Records are separated by
 * CREDENTIAL_SEPARATOR lines; JSON may span lines (they are joined). For claude, the record with the
 * largest claudeAiOauth.expiresAt wins (missing = 0, first wins on ties), like parseClaudeCredential.
 * Fields are read inside the object that holds them (claudeAiOauth / tokens / token) up to its first
 * `}`, so an `accessToken` elsewhere in the file (e.g. an MCP server's OAuth entry) is never picked.
 */
const EXTRACT_AWK = `
function grab(s, key,   v) {
  if (!match(s, "\\"" key "\\"[ \\t]*:[ \\t]*\\"[^\\"]*\\"")) return ""
  v = substr(s, RSTART, RLENGTH)
  sub(/^"[^"]*"[ \\t]*:[ \\t]*"/, "", v)
  sub(/"$/, "", v)
  return v
}
function grabnum(s, key,   v) {
  if (!match(s, "\\"" key "\\"[ \\t]*:[ \\t]*[0-9]+")) return ""
  v = substr(s, RSTART, RLENGTH)
  sub(/^"[^"]*"[ \\t]*:[ \\t]*/, "", v)
  return v
}
function inside(s, key,   i, rest, j) {
  i = index(s, "\\"" key "\\"")
  if (!i) return ""
  rest = substr(s, i)
  j = index(rest, "}")
  if (j) rest = substr(rest, 1, j)
  return rest
}
function flush(   s, t, e, r) {
  if (p == "claude") s = inside(buf, "claudeAiOauth")
  else if (p == "chatgpt") s = inside(buf, "tokens")
  else if (p == "antigravity") s = inside(buf, "token")
  else s = buf
  buf = ""
  if (s == "") return
  t = grab(s, (p == "claude") ? "accessToken" : "access_token")
  if (t == "") return
  e = ""
  if (p == "claude") e = grabnum(s, "expiresAt")
  else if (p == "gemini") e = grabnum(s, "expiry_date")
  r = (e == "") ? 0 : e + 0
  if (found && r <= best) return
  found = 1; best = r; tok = t; ex = e
  pl = (p == "claude") ? grab(s, "subscriptionType") : ""
  acct = (p == "chatgpt") ? grab(s, "account_id") : ""
}
{
  line = $0
  sub(/^[ \\t\\r]+/, "", line)
  sub(/[ \\t\\r]+$/, "", line)
  if (line == sep) { flush(); next }
  buf = buf " " $0
}
END {
  flush()
  if (found) printf "%s\\n%s\\n%s\\n%s\\n", tok, ex, pl, acct
}
`;

/**
 * POSIX sh that runs one provider HTTP request on the machine with the CLI credential found there.
 * Output: USAGE_NO_CREDENTIAL, USAGE_NO_CURL, or the meta block followed by curl's headers + body and
 * a trailing `termhub-usage-status=NNN` line (read it with parseUsageScriptOutput). Always exits 0
 * once the script itself ran. Throws on an invalid config dir (like configDirPrefix).
 */
export function usageRequestScript(provider: AiProvider, configDir: string | null, req: UsageRequest): string {
  const setD = configDirPrefix(configDir, DEFAULT_CONFIG_DIRS[provider]);
  const curlArgs = ['-sS', '-m', '12', '-D', '-', '-H', '@-'];
  for (const [k, v] of Object.entries(req.headers ?? {})) {
    if (/[\r\n]/.test(k) || /[\r\n]/.test(v)) throw new Error('Invalid header');
    curlArgs.push('-H', shellQuote(`${k}: ${v}`));
  }
  if ((req.method ?? 'GET') === 'POST') curlArgs.push('-X', 'POST', '--data-binary', shellQuote(req.body ?? ''));
  curlArgs.push('-w', shellQuote(`\\n${STATUS_MARK}%{http_code}\\n`), shellQuote(req.url));
  return [
    setD,
    // the credential goes straight from credentialScript into awk; only awk's four lines reach $X
    `X=$({`,
    credentialScript(provider),
    `} 2>/dev/null | awk -v p=${shellQuote(provider)} -v sep=${shellQuote(CREDENTIAL_SEPARATOR)} ${shellQuote(EXTRACT_AWK)})`,
    // printf is a shell builtin: the token never shows up in a process argv
    `T=$(printf '%s\\n' "$X" | sed -n 1p)`,
    `E=$(printf '%s\\n' "$X" | sed -n 2p)`,
    `P=$(printf '%s\\n' "$X" | sed -n 3p)`,
    `A=$(printf '%s\\n' "$X" | sed -n 4p)`,
    `X=`,
    `if [ -z "$T" ]; then echo ${USAGE_NO_CREDENTIAL}; exit 0; fi`,
    `if ! command -v curl >/dev/null 2>&1; then echo ${USAGE_NO_CURL}; exit 0; fi`,
    `printf '%s\\n%s\\n%s\\n%s\\n' ${META_MARK} "$E" "$P" ${RESPONSE_MARK}`,
    // the auth headers travel on curl's stdin (-H @-), never on its command line
    `{ printf 'authorization: Bearer %s\\n' "$T"; if [ -n "$A" ]; then printf 'chatgpt-account-id: %s\\n' "$A"; fi; } | curl ${curlArgs.join(' ')} || true`,
    `exit 0`,
  ].join('\n');
}

export type UsageScriptOutput = { kind: 'no_credential' } | { kind: 'no_curl' } | { kind: 'reply'; meta: UsageContext; reply: UsageReply } | { kind: 'invalid' };

/** Reads usageRequestScript's output: the meta block, then curl's header block(s), body and status. */
export function parseUsageScriptOutput(stdout: string): UsageScriptOutput {
  const trimmed = stdout.trim();
  if (trimmed === USAGE_NO_CREDENTIAL) return { kind: 'no_credential' };
  if (trimmed === USAGE_NO_CURL) return { kind: 'no_curl' };

  const metaAt = stdout.indexOf(`${META_MARK}\n`);
  if (metaAt < 0) return { kind: 'invalid' };
  const afterMeta = stdout.slice(metaAt + META_MARK.length + 1);
  const respMark = `\n${RESPONSE_MARK}\n`;
  // the meta block is exactly two lines (expiry, plan), possibly empty
  const nl1 = afterMeta.indexOf('\n');
  if (nl1 < 0) return { kind: 'invalid' };
  const nl2 = afterMeta.indexOf('\n', nl1 + 1);
  if (nl2 < 0 || !afterMeta.startsWith(respMark, nl2)) return { kind: 'invalid' };
  const expiry = afterMeta.slice(0, nl1).trim();
  const plan = afterMeta.slice(nl1 + 1, nl2).trim();
  let rest = afterMeta.slice(nl2 + respMark.length);

  const statusMatch = /\n?termhub-usage-status=(\d{3})\s*$/.exec(rest);
  if (!statusMatch) return { kind: 'invalid' };
  const status = Number(statusMatch[1]);
  rest = rest.slice(0, statusMatch.index);

  // curl -D - prints every header block (100 Continue, proxy CONNECT, the final answer); the last one counts
  let headerBlock = '';
  while (/^HTTP\/[\d.]+ \d{3}/.test(rest)) {
    const end = /\r?\n\r?\n/.exec(rest);
    if (!end) {
      headerBlock = rest;
      rest = '';
      break;
    }
    headerBlock = rest.slice(0, end.index);
    rest = rest.slice(end.index + end[0].length);
  }
  let retryAfter: string | null = null;
  for (const line of headerBlock.split(/\r?\n/)) {
    const m = /^retry-after:\s*(.*)$/i.exec(line);
    if (m) retryAfter = m[1].trim();
  }

  const meta: UsageContext = { expires_at: /^\d+$/.test(expiry) ? Number(expiry) : null, plan: plan || null };
  return { kind: 'reply', meta, reply: { status, body: parseJsonBody(rest), text: rest, retryAfterMs: parseRetryAfter(retryAfter) } };
}
