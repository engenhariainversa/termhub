/* global jest */
// `expo-audio` under jest: its native module has no binding here. A player that plays nothing and
// whose status a test sets (`__setStatus`); a suite about the recorder mocks the module itself.
const { useSyncExternalStore } = require('react');

let status = { playing: false, currentTime: 0, duration: 0, isLoaded: false, didJustFinish: false };
const listeners = new Set();

const player = {
  replace: jest.fn(),
  play: jest.fn(),
  pause: jest.fn(),
  seekTo: jest.fn(async () => undefined),
};

module.exports = {
  useAudioPlayer: () => player,
  useAudioPlayerStatus: () =>
    useSyncExternalStore(
      (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      () => status,
    ),
  setAudioModeAsync: jest.fn(async () => undefined),
  requestRecordingPermissionsAsync: jest.fn(async () => ({ granted: true })),
  useAudioRecorder: () => ({ prepareToRecordAsync: jest.fn(async () => undefined), record: jest.fn(), stop: jest.fn(async () => undefined), getStatus: () => ({}), uri: null }),
  AudioQuality: { MEDIUM: 64 },
  IOSOutputFormat: { MPEG4AAC: 'aac ' },
  /** the one player every `useAudioPlayer` answers */
  __player: player,
  __setStatus(next) {
    status = { ...status, ...next };
    listeners.forEach((fn) => fn());
  },
  __reset() {
    status = { playing: false, currentTime: 0, duration: 0, isLoaded: false, didJustFinish: false };
    Object.values(player).forEach((fn) => fn.mockClear());
  },
};
