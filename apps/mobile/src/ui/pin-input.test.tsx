import { fireEvent, render, screen } from '@testing-library/react-native';
import { PinInput } from './pin-input';

describe('PinInput', () => {
  it('asks the system number pad for the digits and reports only digits, at most six', async () => {
    const onChange = jest.fn();
    await render(<PinInput value="" onChange={onChange} accessibilityLabel="PIN" />);
    const input = screen.getByLabelText('PIN');
    expect(input.props.keyboardType).toBe('number-pad');
    await fireEvent.changeText(input, '12a3 4567');
    expect(onChange).toHaveBeenLastCalledWith('123456');
  });

  it('is not editable while disabled', async () => {
    await render(<PinInput value="" onChange={jest.fn()} disabled accessibilityLabel="PIN" />);
    expect(screen.getByLabelText('PIN').props.editable).toBe(false);
  });
});
