/* global jest */
// `expo-image-picker` under jest: permission granted, nothing picked unless a test says otherwise
// (`launchImageLibraryAsync.mockResolvedValueOnce(...)`, `launchCameraAsync.mockResolvedValueOnce(...)`).
module.exports = {
  requestMediaLibraryPermissionsAsync: jest.fn(async () => ({ granted: true, status: 'granted' })),
  launchImageLibraryAsync: jest.fn(async () => ({ canceled: true, assets: null })),
  requestCameraPermissionsAsync: jest.fn(async () => ({ granted: true, status: 'granted' })),
  launchCameraAsync: jest.fn(async () => ({ canceled: true, assets: null })),
};
