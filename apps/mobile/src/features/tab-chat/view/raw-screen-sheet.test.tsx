import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { RawScreenSheet } from './raw-screen-sheet';

it('loads the screen when opened, shows it in monospace and refreshes', async () => {
  const load = jest.fn(async () => '$ npm test\n842 passed');
  await render(<RawScreenSheet open onClose={jest.fn()} load={load} />);
  const text = await screen.findByText('$ npm test\n842 passed');
  expect(StyleSheet.flatten(text.props.style)).toEqual(expect.objectContaining({ fontFamily: expect.any(String) }));
  expect(load).toHaveBeenCalledTimes(1);
  load.mockResolvedValueOnce('$ ls');
  await fireEvent.press(screen.getByRole('button', { name: 'Atualizar' }));
  expect(await screen.findByText('$ ls')).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(2);
});

it('a failure says the screen could not be read', async () => {
  await render(<RawScreenSheet open onClose={jest.fn()} load={async () => null} />);
  expect(await screen.findByText('Não foi possível ler a tela.')).toBeTruthy();
});

it('loads nothing while closed', async () => {
  const load = jest.fn(async () => 'x');
  await render(<RawScreenSheet open={false} onClose={jest.fn()} load={load} />);
  expect(load).not.toHaveBeenCalled();
});
