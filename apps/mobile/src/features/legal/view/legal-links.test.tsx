import { Linking } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { LegalLinks } from './legal-links';

describe('LegalLinks', () => {
  afterEach(() => jest.restoreAllMocks());

  it('opens each document of termhub.dev in the browser', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await render(<LegalLinks />);
    await fireEvent.press(screen.getByRole('link', { name: 'Termos de uso' }));
    expect(open).toHaveBeenLastCalledWith('https://termhub.dev/termos/');
    await fireEvent.press(screen.getByRole('link', { name: 'Política de privacidade' }));
    expect(open).toHaveBeenLastCalledWith('https://termhub.dev/privacidade/');
  });
});
