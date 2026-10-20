import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import { Linking, Share, Text } from 'react-native';
import { State } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';
import { canCopy, copyToClipboard } from '@/services/clipboard';
import { ToastHost } from '@/ui/toast';
import { menuLayout, MessageMenu } from './message-menu';

jest.mock('@/services/clipboard', () => ({ canCopy: jest.fn(() => true), copyToClipboard: jest.fn(async () => true) }));

// The row's place on the screen, as the native side would measure it.
const nativeMethods = require('@react-native/jest-preset/jest/MockNativeMethods').default as { measureInWindow: jest.Mock };

const answer = { role: 'assistant' as const, text: 'Pronto: **testes** verdes. Veja [o PR](https://github.com/x/y/pull/1).' };

async function hold() {
  await act(async () => {
    fireGestureHandler(getByGestureTestId('message-menu-hold'), [{ state: State.BEGAN }, { state: State.ACTIVE }, { state: State.END }]);
  });
}

async function choose(label: string) {
  await act(async () => {
    fireEvent.press(screen.getByRole('menuitem', { name: label }));
  });
}

beforeEach(() => {
  nativeMethods.measureInWindow.mockImplementation((cb: (x: number, y: number, w: number, h: number) => void) => cb(0, 200, 390, 60));
  jest.mocked(Haptics.impactAsync).mockClear();
  jest.mocked(canCopy).mockReturnValue(true);
  jest.mocked(copyToClipboard).mockClear();
});

afterEach(() => nativeMethods.measureInWindow.mockReset());

describe('MessageMenu (TER-1090)', () => {
  it('a held touch opens the menu, with one light haptic tap', async () => {
    await render(<MessageMenu message={answer} onReply={jest.fn()}><Text>bolha</Text></MessageMenu>);
    expect(screen.queryByRole('menuitem', { name: 'Copiar' })).toBeNull();
    await hold();
    expect(Haptics.impactAsync).toHaveBeenCalledTimes(1);
    for (const label of ['Copiar', 'Responder', 'Copiar link', 'Abrir link']) expect(screen.getByRole('menuitem', { name: label })).toBeTruthy();
  });

  it('"Copiar" copies the answer as it reads, says "Copiado" and closes', async () => {
    await render(
      <>
        <MessageMenu message={answer}><Text>bolha</Text></MessageMenu>
        <ToastHost />
      </>,
    );
    await hold();
    await choose('Copiar');
    expect(copyToClipboard).toHaveBeenCalledWith('Pronto: testes verdes. Veja o PR (https://github.com/x/y/pull/1).');
    expect(await screen.findByText('Copiado')).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Copiar' })).toBeNull();
  });

  it('"Responder" quotes the row', async () => {
    const onReply = jest.fn();
    await render(<MessageMenu message={answer} onReply={onReply}><Text>bolha</Text></MessageMenu>);
    await hold();
    await choose('Responder');
    expect(onReply).toHaveBeenCalledTimes(1);
  });

  it('the link items copy and open the address', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await render(<MessageMenu message={answer}><Text>bolha</Text></MessageMenu>);
    await hold();
    await choose('Copiar link');
    expect(copyToClipboard).toHaveBeenCalledWith('https://github.com/x/y/pull/1');
    await hold();
    await choose('Abrir link');
    expect(openURL).toHaveBeenCalledWith('https://github.com/x/y/pull/1');
  });

  it('without a clipboard in the binary, "Compartilhar" hands the text to the system sheet', async () => {
    jest.mocked(canCopy).mockReturnValue(false);
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction });
    await render(<MessageMenu message={{ role: 'user', text: 'meu **texto**' }}><Text>bolha</Text></MessageMenu>);
    await hold();
    expect(screen.queryByRole('menuitem', { name: 'Copiar' })).toBeNull();
    await choose('Compartilhar');
    expect(share).toHaveBeenCalledWith({ message: 'meu **texto**' });
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it('a row with nothing to copy or answer opens nothing', async () => {
    await render(<MessageMenu message={{ role: 'assistant', text: '' }}><Text>bolha</Text></MessageMenu>);
    await hold();
    expect(Haptics.impactAsync).not.toHaveBeenCalled();
    expect(screen.queryByRole('menuitem')).toBeNull();
  });
});

describe('menuLayout', () => {
  const insets = { top: 40, bottom: 30 };

  it('leaves a row where it was when the menu fits under it', () => {
    expect(menuLayout({ x: 0, y: 200, width: 390, height: 60 }, 2, 844, insets)).toEqual({ previewTop: 200, previewHeight: 60, menuTop: 268 });
  });

  it('lifts a row near the bottom so the menu fits', () => {
    const layout = menuLayout({ x: 0, y: 760, width: 390, height: 60 }, 2, 844, insets);
    expect(layout.menuTop + 2 * 48).toBeLessThanOrEqual(844 - 30 - 8);
  });

  it('cuts a row taller than the screen at the top of the menu', () => {
    const layout = menuLayout({ x: 0, y: -400, width: 390, height: 2000 }, 4, 844, insets);
    expect(layout.previewTop).toBe(48);
    expect(layout.menuTop + 4 * 48).toBe(844 - 30 - 8);
  });
});
