// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  initializeApp: vi.fn(() => ({ app: true })),
  initializeAnalytics: vi.fn(() => ({ analytics: true })),
  isSupported: vi.fn(async () => true),
  logEvent: vi.fn(),
  setAnalyticsCollectionEnabled: vi.fn(),
  setDefaultEventParameters: vi.fn(),
}));

vi.mock('firebase/app', () => ({ initializeApp: sdk.initializeApp }));
vi.mock('firebase/analytics', () => ({
  initializeAnalytics: sdk.initializeAnalytics,
  isSupported: sdk.isSupported,
  logEvent: sdk.logEvent,
  setAnalyticsCollectionEnabled: sdk.setAnalyticsCollectionEnabled,
  setDefaultEventParameters: sdk.setDefaultEventParameters,
}));

const ENV = {
  VITE_FIREBASE_API_KEY: 'key',
  VITE_FIREBASE_PROJECT_ID: 'proj',
  VITE_FIREBASE_APP_ID: 'app',
  VITE_FIREBASE_MEASUREMENT_ID: 'G-1',
};

function stubEnv(values: Record<string, string>) {
  for (const [k, v] of Object.entries(values)) vi.stubEnv(k, v);
}

async function load() {
  vi.resetModules();
  return import('./analytics');
}

/** initAnalytics defers the SDK load to an idle callback; run it and let the promises settle. */
async function settle() {
  await vi.runAllTimersAsync();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('DEV', false);
  // jsdom has no requestIdleCallback: the module falls back to setTimeout, covered by fake timers
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('pagePath', () => {
  it('replaces project ids so page_view never carries an identifier', async () => {
    const { pagePath } = await load();
    expect(pagePath('/projects/ck9x2abc')).toBe('/projects/:id');
    expect(pagePath('/projects/ck9x2abc/terminals')).toBe('/projects/:id/terminals');
  });

  it('replaces card refs and office project ids', async () => {
    const { pagePath } = await load();
    expect(pagePath('/project/TER-583')).toBe('/project/:ref');
    expect(pagePath('/office/ck9x2abc')).toBe('/office/:projectId');
    expect(pagePath('/office')).toBe('/office');
  });

  it('leaves paths without ids untouched', async () => {
    const { pagePath } = await load();
    expect(pagePath('/')).toBe('/');
    expect(pagePath('/settings/users')).toBe('/settings/users');
  });
});

describe('without VITE_FIREBASE_* config', () => {
  it('is disabled and never touches the SDK', async () => {
    const a = await load();
    expect(a.ANALYTICS_ENABLED).toBe(false);
    a.initAnalytics();
    a.track('login');
    await settle();
    expect(sdk.initializeApp).not.toHaveBeenCalled();
    expect(sdk.logEvent).not.toHaveBeenCalled();
  });
});

describe('with config', () => {
  beforeEach(() => stubEnv(ENV));

  it('is disabled under vite dev even with config', async () => {
    vi.stubEnv('DEV', true);
    const a = await load();
    expect(a.ANALYTICS_ENABLED).toBe(false);
  });

  it('does not log before initAnalytics (no consent yet)', async () => {
    const a = await load();
    a.track('login');
    await settle();
    expect(sdk.logEvent).not.toHaveBeenCalled();
  });

  it('initialises the SDK once and logs events after init', async () => {
    const a = await load();
    a.initAnalytics();
    a.initAnalytics();
    a.track('login');
    await settle();
    expect(sdk.initializeApp).toHaveBeenCalledTimes(1);
    expect(sdk.initializeApp).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'key', measurementId: 'G-1' }));
    expect(sdk.logEvent).toHaveBeenCalledWith({ analytics: true }, 'login', undefined);
  });

  it('turns off the automatic page_view and starts on the normalised location', async () => {
    const a = await load();
    a.trackPageView('/project/TER-1'); // before consent: nothing is sent, but the route is kept
    a.initAnalytics();
    await settle();
    expect(sdk.logEvent).not.toHaveBeenCalled();
    expect(sdk.initializeAnalytics).toHaveBeenCalledWith(
      { app: true },
      { config: { send_page_view: false, page_location: `${window.location.origin}/project/:ref` } },
    );
  });

  it('sends page_view with the normalised path and location', async () => {
    const a = await load();
    a.initAnalytics();
    a.trackPageView('/projects/abc/terminals');
    await settle();
    const page_location = `${window.location.origin}/projects/:id/terminals`;
    expect(sdk.logEvent).toHaveBeenCalledWith({ analytics: true }, 'page_view', { page_path: '/projects/:id/terminals', page_location });
    expect(sdk.setDefaultEventParameters).toHaveBeenCalledWith({ page_location });
  });

  it('stops collecting and logging once consent is withdrawn', async () => {
    const a = await load();
    a.initAnalytics();
    await settle();
    a.disableAnalytics();
    a.track('login');
    await settle();
    expect(sdk.setAnalyticsCollectionEnabled).toHaveBeenCalledWith({ analytics: true }, false);
    expect(sdk.logEvent).not.toHaveBeenCalled();
  });

  it('collects again when consent is granted after a withdrawal', async () => {
    const a = await load();
    a.initAnalytics();
    await settle();
    a.disableAnalytics();
    await settle();
    a.initAnalytics();
    a.track('login');
    await settle();
    expect(sdk.setAnalyticsCollectionEnabled).toHaveBeenLastCalledWith({ analytics: true }, true);
    expect(sdk.logEvent).toHaveBeenCalledWith({ analytics: true }, 'login', undefined);
  });
});
