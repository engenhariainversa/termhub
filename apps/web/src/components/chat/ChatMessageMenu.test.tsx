// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatTurn } from './ChatTurn';
import type { ChatMessage } from '../../lib/types';

const copyText = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../../lib/clipboard', () => ({ copyText }));

const show = vi.hoisted(() => vi.fn());
vi.mock('../../lib/toast', () => ({ useOptionalToast: () => ({ show, dismiss: vi.fn() }) }));

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'm1', conversation_id: 'c1', role: 'assistant', text: 'Pronto: **testes** verdes. Veja [o PR](https://github.com/x/y/pull/1).', error_code: null, created_at: '2026-10-17T00:00:00.000Z', ...overrides };
}

function turn(m: ChatMessage, onReply = vi.fn()) {
  render(
    <ol>
      <ChatTurn message={m} waiting={false} failed={false} onReply={onReply} />
    </ol>,
  );
  return onReply;
}

const row = () => document.querySelector('li[data-message-id]') as HTMLElement;

beforeEach(() => {
  copyText.mockClear();
  show.mockClear();
});

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
});

describe('the message menu (TER-1090)', () => {
  it('a right click opens it with Copiar, Responder and the link items', () => {
    turn(message());
    fireEvent.contextMenu(row(), { clientX: 40, clientY: 50 });
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Copiar', 'Responder', 'Copiar link', 'Abrir link']);
  });

  it('"⋯" opens the same menu', () => {
    turn(message());
    fireEvent.click(screen.getByRole('button', { name: 'Mais ações da mensagem' }));
    expect(screen.getByRole('menu', { name: 'Ações da mensagem' })).toBeTruthy();
  });

  it('"Copiar" copies the answer as plain text, says "Copiado" and closes', async () => {
    turn(message());
    fireEvent.contextMenu(row());
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Copiar' }));
    });
    expect(copyText).toHaveBeenCalledWith('Pronto: testes verdes. Veja o PR (https://github.com/x/y/pull/1).');
    expect(show).toHaveBeenCalledWith({ id: 'chat-copy', title: 'Copiado' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('"Responder" answers the row', () => {
    const m = message();
    const onReply = turn(m);
    fireEvent.contextMenu(row());
    fireEvent.click(screen.getByRole('menuitem', { name: 'Responder' }));
    expect(onReply).toHaveBeenCalledWith(m);
  });

  it("copies the person's words as typed", async () => {
    turn(message({ role: 'user', text: 'meu **texto**' }));
    fireEvent.contextMenu(row());
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Copiar' }));
    });
    expect(copyText).toHaveBeenCalledWith('meu **texto**');
  });

  it('Escape closes it', () => {
    turn(message());
    fireEvent.contextMenu(row());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('text selected in the row keeps the browser menu', () => {
    turn(message({ role: 'user', text: 'selecione isto' }));
    const range = document.createRange();
    range.selectNodeContents(screen.getByText('selecione isto'));
    window.getSelection()?.addRange(range);
    const event = fireEvent.contextMenu(row());
    expect(event).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('an answer still being written has no menu', () => {
    render(
      <ol>
        <ChatTurn message={message({ text: '' })} waiting failed={false} />
      </ol>,
    );
    fireEvent.contextMenu(row());
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mais ações da mensagem' })).toBeNull();
  });
});
