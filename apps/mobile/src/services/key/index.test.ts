// Which DeviceKey the app builds at boot (design spec §3.1, §10): the diagnostic always runs on
// the hardware key outside Jest — whatever the API mode — on its own tag, so the only mode that
// runs without a server (mock) still exercises the Secure Enclave / Keystore.
function load(env: { NODE_ENV: 'development' | 'production' | 'test'; EXPO_PUBLIC_API_MODE?: string }, isDevice = true) {
  const saved = { NODE_ENV: process.env.NODE_ENV, EXPO_PUBLIC_API_MODE: process.env.EXPO_PUBLIC_API_MODE };
  process.env.NODE_ENV = env.NODE_ENV;
  if (env.EXPO_PUBLIC_API_MODE === undefined) delete process.env.EXPO_PUBLIC_API_MODE;
  else process.env.EXPO_PUBLIC_API_MODE = env.EXPO_PUBLIC_API_MODE;
  try {
    let loaded!: { index: typeof import('./index'); hardware: typeof import('./hardware'); software: typeof import('./software') };
    jest.isolateModules(() => {
      jest.doMock('expo-device', () => ({ ...jest.requireActual('../../../test/fakes/expo-device'), isDevice }));
      loaded = { index: require('./index'), hardware: require('./hardware'), software: require('./software') };
    });
    return loaded;
  } finally {
    process.env.NODE_ENV = saved.NODE_ENV;
    if (saved.EXPO_PUBLIC_API_MODE === undefined) delete process.env.EXPO_PUBLIC_API_MODE;
    else process.env.EXPO_PUBLIC_API_MODE = saved.EXPO_PUBLIC_API_MODE;
  }
}

it('outside Jest, in mock mode, the diagnostic key is the hardware key while the device key stays software', () => {
  const { index, hardware, software } = load({ NODE_ENV: 'development', EXPO_PUBLIC_API_MODE: 'mock' });
  expect(index.diagnosticKey).toBeInstanceOf(hardware.HardwareDeviceKey);
  expect(index.deviceKey).toBeInstanceOf(software.SoftwareDeviceKey);
});

it('outside Jest, in http mode, both are hardware keys', () => {
  const { index, hardware } = load({ NODE_ENV: 'production', EXPO_PUBLIC_API_MODE: 'http' });
  expect(index.diagnosticKey).toBeInstanceOf(hardware.HardwareDeviceKey);
  expect(index.deviceKey).toBeInstanceOf(hardware.HardwareDeviceKey);
});

it('under Jest, both are software keys', () => {
  const { index, software } = load({ NODE_ENV: 'test', EXPO_PUBLIC_API_MODE: 'http' });
  expect(index.diagnosticKey).toBeInstanceOf(software.SoftwareDeviceKey);
  expect(index.deviceKey).toBeInstanceOf(software.SoftwareDeviceKey);
});

it('on a simulator, a development build in http mode signs with the software key (no Secure Enclave there)', () => {
  const { index, software } = load({ NODE_ENV: 'development', EXPO_PUBLIC_API_MODE: 'http' }, false);
  expect(index.deviceKey).toBeInstanceOf(software.SoftwareDeviceKey);
});

it('on a simulator, a production build in http mode still asks for the hardware key', () => {
  const { index, hardware } = load({ NODE_ENV: 'production', EXPO_PUBLIC_API_MODE: 'http' }, false);
  expect(index.deviceKey).toBeInstanceOf(hardware.HardwareDeviceKey);
});

it('on a real device, a development build in http mode uses the hardware key', () => {
  const { index, hardware } = load({ NODE_ENV: 'development', EXPO_PUBLIC_API_MODE: 'http' }, true);
  expect(index.deviceKey).toBeInstanceOf(hardware.HardwareDeviceKey);
});
