// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatReplyQuote } from './ChatReplyQuote';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ChatReplyQuote (TER-447)', () => {
  it('shows who and what was quoted, and opens the original', () => {
    const onOpen = vi.fn(() => true);
    render(<ChatReplyQuote reply={{ id: 'm1', role: 'assistant', excerpt: 'Abri a aba build' }} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ver mensagem original: Concierge, Abri a aba build' }));
    expect(onOpen).toHaveBeenCalledWith('m1');
    expect(screen.queryByText('Mensagem original indisponível')).toBeNull();
  });

  it('says the original is unavailable for a while when it cannot be shown', () => {
    vi.useFakeTimers();
    const onOpen = vi.fn(() => false);
    render(<ChatReplyQuote reply={{ id: 'gone', role: 'user', excerpt: 'oi' }} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ver mensagem original: Você, oi' }));
    expect(screen.getByText('Mensagem original indisponível')).toBeTruthy();
    act(() => void vi.advanceTimersByTime(3000));
    expect(screen.queryByText('Mensagem original indisponível')).toBeNull();
  });

  it('links a URL in the excerpt, and a click on it does not open the original (TER-1089)', () => {
    const onOpen = vi.fn(() => true);
    render(<ChatReplyQuote reply={{ id: 'm1', role: 'assistant', excerpt: 'Abra https://termhub.dev/x.' }} onOpen={onOpen} />);
    const link = screen.getByRole('link', { name: 'https://termhub.dev/x' });
    expect(link.getAttribute('href')).toBe('https://termhub.dev/x');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    fireEvent.click(link);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('a deleted original is unavailable without asking the panel', () => {
    const onOpen = vi.fn(() => true);
    render(<ChatReplyQuote reply={{ id: null, role: 'assistant', excerpt: 'oi' }} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByText('Mensagem original indisponível')).toBeTruthy();
  });
});
