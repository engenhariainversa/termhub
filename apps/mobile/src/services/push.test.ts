import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { dismissDelivered, setIconBadge, expoPushToken, notificationStatus, pushConversationId, pushNotificationId, pushRoute, requestNotifications } from './push';

// A getter, so the switch reaches `push.ts` through Babel's namespace copy of the module.
jest.mock('expo-device', () => {
  let isDevice = true;
  return {
    get isDevice() {
      return isDevice;
    },
    __setIsDevice: (v: boolean) => {
      isDevice = v;
    },
  };
});

const config = Constants.expoConfig as { extra?: unknown };
const setIsDevice = (Device as unknown as { __setIsDevice(v: boolean): void }).__setIsDevice;
const notifications = Notifications as unknown as Record<string, jest.Mock>;

beforeEach(() => {
  config.extra = { eas: { projectId: 'project-1' } };
  setIsDevice(true);
  jest.clearAllMocks();
});

afterAll(() => {
  delete config.extra;
});

describe('expoPushToken', () => {
  it('creates the Android channel, then returns the token for the EAS project', async () => {
    expect(await expoPushToken()).toBe('ExponentPushToken[jest]');
    expect(notifications.setNotificationChannelAsync).toHaveBeenCalledWith('default', expect.objectContaining({ name: 'Notificações' }));
    expect(notifications.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'project-1' });
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('never asks for the permission: no token until it is granted (permission prompts spec §3.3)', async () => {
    notifications.getPermissionsAsync!.mockResolvedValueOnce({ status: 'undetermined' });
    expect(await expoPushToken()).toBeNull();
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
  });
});

describe('notification permission', () => {
  it('notificationStatus reads the OS status without prompting', async () => {
    notifications.getPermissionsAsync!.mockResolvedValueOnce({ status: 'denied' });
    expect(await notificationStatus()).toBe('denied');
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('requestNotifications creates the Android channel first, then prompts', async () => {
    notifications.requestPermissionsAsync!.mockResolvedValueOnce({ status: 'granted' });
    expect(await requestNotifications()).toBe('granted');
    const channel = notifications.setNotificationChannelAsync!.mock.invocationCallOrder[0]!;
    const prompt = notifications.requestPermissionsAsync!.mock.invocationCallOrder[0]!;
    expect(channel).toBeLessThan(prompt);
  });

  it('has no token on a simulator or without an EAS project id', async () => {
    setIsDevice(false);
    expect(await expoPushToken()).toBeNull();
    setIsDevice(true);
    config.extra = {};
    expect(await expoPushToken()).toBeNull();
    expect(notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
  });
});

it('pushConversationId reads data.conversation_id, and nothing else', () => {
  expect(pushConversationId({ kind: 'reply', conversation_id: 'c1', project_id: null })).toBe('c1');
  expect(pushConversationId({ kind: 'device_request' })).toBeNull();
  expect(pushConversationId({ conversation_id: '' })).toBeNull();
  expect(pushConversationId({ conversation_id: 42 })).toBeNull();
  expect(pushConversationId(null)).toBeNull();
});

it('pushNotificationId reads data.notification_id, when the server sent one', () => {
  expect(pushNotificationId({ kind: 'reply', conversation_id: 'c1', notification_id: 'n1' })).toBe('n1');
  expect(pushNotificationId({ kind: 'reply', conversation_id: 'c1' })).toBeNull();
});

it('pushRoute: the tab of an "aba terminou" push first, else the conversation, else nothing (TER-925)', () => {
  expect(pushRoute({ kind: 'tab_finished', tab_id: 't1', conversation_id: 'c1' })).toBe('/session/t1');
  expect(pushRoute({ kind: 'reply', conversation_id: 'c1' })).toBe('/chat/c1');
  expect(pushRoute({ kind: 'device_request' })).toBeNull();
  expect(pushRoute({ tab_id: '' , conversation_id: 'c1' })).toBe('/chat/c1');
});

it('pushRoute: an expired AI login opens its "Refazer login" modal (TER-1047)', () => {
  expect(pushRoute({ kind: 'ai_login', account_id: 'a1', notification_id: 'n1' })).toBe('/ai-login/a1');
  expect(pushRoute({ kind: 'ai_login' })).toBeNull();
  // Only that kind: an `account_id` elsewhere routes as before.
  expect(pushRoute({ kind: 'reply', account_id: 'a1', conversation_id: 'c1' })).toBe('/chat/c1');
});

describe('icon badge and notification center (TER-923)', () => {
  const presented = (identifier: string, data: unknown) => ({ request: { identifier, content: { data } } });

  it('setIconBadge never goes below 0 and never throws', async () => {
    await setIconBadge(-2);
    expect(notifications.setBadgeCountAsync).toHaveBeenLastCalledWith(0);
    notifications.setBadgeCountAsync!.mockRejectedValueOnce(new Error('native'));
    await expect(setIconBadge(3)).resolves.toBeUndefined();
  });

  it('dismissDelivered removes the pushes of read rows, or all of them', async () => {
    notifications.getPresentedNotificationsAsync!.mockResolvedValue([presented('x1', { notification_id: 'n1' }), presented('x2', { notification_id: 'n2' }), presented('x3', {})]);
    await dismissDelivered(new Set(['n2']));
    expect(notifications.dismissNotificationAsync!.mock.calls).toEqual([['x2']]);
    notifications.dismissNotificationAsync!.mockClear();
    await dismissDelivered('all');
    expect(notifications.dismissNotificationAsync!.mock.calls).toEqual([['x1'], ['x2'], ['x3']]);
    notifications.getPresentedNotificationsAsync!.mockRejectedValueOnce(new Error('native'));
    await expect(dismissDelivered('all')).resolves.toBeUndefined();
  });
});
