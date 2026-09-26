import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import type { TChatAttachment } from '@/services/api/contract';
import { Composer } from './composer';

// The recorder is A9's; here the mic never records — the sheet's "Gravar áudio" is tested by state only.
const mockVoice = { state: 'idle' as import('../viewmodel/use-voice').VoiceState, seconds: 0, error: null as string | null, notice: null as string | null, start: jest.fn(), stop: jest.fn(), cancel: jest.fn() };
const mockRecorder = { state: 'idle' as const, seconds: 0, error: null, start: jest.fn(async () => undefined), stop: jest.fn(async () => null), cancel: jest.fn() };
jest.mock('../viewmodel/use-voice', () => ({
  useVoice: () => mockVoice,
  useRecorder: () => mockRecorder,
}));

const att = (over: Partial<TChatAttachment> & { id: string }): TChatAttachment => ({
  name: 'relatorio.pdf', mime: 'application/pdf', kind: 'pdf', bytes: 10, status: 'pending', error_code: null, meta: null, created_at: '2026-09-26T00:00:00.000Z', ...over,
});
const asset = (name: string, mimeType: string, size = 10) => ({ uri: `file:///tmp/${name}`, name, mimeType, size });

const documentPicker = DocumentPicker as jest.Mocked<typeof DocumentPicker>;
const imagePicker = ImagePicker as jest.Mocked<typeof ImagePicker>;

async function renderComposer(over: Partial<React.ComponentProps<typeof Composer>> = {}) {
  const props = {
    sending: false,
    onSend: jest.fn(async () => true),
    uploadAttachment: jest.fn(async () => att({ id: 'att1', status: 'ready' })),
    deleteAttachment: jest.fn(async () => undefined),
    ...over,
  };
  await render(<Composer {...props} />);
  return props;
}

async function pickFile(...assets: ReturnType<typeof asset>[]) {
  documentPicker.getDocumentAsync.mockResolvedValueOnce({ canceled: false, assets } as never);
  await fireEvent.press(screen.getByRole('button', { name: 'Anexar' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Arquivo' }));
}

beforeEach(() => {
  documentPicker.getDocumentAsync.mockReset().mockResolvedValue({ canceled: true, assets: null } as never);
  imagePicker.launchImageLibraryAsync.mockReset().mockResolvedValue({ canceled: true, assets: null } as never);
  mockVoice.state = 'idle';
  mockRecorder.cancel.mockClear();
});

describe('Composer attachments', () => {
  it('disables Enviar while a file uploads, says so, then sends the attachments and clears the chips', async () => {
    let resolveUpload!: (a: TChatAttachment) => void;
    const props = await renderComposer({ uploadAttachment: jest.fn(() => new Promise<TChatAttachment>((resolve) => (resolveUpload = resolve))) });

    await pickFile(asset('relatorio.pdf', 'application/pdf'));
    expect(await screen.findByText('relatorio.pdf')).toBeTruthy();
    expect(props.uploadAttachment).toHaveBeenCalledWith(expect.objectContaining({ uri: 'file:///tmp/relatorio.pdf', name: 'relatorio.pdf', mime: 'application/pdf', bytes: 10 }), expect.any(Function));
    await fireEvent.changeText(screen.getByLabelText('Mensagem'), 'leia isso');

    // Review Focus #2: nothing leaves while a chip is still on the wire.
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled();
    expect(screen.getByText('enviando anexo…')).toBeTruthy();

    await act(async () => resolveUpload(att({ id: 'att1', status: 'pending' })));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Enviar' })).toBeEnabled());
    expect(screen.getByText('processando…')).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(props.onSend).toHaveBeenCalledWith('leia isso', [att({ id: 'att1', status: 'pending' })]));
    await waitFor(() => expect(screen.queryByText('relatorio.pdf')).toBeNull());
  });

  it('sends a message that is attachments only, and keeps the chips when the send fails', async () => {
    const props = await renderComposer({ onSend: jest.fn(async () => false) });
    await pickFile(asset('relatorio.pdf', 'application/pdf'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Enviar' })).toBeEnabled());
    await fireEvent.press(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(props.onSend).toHaveBeenCalledWith('', [att({ id: 'att1', status: 'ready' })]));
    expect(screen.getByText('relatorio.pdf')).toBeTruthy();
  });

  it('refuses an unsupported file in the box without uploading, and ✕ removes an uploaded one server-side', async () => {
    const props = await renderComposer();
    await pickFile(asset('setup.exe', 'application/octet-stream'), asset('relatorio.pdf', 'application/pdf'));
    expect(await screen.findByText('Tipo de arquivo não suportado')).toBeTruthy();
    expect(props.uploadAttachment).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByRole('button', { name: 'Remover setup.exe' }));
    expect(screen.queryByText('setup.exe')).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Enviar' })).toBeEnabled());
    await fireEvent.press(screen.getByRole('button', { name: 'Remover relatorio.pdf' }));
    await waitFor(() => expect(props.deleteAttachment).toHaveBeenCalledWith('att1'));
    // Nothing typed and no chips: the one round button is the microphone again (A9's rule).
    expect(screen.queryByRole('button', { name: 'Enviar' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Ditar' })).toBeTruthy();
  });

  it('picks photos and videos from the gallery at quality 0.8 and shows an image chip with its thumbnail', async () => {
    imagePicker.launchImageLibraryAsync.mockResolvedValueOnce({ canceled: false, assets: [{ uri: 'file:///tmp/foto.jpg', fileName: 'foto.jpg', mimeType: 'image/jpeg', fileSize: 20, type: 'image', width: 10, height: 10 }] } as never);
    const props = await renderComposer({ uploadAttachment: jest.fn(async () => att({ id: 'img1', name: 'foto.jpg', kind: 'image', mime: 'image/jpeg', status: 'ready' })) });
    await fireEvent.press(screen.getByRole('button', { name: 'Anexar' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Foto ou vídeo' }));

    expect(imagePicker.launchImageLibraryAsync).toHaveBeenCalledWith(expect.objectContaining({ quality: 0.8, mediaTypes: ['images', 'videos'], allowsMultipleSelection: true }));
    expect(await screen.findByLabelText('foto.jpg')).toBeTruthy();
    expect(props.uploadAttachment).toHaveBeenCalledWith(expect.objectContaining({ name: 'foto.jpg', mime: 'image/jpeg' }), expect.any(Function));
  });

  it('offers audio recording in the sheet', async () => {
    await renderComposer();
    await fireEvent.press(screen.getByRole('button', { name: 'Anexar' }));
    expect(screen.getByRole('button', { name: 'Gravar áudio' })).toBeTruthy();
  });

  it('closing the sheet cancels a recording that may still be opening the microphone', async () => {
    await renderComposer();
    await fireEvent.press(screen.getByRole('button', { name: 'Anexar' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Cancelar' }));
    expect(mockRecorder.cancel).toHaveBeenCalledTimes(1);
  });

  it.each(['starting', 'recording', 'uploading', 'transcribing'] as const)('📎 is disabled while dictation is %s (one recorder at a time)', async (state) => {
    mockVoice.state = state;
    await renderComposer();
    expect(screen.getByRole('button', { name: 'Anexar' })).toBeDisabled();
  });

  it('a send clears only the chips it carried: one added while the send was in flight stays', async () => {
    let resolveSend!: (ok: boolean) => void;
    const props = await renderComposer({
      onSend: jest.fn(() => new Promise<boolean>((resolve) => (resolveSend = resolve))),
      uploadAttachment: jest.fn(async (file: { name: string }) => att({ id: file.name === 'b.pdf' ? 'att2' : 'att1', name: file.name, status: 'ready' })),
    });
    await pickFile(asset('relatorio.pdf', 'application/pdf'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Enviar' })).toBeEnabled());
    await fireEvent.press(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => expect(props.onSend).toHaveBeenCalledWith('', [att({ id: 'att1', status: 'ready' })]));

    await pickFile(asset('b.pdf', 'application/pdf'));
    expect(await screen.findByText('b.pdf')).toBeTruthy();
    await act(async () => resolveSend(true));
    await waitFor(() => expect(screen.queryByText('relatorio.pdf')).toBeNull());
    expect(screen.getByText('b.pdf')).toBeTruthy();
  });
});
