import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The motion lives in a stylesheet jsdom never applies, so the rule itself is what can be pinned. */
const css = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');

describe('.chat-enter', () => {
  it('fades and slides a row in over 150 ms, once, when it mounts', () => {
    expect(css).toMatch(/@keyframes chat-enter \{ from \{ opacity: 0; transform: translateY\(4px\); \} to \{ opacity: 1; transform: translateY\(0\); \} \}/);
    expect(css).toMatch(/\.chat-enter \{ animation: chat-enter 150ms ease-out; \}/);
  });

  it('is disabled for whoever asked the system for no motion', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.chat-enter \{ animation: none; \} \}/);
  });
});
