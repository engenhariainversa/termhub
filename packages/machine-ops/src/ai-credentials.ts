import { shellQuote } from './shell.js';

export type AiProvider = 'claude' | 'chatgpt' | 'gemini' | 'antigravity';

/**
 * Separates the candidate credential blobs the claude script prints (see below).
 * The code that reads them on the machine (parseClaudeCredential in the agent or on the server's own
 * host, the awk program of usageRequestScript over SSH) splits on this and keeps the freshest one.
 */
export const CREDENTIAL_SEPARATOR = '---termhub-credential---';

/** POSIX sh that prints the CLI credential; $D is the provider config dir (already set by the caller). */
export function credentialScript(provider: AiProvider): string {
  switch (provider) {
    case 'claude':
      // Claude Code keeps the live OAuth token in different places depending on the OS and on
      // CLAUDE_CONFIG_DIR, and the on-disk copy under $D can go stale once the CLI starts using
      // the macOS keychain. So every candidate is printed, separated by SEP, and the caller, still on
      // the same machine (ai-usage-claude.ts, or the awk in ai-usage-script.ts), picks the one with
      // the largest claudeAiOauth.expiresAt. The credential never leaves the machine.
      return [
        `SEP=${shellQuote(CREDENTIAL_SEPARATOR)}`,
        // 1. the on-disk copy (Linux, and macOS when the keychain entry is missing/disabled)
        `if [ -f "$D/.credentials.json" ]; then cat "$D/.credentials.json" 2>/dev/null || true; fi`,
        `printf '\\n%s\\n' "$SEP"`,
        `if [ "$(uname -s 2>/dev/null)" = Darwin ]; then`,
        `  D=\${D%/}`,
        // 2a. the per-config-dir keychain item (CLAUDE_CONFIG_DIR accounts)
        `  H=$(printf %s "$D" | shasum -a 256 2>/dev/null | cut -c1-8) || true`,
        `  if [ -n "$H" ]; then security find-generic-password -s "Claude Code-credentials-$H" -w 2>/dev/null || true; fi`,
        `  printf '\\n%s\\n' "$SEP"`,
        // 2b. the unsuffixed item, only for the default dir (it belongs to a different account otherwise)
        `  if [ "$D" = "$HOME/.claude" ]; then security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null || true; fi`,
        `  printf '\\n%s\\n' "$SEP"`,
        `fi`,
      ].join('\n');
    case 'chatgpt':
      return `if [ -f "$D/auth.json" ]; then cat "$D/auth.json"; fi`;
    case 'gemini':
      return `if [ -f "$D/oauth_creds.json" ]; then cat "$D/oauth_creds.json"; fi`;
    case 'antigravity':
      return `if [ -f "$D/antigravity-cli/antigravity-oauth-token" ]; then cat "$D/antigravity-cli/antigravity-oauth-token"; fi`;
  }
}

/** Default CLI config dir (relative to $HOME) per provider. */
export const DEFAULT_CONFIG_DIRS: Record<AiProvider, string> = { claude: '.claude', chatgpt: '.codex', gemini: '.gemini', antigravity: '.gemini' };

/**
 * "~" and "~/x" are expanded on the target machine, never here.
 * Returns the sh prefix that sets $D to the provider's config dir.
 */
export function configDirPrefix(configDir: string | null, defaultDir: string): string {
  const raw = (configDir ?? '').trim();
  if (!raw) return `D="$HOME/${defaultDir}"`;
  if (raw.includes('\0') || raw.includes('\n')) throw new Error('Invalid config dir');
  return `P=${shellQuote(raw)}; case "$P" in "~") P=$HOME;; "~/"*) P="$HOME/\${P#\\~/}";; esac; D="$P"`;
}
