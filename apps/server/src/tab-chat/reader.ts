import { CAPABILITY_TRANSCRIPT, CAPABILITY_TRANSCRIPT_CODEX, type RpcParams, type RpcResult } from '@termhub/agent-protocol';
import { CLAUDE_SESSION_ID_RE, isCodexTranscriptPath } from '@termhub/machine-ops';
import type { TTabChatEmptyReason } from '@termhub/mobile-api';
import { agentRpc } from '../agent/errors.js';
import { agents } from '../agent/registry.js';
import type { Machine, Tab } from '../db/repositories/types.js';
import { CODEX_TRANSCRIPT_TYPES, parseCodexLines } from './codex-transcript.js';
import { isDegraded, parseLines, TRANSCRIPT_TYPES, type Parsed, type TabChatItem } from './transcript.js';

/**
 * A tab's Claude Code or Codex (TER-1095) transcript read through the agent's `transcript.read` (spec
 * 2026-10-01 tab chat §5.2): whether it can be read at all, a page of history read backward, and the new
 * lines read forward. Nothing here keeps or logs a line.
 */

export type TabChatAvailability = 'ready' | 'no_session' | 'unsupported_tool' | 'unsupported_machine' | 'agent_outdated' | 'offline';

export type AgentView = Pick<typeof agents, 'isOnline' | 'capabilities'>;

export type Rpc = (machine: Machine, params: RpcParams<'transcript.read'>) => Promise<RpcResult<'transcript.read'>>;

const defaultRpc: Rpc = (machine, params) => agentRpc(machine, 'transcript.read', params);

/** One read: big enough for a screenful of conversation, far under the 1 MB frame. */
export const READ_MAX_BYTES = 256 * 1024;
/** Strings over this are cut by the agent (a whole file read, a long tool output). */
export const READ_MAX_STRING = 4000;

/** The agents whose transcript is read: Claude Code, and Codex since TER-1095. */
export type TranscriptTool = 'claude' | 'codex';

/** Whose transcript the tab's conversation is: the tool its hooks last reported (no report yet reads as Claude), or null for another agent (Cursor). */
export function transcriptToolOf(tab: Pick<Tab, 'state_tool'>): TranscriptTool | null {
  if (!tab.state_tool || tab.state_tool === 'claude') return 'claude';
  return tab.state_tool === 'codex' ? 'codex' : null;
}

/** In the order of the spec's table: the first reason that applies wins. */
export function availabilityOf(tab: Tab, machine: Pick<Machine, 'id' | 'type'>, agent: AgentView = agents): TabChatAvailability {
  if (machine.type !== 'agent') return 'unsupported_machine';
  if (!agent.isOnline(machine.id)) return 'offline';
  const capabilities = agent.capabilities(machine.id) ?? [];
  if (!capabilities.includes(CAPABILITY_TRANSCRIPT)) return 'agent_outdated';
  const tool = transcriptToolOf(tab);
  if (!tool) return 'unsupported_tool';
  if (tool === 'codex' && !capabilities.includes(CAPABILITY_TRANSCRIPT_CODEX)) return 'agent_outdated';
  if (!hasReportedSession(tab)) return 'no_session';
  return 'ready';
}

/** Whether the tab has reported a session `availabilityOf` can read: one of the agent it runs now (a Claude session left in a tab that now runs Codex is not). */
export function hasReportedSession(tab: Pick<Tab, 'agent_session_id' | 'agent_transcript_path' | 'state_tool'>): boolean {
  const sid = tab.agent_session_id;
  if (!tab.agent_transcript_path || !sid || !CLAUDE_SESSION_ID_RE.test(sid)) return false;
  const tool = transcriptToolOf(tab);
  if (tool === 'codex') return isCodexTranscriptPath(tab.agent_transcript_path, sid);
  return tool === 'claude' && !isCodexTranscriptPath(tab.agent_transcript_path, sid);
}

/** What the tab's machine has of the termhub hooks, as far as an empty conversation needs to know:
 *  never installed, installed, or installed while Codex has not been told to trust them (TER-1095). */
export type HooksOnMachine = 'missing' | 'installed' | 'codex_untrusted';

/**
 * Why a page has no history (TER-1091, `TAB_CHAT_EMPTY_REASONS` in the contract), or null when it has
 * some or another availability already says why. `firstPage`: the read started at the end of the session
 * (no `before`), so an empty page means the session itself is empty.
 */
export function emptyReasonOf(tab: Pick<Tab, 'agent_session_id' | 'agent_transcript_path' | 'state_tool'>, availability: TabChatAvailability, page: Pick<Page, 'items' | 'before'>, firstPage: boolean, hooks: HooksOnMachine): TTabChatEmptyReason | null {
  if (availability === 'no_session') {
    if (hasReportedSession(tab)) return 'transcript_missing';
    if (hooks === 'missing') return 'no_hooks';
    return hooks === 'codex_untrusted' && transcriptToolOf(tab) === 'codex' ? 'codex_untrusted' : 'not_reported';
  }
  if (availability === 'ready' && firstPage && page.items.length === 0 && page.before === null) return 'new_session';
  return null;
}

/** A position in one session's transcript: a byte offset on a line boundary. Opaque to the app. */
export interface Cursor {
  session: string;
  offset: number;
}

export function encodeCursor(c: Cursor): string {
  return `${c.session}.${c.offset}`;
}

/** null for anything malformed. */
export function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot < 0) return null;
  const session = raw.slice(0, dot);
  const offset = raw.slice(dot + 1);
  if (!CLAUDE_SESSION_ID_RE.test(session) || !/^\d{1,15}$/.test(offset)) return null;
  return { session, offset: Number(offset) };
}

export interface Page {
  items: TabChatItem[];
  /** the previous page's cursor; null at byte 0 */
  before: string | null;
  /** where the live socket follows from (the end of what this read covered); null when missing */
  live: string | null;
  mode: string | null;
  degraded: boolean;
  /** the transcript is not on the machine: the caller reports `no_session` */
  missing: boolean;
}

export interface Forward {
  items: TabChatItem[];
  /** the cursor after this read */
  live: string;
  mode: string | null;
  missing: boolean;
  /** the file has bytes past this read: read again at once */
  more: boolean;
  /** counts of the parse, for a debug log by the caller (never the lines) */
  known: number;
  unknown: number;
}

/** Only callers that checked `availabilityOf(...) === 'ready'` get here, so both are set. */
function sessionOf(tab: Tab): { transcript_path: string; session_id: string } {
  return { transcript_path: tab.agent_transcript_path ?? '', session_id: tab.agent_session_id ?? '' };
}

/** The line types to ask for and how to read them, by the transcript's own shape. */
function formatOf(transcriptPath: string, sessionId: string): { types: string[]; parse: (lines: string[]) => Parsed } {
  if (isCodexTranscriptPath(transcriptPath, sessionId)) return { types: [...CODEX_TRANSCRIPT_TYPES], parse: parseCodexLines };
  return { types: [...TRANSCRIPT_TYPES], parse: parseLines };
}

/**
 * A page of history, read backward from `before` (or from the end of the file). A `before` of another
 * session (a `/clear` since) or a malformed one reads the end of the current session.
 */
export async function readPage(machine: Machine, tab: Tab, before: string | null, rpc: Rpc = defaultRpc): Promise<Page> {
  const { transcript_path, session_id } = sessionOf(tab);
  const format = formatOf(transcript_path, session_id);
  const cursor = decodeCursor(before);
  const offset = cursor && cursor.session === session_id ? cursor.offset : null;
  const res = await rpc(machine, {
    transcript_path,
    session_id,
    direction: 'backward',
    offset,
    max_bytes: READ_MAX_BYTES,
    types: format.types,
    max_string: READ_MAX_STRING,
  });
  if (res.status === 'missing') return { items: [], before: null, live: null, mode: null, degraded: false, missing: true };
  const parsed = format.parse(res.lines);
  return {
    items: parsed.items,
    before: res.start > 0 ? encodeCursor({ session: session_id, offset: res.start }) : null,
    live: encodeCursor({ session: session_id, offset: res.end }),
    mode: parsed.mode,
    degraded: isDegraded(parsed),
    missing: false,
  };
}

/** The lines written after `after` (a cursor of the tab's current session; the caller checks). */
export async function readForward(machine: Machine, tab: Tab, after: Cursor, rpc: Rpc = defaultRpc): Promise<Forward> {
  const { transcript_path, session_id } = sessionOf(tab);
  const format = formatOf(transcript_path, session_id);
  const res = await rpc(machine, {
    transcript_path,
    session_id,
    direction: 'forward',
    offset: after.offset,
    max_bytes: READ_MAX_BYTES,
    types: format.types,
    max_string: READ_MAX_STRING,
  });
  if (res.status === 'missing') return { items: [], live: encodeCursor(after), mode: null, missing: true, more: false, known: 0, unknown: 0 };
  const parsed = format.parse(res.lines);
  return {
    items: parsed.items,
    live: encodeCursor({ session: session_id, offset: res.end }),
    mode: parsed.mode,
    missing: false,
    more: res.end < res.size && res.end > after.offset,
    known: parsed.known,
    unknown: parsed.unknown,
  };
}
