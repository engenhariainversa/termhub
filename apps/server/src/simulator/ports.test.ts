import { describe, expect, it } from 'vitest';
import { fnv1a, runnerSessionName, wdaPorts, wdaPortCandidates } from './ports.js';

describe('ports', () => {
  it('fnv1a é determinístico e diferente para strings diferentes', () => {
    expect(fnv1a('abc')).toBe(fnv1a('abc'));
    expect(fnv1a('abc')).not.toBe(fnv1a('abd'));
  });

  it('portas ficam na faixa 8100-8199 / 9100-9199 e são estáveis', () => {
    const udid = 'BAE07EB5-8CA8-4C6E-819A-A0240342FF00';
    const p = wdaPorts(udid);
    expect(p.wdaPort).toBeGreaterThanOrEqual(8100);
    expect(p.wdaPort).toBeLessThan(8200);
    expect(p.mjpegPort - p.wdaPort).toBe(1000);
    expect(wdaPorts(udid.toLowerCase())).toEqual(p);
  });

  it('nome da sessão tmux usa os 8 primeiros chars do udid em minúsculas', () => {
    expect(runnerSessionName('BAE07EB5-8CA8-4C6E-819A-A0240342FF00')).toBe('termhub-wda-bae07eb5');
  });
});

describe('wdaPortCandidates', () => {
  const UDID = '8E4BF65A-8DEA-4044-9DAA-537559DBB669';

  it('starts with the pair wdaPorts gives, so runners from the previous release are found', () => {
    expect(wdaPortCandidates(UDID)[0]).toEqual(wdaPorts(UDID));
  });

  it('returns 10 distinct pairs that keep the 8100/9100 offset and wrap at 100', () => {
    const c = wdaPortCandidates(UDID);
    expect(c).toHaveLength(10);
    expect(new Set(c.map((p) => p.wdaPort)).size).toBe(10);
    for (const p of c) {
      expect(p.wdaPort).toBeGreaterThanOrEqual(8100);
      expect(p.wdaPort).toBeLessThan(8200);
      expect(p.mjpegPort - p.wdaPort).toBe(1000);
    }
  });

  it('wraps around after port 8199', () => {
    // This UDID hashes to 80: the 20th candidate wraps back to 8100.
    const c = wdaPortCandidates(UDID, 25);
    expect(c[19]).toEqual({ wdaPort: 8199, mjpegPort: 9199 });
    expect(c[20]).toEqual({ wdaPort: 8100, mjpegPort: 9100 });
  });
});
