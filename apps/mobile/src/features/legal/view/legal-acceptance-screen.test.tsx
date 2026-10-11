import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';

jest.mock('@/features/session/viewmodel/useSessionStore', () => ({ useSessionStore: require('../../../../test/helpers/ui-stores').stores.store }));
jest.mock('@/features/legal/viewmodel/useLegalStore', () => ({ useLegalStore: require('../../../../test/helpers/ui-stores').stores.legal }));

import type { TLegalVersion } from '@/services/api/contract';
import { enrolStores, stores } from '../../../../test/helpers/ui-stores';
import { LegalAcceptanceScreen } from './legal-acceptance-screen';

const LOAD = { timeout: 15_000 };
const TERMS: TLegalVersion = {
  id: 'v-terms-2',
  document: 'terms',
  version: '2.0',
  effective_at: new Date(2026, 9, 7, 12).toISOString(),
  url: 'https://termhub.dev/termos',
  requires_acceptance: true,
  summary: 'Novas regras de uso.',
};
const PRIVACY: TLegalVersion = { ...TERMS, id: 'v-privacy-2', document: 'privacy', url: 'https://termhub.dev/privacidade', summary: null };

beforeAll(async () => {
  await enrolStores();
});

afterEach(() => {
  jest.restoreAllMocks();
  stores.controls.seedLegalPending([]);
  stores.legal.setState({ pending: [], accepting: false, error: null });
});

describe('Termos de Uso e Política de Privacidade (TER-742)', () => {
  it('lists each pending document with its version, date, summary and link', async () => {
    stores.legal.setState({ pending: [TERMS, PRIVACY] });
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await render(<LegalAcceptanceScreen />);

    expect(screen.getByText('Para continuar usando o termhub, leia e aceite a versão em vigor dos documentos abaixo.')).toBeTruthy();
    expect(screen.getByText('Termos de Uso')).toBeTruthy();
    expect(screen.getByText('Política de Privacidade')).toBeTruthy();
    expect(screen.getAllByText('versão 2.0, em vigor desde 7 de outubro de 2026')).toHaveLength(2);
    expect(screen.getByText('Novas regras de uso.')).toBeTruthy();

    await fireEvent.press(screen.getByRole('link', { name: 'Ler Política de Privacidade' }));
    expect(open).toHaveBeenCalledWith('https://termhub.dev/privacidade');
  });

  it('"Continuar" stays off until the consent is on, then accepts every pending version', async () => {
    stores.controls.seedLegalPending([TERMS, PRIVACY]);
    stores.legal.setState({ pending: [TERMS, PRIVACY] });
    const post = jest.spyOn(stores.api, 'acceptLegal');
    await render(<LegalAcceptanceScreen />);

    await fireEvent.press(screen.getByRole('button', { name: 'Continuar' }));
    expect(post).not.toHaveBeenCalled();

    await fireEvent(screen.getByLabelText('Li e aceito os Termos de Uso e a Política de Privacidade'), 'valueChange', true);
    await fireEvent.press(screen.getByRole('button', { name: 'Continuar' }));
    await waitFor(() => expect(stores.legal.getState().pending).toEqual([]), LOAD);
    expect(post).toHaveBeenCalledWith(expect.anything(), ['v-terms-2', 'v-privacy-2']);
  });

  it('a failed acceptance shows the error and stays', async () => {
    stores.legal.setState({ pending: [TERMS] });
    jest.spyOn(stores.api, 'acceptLegal').mockRejectedValue(new Error('offline'));
    await render(<LegalAcceptanceScreen />);

    await fireEvent(screen.getByLabelText('Li e aceito os Termos de Uso e a Política de Privacidade'), 'valueChange', true);
    await fireEvent.press(screen.getByRole('button', { name: 'Continuar' }));
    expect(await screen.findByText('Não foi possível falar com o servidor. Tente de novo.', undefined, LOAD)).toBeTruthy();
    expect(stores.legal.getState().pending).toEqual([TERMS]);
  });
});
