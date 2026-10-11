/** Directory (relative to $HOME on the target machine) holding each tab's private MCP config. */
export const TAB_MCP_DIR_REL = '.termhub/tabs';

/** A tab id, as minted by the server: lowercase alphanumerics only, no path separators. */
export const TAB_ID_RE = /^[a-z0-9]{1,64}$/;

export type TabMcpFile = 'mcp.json' | 'token' | 'guard.json';

function tabDir(tabId: string): string {
  if (!TAB_ID_RE.test(tabId)) throw new Error('tab id inválido');
  return `${TAB_MCP_DIR_REL}/${tabId}`;
}

/**
 * POSIX sh that reads the file body from stdin (never from an argv or the script text itself —
 * the body holds a token) and writes it to ~/.termhub/tabs/<tabId>/<file> with a 0700 dir and a
 * 0600 file (umask + temp file/rename, same pattern as hooks.ts' writeAtomic on the node side).
 * Prints `ok` on success.
 */
export function buildTabMcpWriteScript(tabId: string, file: TabMcpFile): string {
  const dir = tabDir(tabId); // throws on a bad id
  return [
    'umask 077',
    `d="$HOME/${dir}"`,
    'mkdir -p "$d" || exit 1',
    'chmod 700 "$d" || exit 1',
    `cat > "$d/${file}.tmp" || exit 1`,
    `mv -f "$d/${file}.tmp" "$d/${file}" || exit 1`,
    'echo ok',
  ].join('\n');
}

/** POSIX sh that deletes the tab's whole MCP config dir. Best effort: `rm -rf` never fails on a missing dir. */
export function buildTabMcpRemoveScript(tabId: string): string {
  return `rm -rf "$HOME/${tabDir(tabId)}"; echo ok`;
}
