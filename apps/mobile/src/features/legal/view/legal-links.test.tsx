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

  it('names the publisher and its CNPJ under the links', async () => {
    await render(<LegalLinks />);
    expect(screen.getByText('8020 Digital Ltda · CNPJ 32.285.763/0001-12')).toBeTruthy();
  });
});
