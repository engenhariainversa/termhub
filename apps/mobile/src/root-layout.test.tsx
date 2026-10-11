import { render } from '@testing-library/react-native';

/** What the root stack was given: its defaults and the routes it configures by name. */
const mockStack: { screenOptions?: Record<string, unknown>; screens: { name: string; options: Record<string, unknown> }[] } = { screens: [] };
jest.mock('expo-router', () => {
  const Stack = ({ screenOptions, children }: { screenOptions?: Record<string, unknown>; children?: unknown }) => {
    mockStack.screenOptions = screenOptions;
    return children ?? null;
  };
  Stack.Screen = ({ name, options }: { name: string; options: Record<string, unknown> }) => {
    mockStack.screens.push({ name, options });
    return null;
  };
  return { Stack, useRouter: () => ({ push: jest.fn() }), useSegments: () => [] };
});
// The navigator's own behaviour (redirects, sheets) is not what this file is about.
jest.mock('@/features/session/view/use-phase-redirect', () => ({ usePhaseRedirect: () => undefined }));
jest.mock('@/features/session/view/pin-prompt-sheet', () => ({ PinPromptSheet: () => null }));
jest.mock('@/features/permissions/view/push-primer-sheet', () => ({ PushPrimerSheet: () => null }));

import RootLayout from '../app/_layout';

beforeEach(() => {
  mockStack.screenOptions = undefined;
  mockStack.screens = [];
});

describe('root stack (TER-849)', () => {
  it("the chat keeps the back swipe at the screen's edge only: a right drag inside the thread never leaves it", async () => {
    await render(<RootLayout />);
    const chat = mockStack.screens.find((s) => s.name === 'chat/[id]');
    // Left unset, iOS 26 turns on a back swipe from anywhere in the content: a right drag on a
    // confirmation or question card, which has no drag-to-answer of its own to claim it, left the chat.
    expect(chat?.options).toMatchObject({ fullScreenGestureEnabled: false });
    // The edge swipe itself stays on.
    expect(chat?.options.gestureEnabled).not.toBe(false);
  });

  it('every other screen keeps the platform default', async () => {
    await render(<RootLayout />);
    expect(mockStack.screenOptions).not.toHaveProperty('fullScreenGestureEnabled');
    expect(mockStack.screenOptions).not.toHaveProperty('gestureEnabled');
  });
});
