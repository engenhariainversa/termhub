import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { TChatAttachment } from '@/services/api/contract';
import { MessageAttachments } from './message-attachments';

// The store's `attachmentSource`: each call is a fresh DPoP proof, numbered so a test can tell them apart.
let signed = 0;
const mockAttachmentSource = jest.fn(async (id: string) => ({ uri: `https://termhub.dev/api/m/v1/chat/attachments/${id}`, headers: { Authorization: 'Bearer tok', DPoP: `proof-${++signed}` } }));
jest.mock('../viewmodel/useChatStore', () => ({
  useChatStore: (selector: (s: { attachmentSource: typeof mockAttachmentSource }) => unknown) => selector({ attachmentSource: mockAttachmentSource }),
}));

const image: TChatAttachment = { id: 'img1', name: 'foto.jpg', mime: 'image/jpeg', kind: 'image', bytes: 20, status: 'ready', error_code: null, meta: null, created_at: '2026-09-26T00:00:00.000Z' };

beforeEach(() => {
  signed = 0;
  mockAttachmentSource.mockClear();
});

describe('MessageAttachments images', () => {
  it('re-signs once on a failed load, then offers a tap that re-signs again', async () => {
    await render(<MessageAttachments attachments={[image]} />);
    const loaded = await screen.findByLabelText('foto.jpg');
    expect(loaded.props.source.headers.DPoP).toBe('proof-1');

    // A proof is single-use and short-lived: the first failure gets a fresh one on its own.
    await act(async () => fireEvent(loaded, 'error'));
    await waitFor(() => expect(mockAttachmentSource).toHaveBeenCalledTimes(2));
    const retried = await screen.findByLabelText('foto.jpg');
    expect(retried.props.source.headers.DPoP).toBe('proof-2');
    expect(screen.queryByRole('button', { name: 'Toque para recarregar' })).toBeNull();

    // The retry failed too: no loop, a placeholder the person can tap.
    await act(async () => fireEvent(retried, 'error'));
    expect(await screen.findByRole('button', { name: 'Toque para recarregar' })).toBeTruthy();
    expect(mockAttachmentSource).toHaveBeenCalledTimes(2);
    await fireEvent.press(screen.getByRole('button', { name: 'Toque para recarregar' }));
    await waitFor(() => expect(mockAttachmentSource).toHaveBeenCalledTimes(3));
    expect((await screen.findByLabelText('foto.jpg')).props.source.headers.DPoP).toBe('proof-3');
  });
});
