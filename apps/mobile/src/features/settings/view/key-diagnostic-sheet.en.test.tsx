import { render, screen } from '@testing-library/react-native';
import { setLocale } from '@/i18n';
import { KeyDiagnosticSheet } from './key-diagnostic-sheet';

afterEach(() => setLocale(null));

it('shows the key diagnostic in English', async () => {
  setLocale('en');
  await render(
    <KeyDiagnosticSheet
      open
      onClose={() => undefined}
      result={{ ok: false, steps: [{ name: 'create', ok: true }, { name: 'sign+verify', ok: false, detail: 'x' }] }}
    />,
  );
  expect(screen.getByText('Key diagnostic')).toBeTruthy();
  expect(screen.getByText('Something failed in the key test.')).toBeTruthy();
  expect(screen.getByText('create: ok')).toBeTruthy();
  expect(screen.getByText('sign+verify: failed')).toBeTruthy();
});
