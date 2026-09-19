import { describe, expect, it } from 'vitest';
import { monitorBus } from './bus.js';

describe('monitorBus', () => {
  it('takes more than 10 subscribers (WS clients + concurrent waits) without a MaxListeners warning', async () => {
    const warnings: Error[] = [];
    const onWarning = (w: Error) => warnings.push(w);
    process.on('warning', onWarning);
    const offs = Array.from({ length: 25 }, () => monitorBus.subscribe(() => {}));
    try {
      await new Promise((r) => setTimeout(r, 10)); // process warnings are emitted on a later tick
      expect(warnings.filter((w) => w.name === 'MaxListenersExceededWarning')).toEqual([]);
    } finally {
      offs.forEach((off) => off());
      process.off('warning', onWarning);
    }
  });
});
