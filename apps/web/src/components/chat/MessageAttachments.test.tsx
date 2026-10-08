// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('MessageAttachments', () => {
  it('shows a file as a download chip with its size and status', () => {
    render(<MessageAttachments attachments={[att({ id: 'a1' }), att({ id: 'a2', name: 'clip.mp4', kind: 'video', status: 'pending' }), att({ id: 'a3', name: 'x.xlsx', kind: 'xlsx', status: 'failed', error_code: 'ATTACHMENT_INVALID' })]} />);

    const link = screen.getByRole('link', { name: /relatorio\.pdf/ }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/api/chat/attachments/a1');
    expect(link.getAttribute('download')).toBe('relatorio.pdf');
    // Three chips of 2048 bytes: every one says its size.
    expect(screen.getAllByText('2 KB')).toHaveLength(3);
    expect(screen.getByText('transcrevendo…')).toBeTruthy();
    expect(screen.getByText('falhou: arquivo inválido')).toBeTruthy();
  });

  it('a clip whose transcription was unavailable says why and can be tried again; one whisper could not decode cannot (TER-1035)', async () => {
    const retry = vi.spyOn(api.chat.attachments, 'retry').mockResolvedValue({ attachment: att({ id: 'c1', kind: 'audio', status: 'pending' }) });
    render(
      <MessageAttachments
        attachments={[
          att({ id: 'c1', name: 'audio.m4a', kind: 'audio', status: 'failed', error_code: 'TRANSCRIPTION_UNAVAILABLE', meta: { reason: 'refused' } }),
          att({ id: 'c2', name: 'ruim.m4a', kind: 'audio', status: 'failed', error_code: 'TRANSCRIPTION_FAILED' }),
        ]}
      />,
    );
    expect(screen.getByText('falhou: o serviço de transcrição recusou o acesso')).toBeTruthy();
    const buttons = screen.getAllByRole('button', { name: 'tentar de novo' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(retry).toHaveBeenCalledWith('c1');
    await waitFor(() => expect((screen.getByRole('button', { name: 'tentar de novo' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('a refused retry shows the server message next to the chip', async () => {
    vi.spyOn(api.chat.attachments, 'retry').mockRejectedValue(new Error('Este anexo não pode ser processado de novo'));
    render(<MessageAttachments attachments={[att({ id: 'c1', name: 'audio.m4a', kind: 'audio', status: 'failed', error_code: 'TRANSCRIPTION_UNAVAILABLE' })]} />);
    fireEvent.click(screen.getByRole('button', { name: 'tentar de novo' }));
    expect(await screen.findByText('Este anexo não pode ser processado de novo')).toBeTruthy();
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

  it('focuses Fechar in the viewer, keeps Tab inside, and returns focus to the thumbnail', () => {
    render(<MessageAttachments attachments={[att({ id: 'img1', name: 'foto.jpg', kind: 'image', mime: 'image/jpeg' })]} />);
    const thumb = screen.getByRole('button', { name: 'Abrir imagem foto.jpg' });
    thumb.focus();
    fireEvent.click(thumb);
    const close = screen.getByRole('button', { name: 'Fechar' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.click(close);
    expect(document.activeElement).toBe(thumb);

    fireEvent.click(thumb);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.activeElement).toBe(thumb);
  });

  it('reserves the fitted size of an image before it loads', () => {
    render(<MessageAttachments attachments={[att({ id: 'img1', name: 'foto.jpg', kind: 'image', mime: 'image/jpeg', meta: { width: 1600, height: 1200 } })]} />);
    const thumb = screen.getByRole('img', { name: 'foto.jpg' }) as HTMLImageElement;
    expect(thumb.style.width).toBe('240px');
    expect(thumb.style.height).toBe('180px');
  });

  it('keeps the old bounds when the image has no dimensions yet', () => {
    render(<MessageAttachments attachments={[att({ id: 'img1', name: 'foto.jpg', kind: 'image', mime: 'image/jpeg', meta: null })]} />);
    const thumb = screen.getByRole('img', { name: 'foto.jpg' }) as HTMLImageElement;
    expect(thumb.style.width).toBe('');
    expect(thumb.className).toContain('max-h-60');
  });

  it('plays a voice note, with its length, and folds its transcription away until asked', () => {
    // jsdom does not play media: play/pause only fire the events a browser would.
    const proto = HTMLMediaElement.prototype as unknown as { play: () => Promise<void>; pause: () => void };
    const { play, pause } = proto;
    proto.play = function (this: HTMLMediaElement) {
      this.dispatchEvent(new Event('play'));
      return Promise.resolve();
    };
    proto.pause = function (this: HTMLMediaElement) {
      this.dispatchEvent(new Event('pause'));
    };
    try {
      render(<MessageAttachments attachments={[att({ id: 'v1', name: 'audio.m4a', kind: 'audio', mime: 'audio/m4a', meta: { duration_s: 65 }, transcript: 'roda os testes' })]} />);

      expect(screen.getByText('1:05')).toBeTruthy();
      expect(document.querySelector('audio')?.getAttribute('src')).toBe('/api/chat/attachments/v1');
      fireEvent.click(screen.getByRole('button', { name: 'Reproduzir áudio' }));
      fireEvent.click(screen.getByRole('button', { name: 'Pausar áudio' }));
      expect(screen.getByRole('button', { name: 'Reproduzir áudio' })).toBeTruthy();

      expect(screen.queryByText('roda os testes')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Ver transcrição' }));
      expect(screen.getByText('roda os testes')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Ocultar transcrição' }));
      expect(screen.queryByText('roda os testes')).toBeNull();
    } finally {
      proto.play = play;
      proto.pause = pause;
    }
  });

  it('says a voice note is still being transcribed, with no transcription toggle yet', () => {
    render(<MessageAttachments attachments={[att({ id: 'v2', name: 'audio.m4a', kind: 'audio', status: 'pending' })]} />);

    expect(screen.getByText('transcrevendo…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ver transcrição' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reproduzir áudio' })).toBeTruthy();
  });
});
