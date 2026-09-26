/* global jest */
// `expo-document-picker` under jest: nothing picked unless a test says otherwise.
module.exports = {
  getDocumentAsync: jest.fn(async () => ({ canceled: true, assets: null })),
};
