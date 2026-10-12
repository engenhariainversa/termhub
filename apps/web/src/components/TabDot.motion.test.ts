import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The motion lives in a stylesheet jsdom never applies, so the rules themselves are what can be pinned. */
const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');

describe('TabDot motion (TER-1044)', () => {
  it('animates with transform and opacity: a ~1.5 s pulse, a slow blink and a turning ring', () => {
    expect(css).toMatch(/@keyframes tab-dot-pulse \{ 0%, 100% \{ transform: scale\(1\); opacity: 1; \} 50% \{ transform: scale\(1\.4\); opacity: 0\.55; \} \}/);
    expect(css).toMatch(/\.tab-dot-working \{ animation: tab-dot-pulse 1\.5s ease-in-out infinite; \}/);
    expect(css).toMatch(/\.tab-dot-blink \{ animation: tab-dot-blink 2s ease-in-out infinite; \}/);
    expect(css).toMatch(/\.tab-dot-ring \{ animation: tab-dot-ring 1\.2s linear infinite; \}/);
  });

  it('keeps only the colour for whoever asked the system for no motion', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.tab-dot-working, \.tab-dot-blink, \.tab-dot-ring \{ animation: none; \} \}/);
  });
});
