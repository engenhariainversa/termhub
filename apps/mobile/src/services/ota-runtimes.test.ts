// The extra runtimes scripts/ota-publish.sh publishes to (ota-runtimes.js), and the runtime
// override app.config.js takes while it does.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { compatibleRuntimes } = require('../../ota-runtimes.js') as {
  compatibleRuntimes: (version: string, list?: { for: string; runtimes: string[] }) => string[];
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const appConfig = require('../../app.config.js') as (ctx: { config: object }) => { runtimeVersion: unknown };

describe('compatibleRuntimes', () => {
  it('lists the older runtimes when the app is at the version they were checked against', () => {
    expect(compatibleRuntimes('0.6.0', { for: '0.6.0', runtimes: ['0.5.0'] })).toEqual(['0.5.0']);
  });

  it('lists nothing once expo.version moves on', () => {
    expect(compatibleRuntimes('0.7.0', { for: '0.6.0', runtimes: ['0.5.0'] })).toEqual([]);
  });

  it('never repeats the current runtime', () => {
    expect(compatibleRuntimes('0.6.0', { for: '0.6.0', runtimes: ['0.6.0', '0.5.0'] })).toEqual(['0.5.0']);
  });
});

describe('app.config.js runtimeVersion', () => {
  const saved = process.env.OTA_RUNTIME_VERSION;
  afterEach(() => {
    if (saved === undefined) delete process.env.OTA_RUNTIME_VERSION;
    else process.env.OTA_RUNTIME_VERSION = saved;
  });

  it('follows expo.version by default', () => {
    delete process.env.OTA_RUNTIME_VERSION;
    expect(appConfig({ config: {} }).runtimeVersion).toEqual({ policy: 'appVersion' });
  });

  it('takes OTA_RUNTIME_VERSION while publishing to a compatible build', () => {
    process.env.OTA_RUNTIME_VERSION = '0.5.0';
    expect(appConfig({ config: {} }).runtimeVersion).toBe('0.5.0');
  });
});
