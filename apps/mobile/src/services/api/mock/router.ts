// A tiny method+path router keyed on segments (`:id` captures) — enough for the dozen routes the
// mock answers (design spec §4.2), nothing more.
import type { MockState } from './state';

export interface MockContext {
  state: MockState;
  /** Milliseconds, the same clock `createMockTransport`'s `opts.now` supplies. */
  now: () => number;
  /** Lower-cased header names, exactly as `transport.ts` hands them down. */
  headers: Record<string, string>;
  body: unknown;
  params: Record<string, string>;
  query: Record<string, string>;
  /** The request's pathname, no query string. */
  path: string;
  /** `canonicalHtu(request URL's origin, path)` — what every DPoP proof in this request must have
   * signed, derived from the request's own origin rather than a fixed host. */
  htu: string;
}

/** What a route sees as `ctx.body` for an upload: the mock never reads the file (nothing here can);
 * it only knows where it is and what it claims to be. */
export interface MockUploadBody {
  upload: { file_uri: string; mime: string };
}

export function isUploadBody(body: unknown): body is MockUploadBody {
  if (typeof body !== 'object' || body === null || !('upload' in body)) return false;
  const upload = (body as { upload: unknown }).upload;
  return typeof upload === 'object' && upload !== null && typeof (upload as { file_uri?: unknown }).file_uri === 'string' && typeof (upload as { mime?: unknown }).mime === 'string';
}

export type RouteHandler = (ctx: MockContext) => { status: number; body: unknown };

interface RouteEntry {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

export class MockRouter {
  private readonly routes: RouteEntry[] = [];

  route(method: string, path: string, handler: RouteHandler): void {
    this.routes.push({ method, segments: path.split('/').filter(Boolean), handler });
  }

  match(method: string, pathname: string): { handler: RouteHandler; params: Record<string, string> } | null {
    const segments = pathname.split('/').filter(Boolean);
    for (const entry of this.routes) {
      if (entry.method !== method || entry.segments.length !== segments.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < segments.length; i++) {
        const routeSegment = entry.segments[i]!;
        const pathSegment = segments[i]!;
        if (routeSegment.startsWith(':')) {
          params[routeSegment.slice(1)] = decodeURIComponent(pathSegment);
        } else if (routeSegment !== pathSegment) {
          matched = false;
          break;
        }
      }
      if (matched) return { handler: entry.handler, params };
    }
    return null;
  }
}

export function createRouter(): MockRouter {
  return new MockRouter();
}
