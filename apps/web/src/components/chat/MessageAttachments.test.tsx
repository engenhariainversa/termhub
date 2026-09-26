// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MessageAttachments } from './MessageAttachments';
import type { ChatAttachment } from '../../lib/types';

const att = (over: Partial<ChatAttachment> & { id: string }): ChatAttachment => ({
  name: 'relatorio.pdf',
  mime: 'application/pdf',
  kind: 'pdf',
  bytes: 2048,
  status: 'ready',
  error_code: null,
  meta: null,
  created_at: '2026-09-26T00:00:00.000Z',
  ...over,
});

afterEach(() => cleanup());

describe('MessageAttachments', () => {
  it('shows a file as a download chip with its size and status', () => {
    render(<MessageAttachments attachments={[att({ id: 'a1' }), att({ id: 'a2', name: 'clip.m4a', kind: 'audio', status: 'pending' }), att({ id: 'a3', name: 'x.xlsx', kind: 'xlsx', status: 'failed', error_code: 'ATTACHMENT_INVALID' })]} />);

    const link = screen.getByRole('link', { name: /relatorio\.pdf/ }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/api/chat/attachments/a1');
    expect(link.getAttribute('download')).toBe('relatorio.pdf');
    // Three chips of 2048 bytes: every one says its size.
    expect(screen.getAllByText('2 KB')).toHaveLength(3);
    expect(screen.getByText('transcrevendo…')).toBeTruthy();
    expect(screen.getByText('falhou: arquivo inválido')).toBeTruthy();
  });

  it('shows an image as a thumbnail that opens the viewer, which Escape closes', () => {
    render(<MessageAttachments attachments={[att({ id: 'img1', name: 'foto.jpg', kind: 'image', mime: 'image/jpeg' })]} />);

    const thumb = screen.getByRole('img', { name: 'foto.jpg' }) as HTMLImageElement;
    expect(thumb.getAttribute('src')).toBe('/api/chat/attachments/img1');
    expect(thumb.className).toContain('max-h-60');
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Abrir imagem foto.jpg' }));
    expect(screen.getByRole('dialog', { name: 'foto.jpg' })).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes the viewer from its button', () => {
    render(<MessageAttachments attachments={[att({ id: 'img1', name: 'foto.jpg', kind: 'image', mime: 'image/jpeg' })]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Abrir imagem foto.jpg' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
