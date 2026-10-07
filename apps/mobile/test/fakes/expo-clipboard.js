/* global jest */
// `expo-clipboard` under jest: an in-memory clipboard. A test reads what was copied from
// `setStringAsync.mock.calls`, or makes a copy fail with `setStringAsync.mockRejectedValueOnce(...)`.
let text = '';
module.exports = {
  setStringAsync: jest.fn(async (value) => {
    text = value;
    return true;
  }),
  getStringAsync: jest.fn(async () => text),
};
