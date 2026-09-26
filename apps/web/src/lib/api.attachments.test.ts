// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';

/** Just enough of XMLHttpRequest for `upload()`: records what was opened and sent, and lets a test answer. */
class FakeXhr {
  static instances: FakeXhr[] = [];
  upload = { onprogress: null as null | ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) };
  status = 0;
  responseText = '';
  responseType = '';
  withCredentials = false;
  onload: null | (() => void) = null;
  onerror: null | (() => void) = null;
  onabort: null | (() => void) = null;
  opened: [string, string] | null = null;
  headers: Record<string, string> = {};
  sent: unknown = null;
  aborted = false;
  constructor() {
    FakeXhr.instances.push(this);
  }
  open(method: string, url: string) {
    this.opened = [method, url];
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.sent = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
}

beforeEach(() => {
  FakeXhr.instances = [];
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api.chat.attachments', () => {
  it('posts the raw file with its name and project in the query, and reports progress', async () => {
    const progress: number[] = [];
    const file = new File([new Uint8Array(4)], 'relatório final.pdf', { type: 'application/pdf' });
    const promise = api.chat.attachments.upload(file, 'relatório final.pdf', 'p1', (f) => progress.push(f));
    const xhr = FakeXhr.instances[0];
    expect(xhr.opened).toEqual(['POST', '/api/chat/attachments?name=relat%C3%B3rio%20final.pdf&project_id=p1']);
    expect(xhr.headers['content-type']).toBe('application/octet-stream');
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 2, total: 4 });
    xhr.status = 201;
    xhr.responseText = JSON.stringify({ attachment: { id: 'att1' } });
    xhr.onload?.();
    await expect(promise).resolves.toEqual({ attachment: { id: 'att1' } });
    expect(progress).toEqual([0.5]);
  });

  it('omits project_id for the account-wide chat', () => {
    void api.chat.attachments.upload(new Blob(['x']), 'a.txt', null);
    expect(FakeXhr.instances[0].opened).toEqual(['POST', '/api/chat/attachments?name=a.txt']);
  });

  it('aborts the request when the signal fires, and rejects as ABORTED', async () => {
    const controller = new AbortController();
    const promise = api.chat.attachments.upload(new Blob(['x']), 'a.txt', null, undefined, controller.signal);
    controller.abort();
    expect(FakeXhr.instances[0].aborted).toBe(true);
    await expect(promise).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('never opens a request for a signal that is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(api.chat.attachments.upload(new Blob(['x']), 'a.txt', null, undefined, controller.signal)).rejects.toBeInstanceOf(ApiError);
    expect(FakeXhr.instances).toHaveLength(0);
  });

  it('turns a refusal into an ApiError with the server code and message', async () => {
    const promise = api.chat.attachments.upload(new Blob(['x']), 'a.exe', null);
    const xhr = FakeXhr.instances[0];
    xhr.status = 415;
    xhr.responseText = JSON.stringify({ error: 'Tipo de arquivo não suportado', code: 'ATTACHMENT_TYPE' });
    xhr.onload?.();
    await expect(promise).rejects.toMatchObject({ status: 415, code: 'ATTACHMENT_TYPE', message: 'Tipo de arquivo não suportado' });
  });

  it('knows the download url, and the conversation read still works as a function', () => {
    expect(api.chat.attachments.url('att 1')).toBe('/api/chat/attachments/att%201');
    expect(typeof api.chat).toBe('function');
  });
});

describe('api.sendChatMessage', () => {
  const sent = () => JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as Record<string, unknown>;
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ conversation_id: 'c1', user_message_id: 'mu', assistant_message_id: 'ma' }), { status: 202 }));

  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('carries the attachment ids only when there are any, and the project only when there is one, never waiting for the answer', async () => {
    await api.sendChatMessage('leia', 'p1', ['att1', 'att2']);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/chat/messages');
    expect(sent()).toEqual({ text: 'leia', project_id: 'p1', attachment_ids: ['att1', 'att2'], wait: false });

    fetchMock.mockClear();
    await api.sendChatMessage('', null, ['att1']);
    expect(sent()).toEqual({ text: '', attachment_ids: ['att1'], wait: false });

    fetchMock.mockClear();
    await api.sendChatMessage('oi', 'p1', []);
    expect(sent()).toEqual({ text: 'oi', project_id: 'p1', wait: false });

    fetchMock.mockClear();
    await api.sendChatMessage('oi');
    expect(sent()).toEqual({ text: 'oi', wait: false });
  });
});
