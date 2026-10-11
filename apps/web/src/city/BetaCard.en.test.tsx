// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../i18n';
import { BetaCard } from './BetaCard';
import { liveLine } from './share/compose';

const fetchMock = vi.fn();

beforeEach(() => {
  void i18n.changeLanguage('en');
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  void i18n.changeLanguage('pt-BR');
});

describe('the public city in English', () => {
  it('invites the visitor in English and signs them up with the English locale', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, already: false }), { status: 201 }));
    render(<BetaCard ownerName="Pedro" />);
    expect(screen.getByText("You are watching Pedro's AI agents work live — each robot is a real terminal.")).toBeInTheDocument();
    expect(screen.getByText('All your machines and agents in one place.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ana' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Souza' } });
    fireEvent.change(screen.getByLabelText('Email (Gmail)'), { target: { value: 'ana@gmail.com' } });
    fireEvent.change(screen.getByLabelText('Area code'), { target: { value: '11' } });
    fireEvent.change(screen.getByLabelText('number'), { target: { value: '987654321' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join the free beta' }));
    expect(await screen.findByText('Sign-up received.')).toBeInTheDocument();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).locale).toBe('en');
  });

  it('writes the share images in English, with plurals', () => {
    expect(liveLine(1, 0)).toBe('1 agent working right now');
    expect(liveLine(3, 2)).toBe('3 agents working right now · 2 waiting for you');
    expect(liveLine(0, 0)).toBe('No agents working right now');
  });
});
