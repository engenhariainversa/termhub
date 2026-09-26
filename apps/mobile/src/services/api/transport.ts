// The transport port (design spec §4.1): the only thing `HttpMobileApi` talks to. `FetchTransport`
// is the one implementation that reaches a real server; `MockTransport` (a later task) answers the
// same shape from an in-memory "server", which is what makes `HttpMobileApi` testable without one.

export interface TransportFetchInput {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/** `headers` are lower-cased header names, so callers never need to guess the wire's casing. */
export interface TransportFetchResult {
  status: number;
  headers: Record<string, string>;
  text: string;
}

export interface TransportSocketHandlers {
  onOpen: () => void;
  onMessage: (text: string) => void;
  onClose: (code: number) => void;
}

export interface TransportSocket {
  close(): void;
}

/** What an upload answers: any HTTP status, with the body as text (the client decodes it). */
export interface TransportUploadResult {
  status: number;
  body: string;
}

export interface Transport {
  fetch(input: TransportFetchInput): Promise<TransportFetchResult>;
  connect(url: string, headers: Record<string, string>, handlers: TransportSocketHandlers): TransportSocket;
  /**
   * Streams the file at `fileUri` (a `file://` URI the recorder or a picker produced) as the raw body
   * of a `POST` to `url`, `Content-Type: mime`, with `headers` (bearer, DPoP, app header) on top —
   * the shape `routes/m-transcriptions.ts` and the attachment routes read. `onProgress` gets the
   * 0..1 fraction sent. Resolves for any HTTP status; rejects only when the file cannot be read or
   * the request itself fails.
   */
  upload(url: string, fileUri: string, mime: string, headers: Record<string, string>, onProgress?: (fraction: number) => void): Promise<TransportUploadResult>;
}

/**
 * `fetch`, React Native's `WebSocket` and `expo-file-system`'s upload task. `connect` and `upload` never run under Jest — the app talks
 * to `MockTransport` in every test; this class only needs to typecheck and to behave correctly on
 * a device.
 */
export class FetchTransport implements Transport {
  async fetch(input: TransportFetchInput): Promise<TransportFetchResult> {
    const response = await fetch(input.url, { method: input.method, headers: input.headers, body: input.body });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const text = await response.text();
    return { status: response.status, headers, text };
  }

  connect(url: string, headers: Record<string, string>, handlers: TransportSocketHandlers): TransportSocket {
    // React Native's `WebSocket(url, protocols, options)` accepts `{ headers }` as a third
    // constructor argument, for the upgrade request's headers — not part of the DOM `WebSocket`
    // typings this file compiles against, hence the cast through `unknown`.
    const RNWebSocket = WebSocket as unknown as new (url: string, protocols: undefined, options: { headers: Record<string, string> }) => WebSocket;
    const socket = new RNWebSocket(url, undefined, { headers });
    socket.onopen = () => handlers.onOpen();
    socket.onmessage = (event: MessageEvent) => handlers.onMessage(String(event.data));
    socket.onclose = (event: CloseEvent) => handlers.onClose(event.code);
    return { close: () => socket.close() };
  }

  async upload(url: string, fileUri: string, mime: string, headers: Record<string, string>, onProgress?: (fraction: number) => void): Promise<TransportUploadResult> {
    // Loaded on demand: `expo-file-system` reaches its native module at import time, and this file is
    // imported by the `logic` jest project (through `services/api/index.ts`), where none exists. Like
    // `connect`, this method itself only ever runs on a device — every test talks to `MockTransport`.
    const { File, UploadType } = await import('expo-file-system');
    const task = new File(fileUri).createUploadTask(url, {
      httpMethod: 'POST',
      uploadType: UploadType.BINARY_CONTENT,
      headers: { ...headers, 'Content-Type': mime },
      onProgress: ({ bytesSent, totalBytes }) => {
        if (onProgress && totalBytes > 0) onProgress(Math.min(1, bytesSent / totalBytes));
      },
    });
    const result = await task.uploadAsync();
    return { status: result.status, body: result.body };
  }
}
