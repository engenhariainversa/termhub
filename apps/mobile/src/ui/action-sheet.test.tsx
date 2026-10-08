import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { PanResponder, Platform, StyleSheet, type PanResponderCallbacks, type PanResponderGestureState } from 'react-native';
import { setLocale } from '@/i18n';
import { ActionSheet, ActionSheetItem } from './action-sheet';

const ICON = { ios: 'doc', android: 'description' } as const;
const gesture = (over: Partial<PanResponderGestureState>) => ({ dx: 0, dy: 0, vx: 0, vy: 0, ...over }) as PanResponderGestureState;

/** The sheet's drag callbacks, as it handed them to `PanResponder.create`. */
function spyDrag() {
  const create = jest.spyOn(PanResponder, 'create');
  return () => {
    const callbacks = create.mock.calls.at(-1)![0] as Required<PanResponderCallbacks>;
    create.mockRestore();
    return callbacks;
  };
}

function renderSheet(over: Partial<React.ComponentProps<typeof ActionSheet>> = {}) {
  const props = { open: true, onCancel: jest.fn(), onHidden: jest.fn(), ...over };
  const onPick = jest.fn();
  const ui = (p: typeof props) => (
    <ActionSheet {...p}>
      <ActionSheetItem icon={ICON} label="Arquivo" onPress={onPick} />
    </ActionSheet>
  );
  return { props, onPick, ui };
}

describe('ActionSheet', () => {
  it('shows its rows and a Cancelar; a row runs its action and Cancelar cancels', async () => {
    const { props, onPick, ui } = renderSheet();
    await render(ui(props));
    await fireEvent.press(screen.getByRole('button', { name: 'Arquivo' }));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(props.onCancel).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Cancelar' }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it('a tap on the backdrop cancels', async () => {
    const { props, ui } = renderSheet();
    await render(ui(props));
    await fireEvent.press(screen.getByTestId('action-sheet-backdrop', { includeHiddenElements: true }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it('stands on the bottom edge, above the home indicator', async () => {
    const { props, ui } = renderSheet();
    await render(ui(props));
    const panel = screen.getByTestId('action-sheet-panel');
    expect(StyleSheet.flatten(panel.props.style)).toMatchObject({ paddingBottom: 8, maxWidth: 560 });
  });

  it('a drag down past the threshold cancels; a short one springs back', async () => {
    const drag = spyDrag();
    const { props, ui } = renderSheet();
    await render(ui(props));
    const callbacks = drag();
    const e = {} as never;
    expect(callbacks.onMoveShouldSetPanResponder(e, gesture({ dy: 2 }))).toBe(false);
    expect(callbacks.onMoveShouldSetPanResponder(e, gesture({ dy: 20, dx: 40 }))).toBe(false);
    expect(callbacks.onMoveShouldSetPanResponder(e, gesture({ dy: 20, dx: 2 }))).toBe(true);
    await act(async () => callbacks.onPanResponderRelease(e, gesture({ dy: 30, vy: 0.1 })));
    expect(props.onCancel).not.toHaveBeenCalled();
    await act(async () => callbacks.onPanResponderRelease(e, gesture({ dy: 120 })));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    await act(async () => callbacks.onPanResponderRelease(e, gesture({ dy: 20, vy: 1.5 })));
    expect(props.onCancel).toHaveBeenCalledTimes(2);
  });

  it('says it is hidden through the modal on iOS, and once closed elsewhere', async () => {
    const { props, ui } = renderSheet();
    const view = await render(ui(props));
    expect(screen.getByTestId('action-sheet', { includeHiddenElements: true }).props.onDismiss).toBe(props.onHidden);
    await view.rerender(ui({ ...props, open: false }));
    expect(props.onHidden).not.toHaveBeenCalled();

    const os = jest.replaceProperty(Platform, 'OS', 'android');
    try {
      await view.rerender(ui({ ...props, open: true }));
      await view.rerender(ui({ ...props, open: false }));
      expect(props.onHidden).toHaveBeenCalledTimes(1);
    } finally {
      os.restore();
    }
  });
});

describe('ActionSheet in English', () => {
  afterEach(() => setLocale(null));

  it('labels Cancelar "Cancel"', async () => {
    setLocale('en');
    const { props, ui } = renderSheet();
    await render(ui(props));
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });
});
