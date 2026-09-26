import { STREAM_END_INPUT_LINE, streamUserMessageLine } from '@termhub/agent-protocol';
import type { ChatMessage, ChatRepository } from '../db/repositories/chat.js';
import { chatBus } from './bus.js';
import type { RunStream } from './service.js';
import { codeForReason, parseFrame, type ChatErrorCode } from './stream.js';

/** One message of the person's in a streamed run, from the moment it is written until it is answered. */
export interface LiveTurn {
  /** The uuid written with the message; the CLI replays it when this turn starts. */
  uuid: string;
  /** Written to the CLI: the person's text, with any tab-question context in front. */
  text: string;
  question: ChatMessage;
  answer: ChatMessage;
  /** Settles `done` of the `StartedRun` this turn was handed back as. */
  settle: { resolve(m: ChatMessage): void; reject(e: unknown): void };
}

/** A turn being answered: the person's, or one the CLI started on its own (a subagent's notification). */
interface Answering {
  turn: LiveTurn | null;
  answer: ChatMessage;
  collected: string;
  usage: unknown;
}

export interface LiveRunDeps {
  userId: string;
  conversationId: string;
  /** The CLI session this run resumes (or will name), updated from the CLI's own frames. */
  sessionId: string | null;
  chat: Pick<ChatRepository, 'addMessage' | 'updateMessage' | 'deleteMessage' | 'setCliSession'>;
}

/**
 * One long-lived `claude` process of a conversation, with streamed input (spec 2026-09-26 §5.7): turns
 * go in as lines, answers come back matched by the replayed uuid, a turn the CLI starts on its own gets
 * a message of its own, and the input ends once nothing is running. It never takes the conversation's
 * lock nor mints a token — `ChatService` does, and owns this object for as long as the process lives.
 */
export class LiveRun {
  private waiting: LiveTurn[] = [];
  private current: Answering | null = null;
  private background = 0;
  private stream: RunStream | null = null;
  private inputOpen = true;
  private ended = 0;
  private session: string | null;

  constructor(private deps: LiveRunDeps) {
    this.session = deps.sessionId;
  }

  /** Whether a message can still be injected into this process. */
  get accepting(): boolean {
    return this.inputOpen;
  }
  get endedTurns(): number {
    return this.ended;
  }
  get sessionId(): string | null {
    return this.session;
  }

  /** Takes a turn: written now to the live process, or kept for `initialText` before it starts. False
   *  when the input is closed (or the channel refused the line): the caller queues it for the next run. */
  add(turn: LiveTurn): boolean {
    if (!this.inputOpen) return false;
    this.waiting.push(turn);
    if (this.stream?.write && !this.stream.write(streamUserMessageLine(turn.text, turn.uuid))) {
      this.waiting.pop();
      return false;
    }
    return true;
  }

  /** The first input of a process: every turn not yet answered, one line each. */
  initialText(): string {
    return this.waiting.map((t) => `${streamUserMessageLine(t.text, t.uuid)}\n`).join('');
  }

  /** Reads one process to its end. Throws what the stream throws (a setup failure is the caller's). */
  async consume(stream: RunStream): Promise<{ code: ChatErrorCode; missingSession: boolean }> {
    this.stream = stream;
    let code: ChatErrorCode = null;
    let missingSession = false;
    try {
      for await (const line of stream) {
        const frame = parseFrame(line);
        if (!frame) continue;
        if (frame.type === 'turn_started') {
          const i = this.waiting.findIndex((t) => t.uuid === frame.uuid);
          if (i === -1) continue;
          // A turn that never saw its result (it should not happen) is stored as it stands.
          if (this.current) await this.finish(this.current, null);
          const [turn] = this.waiting.splice(i, 1);
          this.current = { turn, answer: turn.answer, collected: '', usage: null };
        } else if (frame.type === 'text') {
          const a = await this.answering();
          a.collected += frame.delta;
          chatBus.publish({ type: 'delta', user_id: this.deps.userId, conversation_id: this.deps.conversationId, message_id: a.answer.id, delta: frame.delta });
        } else if (frame.type === 'action') {
          const a = await this.answering();
          chatBus.publish({ type: 'action', user_id: this.deps.userId, conversation_id: this.deps.conversationId, message_id: a.answer.id, tool: frame.tool, tool_use_id: frame.tool_use_id, args: frame.args });
        } else if (frame.type === 'action_result') {
          if (this.current) chatBus.publish({ type: 'action_result', user_id: this.deps.userId, conversation_id: this.deps.conversationId, message_id: this.current.answer.id, tool_use_id: frame.tool_use_id, ok: frame.ok });
        } else if (frame.type === 'done') {
          await this.saveSession(frame.session_id);
          if (this.current) {
            this.current.usage = frame.usage ?? null;
            await this.finish(this.current, null);
          }
          this.endInputIfIdle();
        } else if (frame.type === 'error') {
          await this.saveSession(frame.session_id);
          if (frame.turn_ended) {
            if (this.current) await this.finish(this.current, 'RUN_FAILED');
            this.endInputIfIdle();
          } else {
            code = codeForReason(frame.reason);
            if (frame.reason === 'missing_session') missingSession = true;
          }
        } else if (frame.type === 'background') {
          this.background = frame.count;
          this.endInputIfIdle();
        }
      }
    } finally {
      this.stream = null;
      this.inputOpen = false;
    }
    return { code, missingSession };
  }

  /** A fresh session after `missing_session`: every open turn waits again, its partial text dropped. */
  async restart(): Promise<void> {
    if (this.current?.turn) this.waiting.unshift(this.current.turn);
    this.current = null;
    for (const t of this.waiting) chatBus.publish({ type: 'reset', user_id: this.deps.userId, conversation_id: this.deps.conversationId, message_id: t.answer.id });
    this.background = 0;
    this.inputOpen = true;
    this.session = null;
    await this.deps.chat.setCliSession(this.deps.conversationId, null);
  }

  /** The process is over: every turn still open is stored with `code`. */
  async failOpen(code: ChatErrorCode): Promise<void> {
    this.inputOpen = false;
    const open: Answering[] = [...(this.current ? [this.current] : []), ...this.waiting.splice(0).map((t) => ({ turn: t, answer: t.answer, collected: '', usage: null }))];
    // Every turn is settled even when storing one fails (`finish` rejects that one); the first failure
    // is rethrown once all of them are done, so no web request is left waiting forever.
    let failure: { error: unknown } | null = null;
    for (const a of open) {
      try {
        await this.finish(a, code);
      } catch (e) {
        failure ??= { error: e };
      }
    }
    if (failure) throw failure.error;
  }

  /** Nothing ran and nothing will (a setup failure): the answers go, every open turn rejects. */
  async abandon(err: unknown): Promise<void> {
    this.inputOpen = false;
    const open = [...(this.current?.turn ? [this.current.turn] : []), ...this.waiting.splice(0)];
    this.current = null;
    let failure: { error: unknown } | null = null;
    for (const t of open) {
      try {
        await this.deps.chat.deleteMessage(t.answer.id);
        // Re-publishing the question makes every open screen re-read, which is how they learn the
        // answer row is gone (the bus has no "removed" event).
        chatBus.publish({ type: 'message', user_id: this.deps.userId, conversation_id: this.deps.conversationId, message: t.question });
      } catch (e) {
        failure ??= { error: e };
      } finally {
        // Rejected either way: the turn never ran, and its request must not wait forever.
        t.settle.reject(err);
      }
    }
    if (failure) throw failure.error;
  }

  /** The turn frames belong to; a turn the CLI started on its own gets a new assistant message. */
  private async answering(): Promise<Answering> {
    if (this.current) return this.current;
    const answer = await this.deps.chat.addMessage({ conversation_id: this.deps.conversationId, role: 'assistant', text: '' });
    chatBus.publish({ type: 'message', user_id: this.deps.userId, conversation_id: this.deps.conversationId, message: answer });
    this.current = { turn: null, answer, collected: '', usage: null };
    return this.current;
  }

  private async finish(a: Answering, code: ChatErrorCode): Promise<void> {
    if (this.current === a) this.current = null;
    let final: ChatMessage;
    try {
      final = await this.deps.chat.updateMessage(a.answer.id, { text: a.collected, usage: a.usage, error_code: code });
      this.ended += 1;
      chatBus.publish({ type: 'message', user_id: this.deps.userId, conversation_id: this.deps.conversationId, message: final });
      chatBus.publish({ type: 'run_finished', user_id: this.deps.userId, conversation_id: this.deps.conversationId, message_id: final.id, ok: code === null, error_code: code });
    } catch (e) {
      // The turn is already out of `current` and `waiting`: nothing else could ever settle it.
      a.turn?.settle.reject(e);
      throw e;
    }
    a.turn?.settle.resolve(final);
  }

  private async saveSession(sessionId: string | undefined): Promise<void> {
    if (!sessionId || sessionId === this.session) return;
    this.session = sessionId;
    await this.deps.chat.setCliSession(this.deps.conversationId, sessionId);
  }

  /** Nothing to answer and nothing in the background: end the input. The CLI still runs whatever it
   *  has (a notification turn that is on its way), and a message that comes later goes to the next run. */
  private endInputIfIdle(): void {
    if (!this.inputOpen || this.current || this.waiting.length > 0 || this.background > 0) return;
    this.inputOpen = false;
    this.stream?.write?.(STREAM_END_INPUT_LINE);
  }
}
