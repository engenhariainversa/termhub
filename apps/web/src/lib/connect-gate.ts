/**
 * Lets a few WebSocket handshakes run at a time, the visible terminals first (TER-902).
 *
 * Chromium runs one WebSocket handshake per host at a time and delays each new socket more the more are
 * already pending (up to 1–5 s each once about 16 are). A project with a dozen terminals opened them all at
 * once — on load, on a project switch, and again after every deploy — so the tab on screen could wait at the
 * back of that queue for half a minute, showing "Conectando…". Holding the rest here keeps the browser's
 * pending count low (no throttling) and lets us choose the order.
 */
export interface GateTicket {
  /** The handshake settled (open, closed or abandoned), or the caller gave up while waiting. Idempotent. */
  release(): void;
}

interface Entry {
  start: () => void;
  priority: () => boolean;
  state: 'waiting' | 'running' | 'done';
}

export class ConnectGate {
  private running = 0;
  private waiting: Entry[] = [];

  constructor(private readonly limit = 2) {}

  /** Runs `start` now if a slot is free, else when one frees — before older entries if `priority()` is then true. */
  enqueue(start: () => void, priority: () => boolean): GateTicket {
    const entry: Entry = { start, priority, state: 'waiting' };
    this.waiting.push(entry);
    this.pump();
    return {
      release: () => {
        if (entry.state === 'running') {
          entry.state = 'done';
          this.running -= 1;
          this.pump();
        } else if (entry.state === 'waiting') {
          entry.state = 'done';
          this.waiting = this.waiting.filter((e) => e !== entry);
        }
      },
    };
  }

  private pump() {
    while (this.running < this.limit && this.waiting.length > 0) {
      const i = Math.max(0, this.waiting.findIndex((e) => e.priority()));
      const [entry] = this.waiting.splice(i, 1);
      entry.state = 'running';
      this.running += 1;
      entry.start();
    }
  }
}

/** One per page: every terminal shares the browser's handshake queue for the host. */
export const terminalGate = new ConnectGate();
