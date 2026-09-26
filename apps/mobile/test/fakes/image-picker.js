/* global jest */
// `expo-image-picker` under jest: permission granted, nothing picked unless a test says otherwise
// (`launchImageLibraryAsync.mockResolvedValueOnce(...)`).
module.exports = {
  requestMediaLibraryPermissionsAsync: jest.fn(async () => ({ granted: true, status: 'granted' })),
  launchImageLibraryAsync: jest.fn(async () => ({ canceled: true, assets: null })),
};
