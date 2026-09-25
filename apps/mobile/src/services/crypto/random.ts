// `randomBytes` reads `globalThis.crypto.getRandomValues`: present in Node 22 (this test
// runtime) and, in the app, via the `react-native-get-random-values` polyfill imported in
// `index.ts`, the app's entry.
import { randomBytes } from '@noble/hashes/utils.js';
import { b64url } from './encoding';

export { randomBytes };

/** A random, URL-safe identifier (base64url of `bytes` random bytes). */
export const randomId = (bytes = 16): string => b64url(randomBytes(bytes));
