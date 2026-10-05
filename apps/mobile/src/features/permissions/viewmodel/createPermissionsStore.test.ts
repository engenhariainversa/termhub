// The permissions store (permission prompts spec §3.2) over fake OS services.
import { appForegrounded, messageSent, pushGranted, sessionEnded, sessionStarted } from '@/features/shared/signals';
import type { PermissionsDeps } from '../model/permissions.types';
import { createPermissionsStore, MAX_PUSH_PRIMER_DISMISSALS, showAdCard } from './createPermissionsStore';

function fakeDeps(over: Partial<PermissionsDeps> = {}) {
  return {
    platform: 'ios',
    notificationStatus: jest.fn(async () => 'undetermined'),
    requestNotifications: jest.fn(async () => 'granted'),
    trackingStatus: jest.fn(async () => 'undetermined'),
    requestTracking: jest.fn(async () => 'authorized'),
    setAdConsent: jest.fn(async () => undefined),
    openSystemSettings: jest.fn(async () => undefined),
    ...over,
  } as jest.Mocked<PermissionsDeps>;
}

const flush = () => new Promise<void>((r) => setImmediate(r));

beforeEach(() => sessionEnded.emit()); // clears the MMKV-backed state of earlier tests' stores

describe('notification primer', () => {
  it('opens on the first message the server accepted only', async () => {
    const deps = fakeDeps();
    const store = createPermissionsStore(deps);
    messageSent.emit();
    await flush();
    expect(store.getState().pushPrimerOpen).toBe(true);
    store.getState().dismissPush();
    messageSent.emit();
    await flush();
    expect(store.getState().pushPrimerOpen).toBe(false);
    expect(store.getState().firstMessageSent).toBe(true);
  });

  it('a decided status never opens it', async () => {
    for (const status of ['granted', 'denied'] as const) {
      const store = createPermissionsStore(fakeDeps({ notificationStatus: jest.fn(async () => status) }));
      await store.getState().maybeOpenPushPrimer();
      expect(store.getState().pushPrimerOpen).toBe(false);
    }
  });

  it(`stops after ${MAX_PUSH_PRIMER_DISMISSALS} dismissals`, async () => {
    const store = createPermissionsStore(fakeDeps());
    for (let i = 0; i < MAX_PUSH_PRIMER_DISMISSALS; i++) {
      await store.getState().maybeOpenPushPrimer();
      expect(store.getState().pushPrimerOpen).toBe(true);
      store.getState().dismissPush();
    }
    await store.getState().maybeOpenPushPrimer();
    expect(store.getState().pushPrimerOpen).toBe(false);
  });

  it('accept prompts, and a grant emits pushGranted', async () => {
    const deps = fakeDeps();
    const store = createPermissionsStore(deps);
    const granted = jest.fn();
    const off = pushGranted.subscribe(granted);
    await store.getState().maybeOpenPushPrimer();
    await store.getState().acceptPush();
    expect(store.getState()).toMatchObject({ pushPrimerOpen: false, notificationStatus: 'granted' });
    expect(granted).toHaveBeenCalledTimes(1);

    deps.requestNotifications.mockResolvedValueOnce('denied');
    await store.getState().acceptPush();
    expect(granted).toHaveBeenCalledTimes(1);
    off();
  });
});

describe('ad consent', () => {
  it('is unknown by default, and the card shows only once a status allows asking', async () => {
    const store = createPermissionsStore(fakeDeps());
    expect(store.getState().adConsent).toBe('unknown');
    expect(showAdCard(store.getState())).toBe(false); // status not read yet
    await store.getState().refreshStatuses();
    expect(showAdCard(store.getState())).toBe(true);
  });

  it('iOS: granted only when ATT authorizes', async () => {
    const deps = fakeDeps();
    const store = createPermissionsStore(deps);
    await store.getState().acceptAds();
    expect(store.getState().adConsent).toBe('granted');
    expect(deps.setAdConsent).toHaveBeenLastCalledWith(true);

    const denied = fakeDeps({ requestTracking: jest.fn(async () => 'denied') });
    const other = createPermissionsStore(denied);
    await other.getState().acceptAds();
    expect(other.getState().adConsent).toBe('denied');
    expect(denied.setAdConsent).toHaveBeenLastCalledWith(false);
  });

  it('Android: our own accept grants, with no system prompt', async () => {
    const deps = fakeDeps({ platform: 'android', trackingStatus: jest.fn(async () => 'unavailable') });
    const store = createPermissionsStore(deps);
    await store.getState().refreshStatuses();
    expect(showAdCard(store.getState())).toBe(true);
    await store.getState().acceptAds();
    expect(deps.requestTracking).not.toHaveBeenCalled();
    expect(store.getState().adConsent).toBe('granted');
    expect(showAdCard(store.getState())).toBe(false);
  });

  it('decline stores denied and tells Firebase', async () => {
    const deps = fakeDeps();
    const store = createPermissionsStore(deps);
    await store.getState().declineAds();
    expect(store.getState().adConsent).toBe('denied');
    expect(deps.setAdConsent).toHaveBeenLastCalledWith(false);
    expect(deps.requestTracking).not.toHaveBeenCalled();
  });

  it('settings on with ATT denied opens system settings and changes nothing', async () => {
    const deps = fakeDeps({ trackingStatus: jest.fn(async () => 'denied') });
    const store = createPermissionsStore(deps);
    await store.getState().declineAds();
    await store.getState().setAdsFromSettings(true);
    expect(deps.openSystemSettings).toHaveBeenCalledTimes(1);
    expect(deps.requestTracking).not.toHaveBeenCalled();
    expect(store.getState().adConsent).toBe('denied');
  });

  it('settings on with ATT undetermined asks; off declines', async () => {
    const deps = fakeDeps();
    const store = createPermissionsStore(deps);
    await store.getState().setAdsFromSettings(true);
    expect(store.getState().adConsent).toBe('granted');
    await store.getState().setAdsFromSettings(false);
    expect(store.getState().adConsent).toBe('denied');
    expect(deps.setAdConsent).toHaveBeenLastCalledWith(false);
  });

  it('syncAdConsent downgrades a grant iOS no longer authorizes, then re-applies it, on every session start', async () => {
    const deps = fakeDeps();
    const store = createPermissionsStore(deps);
    await store.getState().acceptAds();
    deps.trackingStatus.mockResolvedValue('denied');
    sessionStarted.emit();
    await flush();
    expect(store.getState().adConsent).toBe('denied');
    expect(deps.setAdConsent).toHaveBeenLastCalledWith(false);
  });

  it('an unknown consent is applied as denied at session start', async () => {
    const deps = fakeDeps();
    createPermissionsStore(deps);
    sessionStarted.emit();
    await flush();
    expect(deps.setAdConsent).toHaveBeenLastCalledWith(false);
  });
});

it('persists the choices, and a session end forgets them', async () => {
  const store = createPermissionsStore(fakeDeps());
  await store.getState().declineAds();
  store.getState().dismissPush();
  const again = createPermissionsStore(fakeDeps());
  expect(again.getState()).toMatchObject({ adConsent: 'denied', pushPrimerDismissals: 1, pushPrimerOpen: false });

  const deps = fakeDeps();
  createPermissionsStore(deps);
  sessionEnded.emit();
  expect(again.getState()).toMatchObject({ adConsent: 'unknown', pushPrimerDismissals: 0, firstMessageSent: false });
  expect(deps.setAdConsent).toHaveBeenLastCalledWith(false);
});

it('a failing status read keeps the statuses already known', async () => {
  const deps = fakeDeps({ notificationStatus: jest.fn(async () => 'granted'), trackingStatus: jest.fn(async () => 'denied') });
  const store = createPermissionsStore(deps);
  await store.getState().refreshStatuses();
  const boom = async () => {
    throw new Error('native');
  };
  deps.notificationStatus.mockImplementation(boom);
  deps.trackingStatus.mockImplementation(boom);
  await store.getState().refreshStatuses();
  await store.getState().maybeOpenPushPrimer();
  expect(store.getState()).toMatchObject({ notificationStatus: 'granted', trackingStatus: 'denied' });
});

it('Android: settings on grants with no ATT call', async () => {
  const deps = fakeDeps({ platform: 'android' });
  const store = createPermissionsStore(deps);
  await store.getState().setAdsFromSettings(true);
  expect(store.getState().adConsent).toBe('granted');
  expect(deps.requestTracking).not.toHaveBeenCalled();
  expect(deps.trackingStatus).not.toHaveBeenCalled();
});

it('iOS: syncAdConsent keeps a grant when the tracking read fails', async () => {
  const deps = fakeDeps();
  const store = createPermissionsStore(deps);
  await store.getState().acceptAds();
  deps.trackingStatus.mockRejectedValue(new Error('native'));
  await store.getState().syncAdConsent();
  expect(store.getState().adConsent).toBe('granted');
  expect(deps.setAdConsent).toHaveBeenLastCalledWith(true);
});

it('native failures leave the state as it was and never throw', async () => {
  const boom = jest.fn(async () => {
    throw new Error('native');
  });
  const store = createPermissionsStore(fakeDeps({ notificationStatus: boom, requestNotifications: boom, trackingStatus: boom, requestTracking: boom, setAdConsent: boom, openSystemSettings: boom }));
  await expect(store.getState().maybeOpenPushPrimer()).resolves.toBeUndefined();
  expect(store.getState().pushPrimerOpen).toBe(false);
  await expect(store.getState().acceptPush()).resolves.toBeUndefined();
  await expect(store.getState().acceptAds()).resolves.toBeUndefined();
  expect(store.getState().adConsent).toBe('denied');
  await expect(store.getState().syncAdConsent()).resolves.toBeUndefined();
  await expect(store.getState().setAdsFromSettings(true)).resolves.toBeUndefined();
});

it('exposes the platform it was built for', () => {
  expect(createPermissionsStore(fakeDeps({ platform: 'android' })).getState().platform).toBe('android');
});

describe('notifications turned on outside the app (TER-921)', () => {
  it('back in the foreground, a status that became granted emits pushGranted once', async () => {
    const deps = fakeDeps({ notificationStatus: jest.fn(async () => 'denied') });
    const store = createPermissionsStore(deps);
    await store.getState().refreshStatuses();
    const granted = jest.fn();
    const off = pushGranted.subscribe(granted);
    deps.notificationStatus.mockImplementation(async () => 'granted');
    appForegrounded.emit();
    await flush();
    expect(store.getState().notificationStatus).toBe('granted');
    expect(granted).toHaveBeenCalledTimes(1);
    // Already granted: coming back again registers nothing new.
    appForegrounded.emit();
    await flush();
    expect(granted).toHaveBeenCalledTimes(1);
    off();
  });

  it('the first read (status not known yet) never emits: the session start registers', async () => {
    const deps = fakeDeps({ notificationStatus: jest.fn(async () => 'granted') });
    const store = createPermissionsStore(deps);
    const granted = jest.fn();
    const off = pushGranted.subscribe(granted);
    await store.getState().refreshStatuses();
    expect(granted).not.toHaveBeenCalled();
    off();
  });

  it('still denied or undetermined emits nothing', async () => {
    const deps = fakeDeps({ notificationStatus: jest.fn(async () => 'undetermined') });
    const store = createPermissionsStore(deps);
    await store.getState().refreshStatuses();
    const granted = jest.fn();
    const off = pushGranted.subscribe(granted);
    deps.notificationStatus.mockImplementation(async () => 'denied');
    appForegrounded.emit();
    await flush();
    expect(granted).not.toHaveBeenCalled();
    off();
  });
});
