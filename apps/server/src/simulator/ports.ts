/** Hash FNV-1a 32 bits (determinístico, sem dependências). */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface WdaPorts {
  wdaPort: number;
  mjpegPort: number;
}

/** Portas do WDA na máquina, derivadas do UDID (sem estado persistido). */
export function wdaPorts(udid: string): WdaPorts {
  const h = fnv1a(udid.toUpperCase()) % 100;
  return { wdaPort: 8100 + h, mjpegPort: 9100 + h };
}

/**
 * Pairs to try, in order, when the first one is taken on the machine (TER-983): the hash pair first,
 * then the next ones, wrapping inside 8100–8199 / 9100–9199.
 */
export function wdaPortCandidates(udid: string, count = 10): WdaPorts[] {
  const h = fnv1a(udid.toUpperCase()) % 100;
  return Array.from({ length: count }, (_, k) => {
    const off = (h + k) % 100;
    return { wdaPort: 8100 + off, mjpegPort: 9100 + off };
  });
}

export { runnerSessionName } from '@termhub/machine-ops';
