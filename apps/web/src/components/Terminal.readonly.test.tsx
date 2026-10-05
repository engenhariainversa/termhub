// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalConnectionHandlers } from '../lib/terminal-connection';

// TER-576: typing into a terminal takes terminals:write. Without it the terminal is watch-only.

const h = vi.hoisted(() => ({
  grants: new Set<string>(),
  terms: [] as Array<{ options: Record<string, unknown> }>,
  conns: [] as Array<{ handlers: TerminalConnectionHandlers; writable: boolean[] }>,
  pasteFile: vi.fn(),
}));

vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('@xterm/xterm', () => {
  const sub = { dispose: () => {} };
  class Terminal {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    modes = { mouseTrackingMode: 'none' };
    buffer = { active: { type: 'normal' } };
    parser = { registerCsiHandler: () => sub };
    constructor(opts: Record<string, unknown>) {
      this.options = { ...opts };
      h.terms.push(this);
    }
    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    attachCustomWheelEventHandler() {}
    onSelectionChange() {
      return sub;
    }
    onData() {
      return sub;
    }
    onResize() {
      return sub;
    }
    write() {}
    paste() {}
    focus() {}
    dispose() {}
    getSelection() {
      return '';
    }
  }
  return { Terminal };
});
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { onContextLoss() {} dispose() {} } }));
vi.mock('../lib/terminal-connection', () => ({
  TerminalConnection: class {
    canScroll = false;
    readonly = false;
    writable: boolean[] = [];
    constructor(
      _tabId: string,
      public handlers: TerminalConnectionHandlers,
    ) {
      h.conns.push(this);
    }
    setPriority() {}
    setWritable(w: boolean) {
      this.writable.push(w);
    }
    connect() {}
    send() {}
    sendResize() {}
    sendScroll() {}
    retryNow() {}
    close() {}
  },
}));
vi.mock('../lib/api', () => ({
  ApiError: class extends Error {},
  api: { transcriptions: { config: () => Promise.resolve({ enabled: true }) }, tabs: { pasteFile: h.pasteFile } },
}));
vi.mock('../lib/voice-recorder', () => ({
  MAX_RECORDING_MS: 300_000,
  VoiceRecorder: class {},
  canRecordVoice: () => true,
  micErrorMessage: () => '',
  resumeTranscription: vi.fn(),
  transcribeClip: vi.fn(),
}));
vi.mock('../lib/voice-store', () => ({ voiceStore: { load: () => Promise.resolve(null), clear: vi.fn(), update: vi.fn() } }));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ can: (r: string, a = 'read') => h.grants.has(`${r}:${a}`) }) }));

import { TerminalView } from './Terminal';

beforeEach(() => {
  h.terms = [];
  h.conns = [];
  h.pasteFile.mockReset();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const pasteImage = (container: HTMLElement) => {
  const target = container.querySelector('.bg-bg') as HTMLElement;
  const file = new File(['x'], 'shot.png', { type: 'image/png' });
  const ev = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
  ev.clipboardData = { files: [file], items: [], types: ['Files'] };
  target.dispatchEvent(ev);
};

describe('TerminalView and terminals:write', () => {
  it('a writer types, attaches files and dictates', async () => {
    h.grants = new Set(['terminals:read', 'terminals:write']);
    h.pasteFile.mockResolvedValue({ path: '/tmp/shot.png', bytes: 1, mime: 'image/png' });
    const { container } = render(<TerminalView tabId="t1" active />);
    expect(h.terms[0].options.disableStdin).toBe(false);
    expect(h.conns[0].writable.at(-1)).toBe(true);
    expect(await screen.findByLabelText('Ditar')).toBeInTheDocument();
    expect(screen.queryByText('Somente leitura')).not.toBeInTheDocument();
    pasteImage(container);
    await waitFor(() => expect(h.pasteFile).toHaveBeenCalledTimes(1));
  });

  it('a reader watches: stdin off, no input to the socket, no upload, no dictation, a badge', async () => {
    h.grants = new Set(['terminals:read', 'terminals:update']);
    const { container } = render(<TerminalView tabId="t1" active />);
    expect(h.terms[0].options.disableStdin).toBe(true);
    expect(h.conns[0].writable.at(-1)).toBe(false);
    expect(screen.getByText('Somente leitura')).toBeInTheDocument();
    pasteImage(container);
    fireEvent.dragEnter(container.querySelector('.bg-bg') as HTMLElement, { dataTransfer: { types: ['Files'], files: [] } });
    expect(screen.queryByText('Solte para anexar ao terminal')).not.toBeInTheDocument();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByLabelText('Ditar')).not.toBeInTheDocument();
    expect(h.pasteFile).not.toHaveBeenCalled();
  });

  it('goes read-only when the server says so in ready, even if the role looked writable here', async () => {
    h.grants = new Set(['terminals:read', 'terminals:write']);
    render(<TerminalView tabId="t1" active />);
    expect(screen.queryByText('Somente leitura')).not.toBeInTheDocument();
    act(() => h.conns[0].handlers.onReadonly?.(true));
    expect(screen.getByText('Somente leitura')).toBeInTheDocument();
    expect(h.terms[0].options.disableStdin).toBe(true);
  });
});
