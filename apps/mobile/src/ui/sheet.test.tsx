import { render, screen } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';
import { setLocale } from '@/i18n';
import { Sheet } from './sheet';

describe('Sheet', () => {
  it('centres its panel at 560 pt on a wide window', async () => {
    await render(
      <Sheet open onClose={() => undefined} title="Título">
        <Text>corpo</Text>
      </Sheet>,
    );
    expect(StyleSheet.flatten(screen.getByTestId('sheet-panel').props.style)).toMatchObject({ width: '100%', maxWidth: 560, alignSelf: 'center' });
  });
});

describe('Sheet in English', () => {
  afterEach(() => setLocale(null));

  it('labels the backdrop "Close"', async () => {
    setLocale('en');
    await render(
      <Sheet open onClose={() => undefined} title="Title">
        <Text>body</Text>
      </Sheet>,
    );
    expect(screen.getByLabelText('Close')).toBeTruthy();
  });
});
