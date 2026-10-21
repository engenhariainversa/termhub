import { FetchTransport } from './transport';

const mockUpload = jest.fn();
const mockCreateUploadTask = jest.fn((..._args: unknown[]) => ({ uploadAsync: mockUpload }));
// Installed binaries have this API even when they lack the newer File upload SharedObject.
jest.mock('expo-file-system/legacy', () => ({
  createUploadTask: (...args: unknown[]) => mockCreateUploadTask(...args),
  FileSystemUploadType: { BINARY_CONTENT: 0 },
  FileSystemSessionType: { FOREGROUND: 1 },
}));

beforeEach(() => { jest.clearAllMocks(); });

it.each(['image/png', 'audio/mp4'])('uploads %s with signed headers as raw bytes in the foreground', async (mime) => {
  mockUpload.mockResolvedValue({ status: 200, body: '{"path":"/tmp/file"}' });
  const progress = jest.fn();
  const headers = { Authorization: 'Bearer token', DPoP: 'proof', 'X-Termhub-App': 'ios/0.7.1+1' };
  await expect(new FetchTransport().upload('https://example.test/files', 'file:///cache/file', mime, headers, progress)).resolves.toEqual({ status: 200, body: '{"path":"/tmp/file"}' });
  expect(mockCreateUploadTask).toHaveBeenCalledWith('https://example.test/files', 'file:///cache/file', {
    httpMethod: 'POST', uploadType: 0, sessionType: 1, headers: { ...headers, 'Content-Type': mime },
  }, expect.any(Function));
  const callback = mockCreateUploadTask.mock.calls[0]![3] as (event: unknown) => void;
  callback({ totalBytesSent: 25, totalBytesExpectedToSend: 100 });
  expect(progress).toHaveBeenLastCalledWith(0.25);
  callback({ totalBytesSent: 120, totalBytesExpectedToSend: 100 });
  expect(progress).toHaveBeenLastCalledWith(1);
});

it('returns a server refusal for the API client to decode and does not retry an ambiguous network failure', async () => {
  mockUpload.mockResolvedValueOnce({ status: 503, body: '{"code":"MACHINE_OFFLINE"}' });
  await expect(new FetchTransport().upload('https://example.test/files', 'file:///x', 'audio/mp4', {})).resolves.toEqual({ status: 503, body: '{"code":"MACHINE_OFFLINE"}' });
  mockUpload.mockRejectedValueOnce(new Error('network failed'));
  await expect(new FetchTransport().upload('https://example.test/files', 'file:///x', 'image/png', {})).rejects.toThrow('network failed');
  expect(mockUpload).toHaveBeenCalledTimes(2);
});

it('a cancelled native upload rejects instead of treating an absent response as success', async () => {
  mockUpload.mockResolvedValueOnce(undefined);
  await expect(new FetchTransport().upload('https://example.test/files', 'file:///x', 'image/png', {})).rejects.toThrow('UPLOAD_CANCELLED');
});
