import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import type { Duplex } from 'node:stream';

/**
 * Outbound proxy support for the agent's WebSocket: an explicit HTTP proxy reached with
 * `CONNECT host:port`, picked from the same environment variables curl and npm read
 * (`https_proxy`/`HTTPS_PROXY` for wss://, `http_proxy`/`HTTP_PROXY` for ws://, `no_proxy`/
 * `NO_PROXY` to skip it). Written by hand instead of pulling in an agent library: the agent only
 * ever opens one kind of connection, and `ws` takes a `createConnection` hook directly.
 *
 * An extra CA for a TLS-inspecting proxy needs nothing here: Node reads `NODE_EXTRA_CA_CERTS` at
 * startup and adds it to the default trust store every TLS connection uses.
 */

type Env = Record<string, string | undefined>;

/** Environment variables `service install` copies into the unit/plist, in this order. */
export const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS'] as const;
export type ProxyEnvKey = (typeof PROXY_ENV_KEYS)[number];

export type ProxyEnv = Partial<Record<ProxyEnvKey, string>>;

/** True when a value in `env` carries a proxy password (`user:pass@host`). */
export function hasCredentials(env: ProxyEnv): boolean {
  return Object.values(env).some((v) => v !== undefined && /(^|\/\/)[^/@\s]*:[^/@\s]*@/.test(v));
}

/**
 * Writes a service definition (unit/plist) holding `env`; one that carries a proxy password is
 * made readable only by its owner, like the agent's config.
 */
export function writeServiceFile(file: string, content: string, env: ProxyEnv): void {
  fs.writeFileSync(file, content, 'utf8');
  if (hasCredentials(env)) fs.chmodSync(file, 0o600);
}

/** Lower case wins, the way curl reads them; an empty value counts as unset. */
function envValue(env: Env, name: string): string | undefined {
  const value = env[name.toLowerCase()] || env[name.toUpperCase()];
  return value?.trim() || undefined;
}

/** The proxy/CA variables set in `env`, under their upper-case names, for the service definition. */
export function proxyEnvFrom(env: Env = process.env): ProxyEnv {
  const out: ProxyEnv = {};
  for (const key of PROXY_ENV_KEYS) {
    const value = key === 'NODE_EXTRA_CA_CERTS' ? env[key]?.trim() || undefined : envValue(env, key);
    if (value) out[key] = value;
  }
  return out;
}

function isSecure(target: URL): boolean {
  return target.protocol === 'wss:' || target.protocol === 'https:';
}

function targetPort(target: URL): number {
  return Number(target.port) || (isSecure(target) ? 443 : 80);
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * Whether `NO_PROXY` exempts `host:port`. Entries are separated by commas or spaces; `*` matches
 * everything; a domain matches itself and its subdomains (`example.com`, `.example.com` and
 * `*.example.com` all do); `host:port` limits an entry to that port. CIDR ranges are not read.
 */
export function bypassesProxy(host: string, port: number, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  const h = stripBrackets(host.toLowerCase()).replace(/\.$/, '');
  for (const raw of noProxy.split(/[\s,]+/)) {
    let entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    let entryPort: number | undefined;
    const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
    if (bracketed) {
      entry = bracketed[1]!;
      if (bracketed[2]) entryPort = Number(bracketed[2]);
    } else if (entry.split(':').length === 2) {
      // One colon: `host:port`. More than one is a bare IPv6 address with no port.
      const [name, p] = entry.split(':');
      entry = name!;
      entryPort = Number(p);
    }
    if (entryPort !== undefined && entryPort !== port) continue;
    entry = entry.replace(/^\*?\./, '').replace(/\.$/, '');
    if (!entry) continue;
    if (h === entry || h.endsWith(`.${entry}`)) return true;
  }
  return false;
}

/**
 * The proxy to reach `target` through, or undefined to connect directly. Throws on a proxy
 * variable that is not an `http://` or `https://` URL (a SOCKS proxy, a typo), so the agent fails
 * with a message instead of silently going direct on a network that only lets the proxy out.
 */
export function proxyFor(target: URL, env: Env = process.env): URL | undefined {
  const raw = envValue(env, isSecure(target) ? 'https_proxy' : 'http_proxy');
  if (!raw) return undefined;
  if (bypassesProxy(target.hostname, targetPort(target), envValue(env, 'no_proxy'))) return undefined;
  let proxy: URL;
  try {
    proxy = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    throw new Error(`invalid proxy URL in ${isSecure(target) ? 'HTTPS_PROXY' : 'HTTP_PROXY'}`);
  }
  if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') {
    throw new Error(`unsupported proxy protocol ${proxy.protocol} (only http:// and https:// proxies are supported)`);
  }
  return proxy;
}

/** The proxy URL without its password, safe for logs and `doctor`. */
export function redactProxy(proxy: URL): string {
  const copy = new URL(proxy.href);
  if (copy.password) copy.password = '***';
  return copy.href.replace(/\/$/, '');
}

type ConnectOptions = tls.ConnectionOptions & { host?: string | null; port?: number | string | null; timeout?: number };
type OnCreate = (err: Error | null, socket?: Duplex) => void;

/**
 * A `createConnection` for `ws`/`http.request` that tunnels through `proxy`: opens the proxy
 * socket, sends `CONNECT`, waits for a 2xx, then hands back the raw tunnel (ws://) or a TLS
 * socket over it (wss://, verified against the target's name as usual). Answers through the
 * callback, which `http.ClientRequest` accepts when the hook returns nothing. `timeout` (ws sets it
 * to the handshake timeout) also bounds the CONNECT exchange, which runs before ws's own timer.
 */
export function proxyConnection(proxy: URL, secure: boolean) {
  return (options: ConnectOptions, oncreate: OnCreate): undefined => {
    const host = stripBrackets(String(options.host ?? 'localhost'));
    const port = Number(options.port) || (secure ? 443 : 80);
    const authority = `${net.isIPv6(host) ? `[${host}]` : host}:${port}`;
    const proxyHost = stripBrackets(proxy.hostname);
    const proxyPort = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);

    const socket: net.Socket =
      proxy.protocol === 'https:'
        ? tls.connect({ host: proxyHost, port: proxyPort, servername: net.isIP(proxyHost) ? undefined : proxyHost })
        : net.connect({ host: proxyHost, port: proxyPort });

    let done = false;
    let buffered = Buffer.alloc(0);
    const finish = (err: Error | null) => {
      if (done) return;
      done = true;
      socket.removeListener('readable', onReadable);
      socket.removeListener('error', onError);
      socket.removeListener('end', onEnd);
      socket.removeListener('timeout', onTimeout);
      socket.setTimeout(0);
      if (err) {
        socket.destroy();
        oncreate(err);
        return;
      }
      if (!secure) {
        oncreate(null, socket);
        return;
      }
      const { host: _h, port: _p, path: _path, timeout: _t, ...tlsOptions } = options as ConnectOptions & { path?: unknown };
      oncreate(null, tls.connect({ ...tlsOptions, socket, servername: options.servername ?? (net.isIP(host) ? undefined : host) }));
    };
    const onError = (err: Error) => finish(new Error(`proxy ${proxyHost}:${proxyPort}: ${err.message}`));
    const onEnd = () => finish(new Error(`proxy ${proxyHost}:${proxyPort} closed the connection during CONNECT`));
    const onTimeout = () => finish(new Error(`proxy ${proxyHost}:${proxyPort}: CONNECT timed out`));
    const onReadable = () => {
      let chunk: Buffer | null;
      while ((chunk = socket.read() as Buffer | null) !== null) buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end === -1) {
        if (buffered.length > 16 * 1024) finish(new Error(`proxy ${proxyHost}:${proxyPort}: response header too large`));
        return;
      }
      const statusLine = buffered.subarray(0, buffered.indexOf('\r\n')).toString('latin1');
      const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(statusLine)?.[1] ?? 0);
      if (status < 200 || status > 299) {
        finish(new Error(`proxy ${proxyHost}:${proxyPort} refused CONNECT ${authority}: ${statusLine || 'invalid response'}`));
        return;
      }
      const rest = buffered.subarray(end + 4);
      if (rest.length > 0) socket.unshift(rest);
      finish(null);
    };

    socket.on('readable', onReadable);
    socket.on('error', onError);
    socket.on('end', onEnd);
    if (options.timeout) socket.setTimeout(options.timeout, onTimeout);

    const headers = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
    if (proxy.username || proxy.password) {
      const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      headers.push(`Proxy-Authorization: Basic ${Buffer.from(credentials).toString('base64')}`);
    }
    socket.write(`${headers.join('\r\n')}\r\n\r\n`);
    return undefined;
  };
}
