import { parseThreshold, parseThresholds, thresholdText } from './thresholds';

it('shows two decimals in the reader\'s language', () => {
  expect(thresholdText(0.9)).toBe('0,90');
  expect(thresholdText(1)).toBe('1,00');
});

it('reads a comma or a dot, and refuses what is not a threshold between 0.50 and 1.00', () => {
  expect(parseThreshold('0,95')).toBe(0.95);
  expect(parseThreshold(' 0.9 ')).toBe(0.9);
  expect(parseThreshold('1')).toBe(1);
  for (const bad of ['', 'abc', '0.4', '1.01', '95', '0.955', '-0.9']) expect(parseThreshold(bad)).toBeUndefined();
});

it('needs both fields and the suggestion threshold at or below the sending one', () => {
  expect(parseThresholds('0,95', '0,85')).toEqual({ high: 0.95, low: 0.85 });
  expect(parseThresholds('0,9', '0,9')).toEqual({ high: 0.9, low: 0.9 });
  expect(parseThresholds('0,85', '0,95')).toBeUndefined();
  expect(parseThresholds('0,95', '')).toBeUndefined();
});
