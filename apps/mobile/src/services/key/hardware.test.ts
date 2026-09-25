import { generate, getPublicKeyFixed } from '@pagopa/io-react-native-crypto';
import { HardwareDeviceKey } from './hardware';

// The native module's two shapes of the same public key: `generate` answers in the library's
// legacy format (standard base64, padded), `getPublicKeyFixed` in strict JWK base64url.
const LEGACY = { kty: 'EC', crv: 'P-256', x: 'q+8/3xQ0Zw1e4T5aPm0f3v7Qp1s2K3b4c5d6e7f8g9E=', y: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=' };
const FIXED = { kty: 'EC', crv: 'P-256', x: 'q-8_3xQ0Zw1e4T5aPm0f3v7Qp1s2K3b4c5d6e7f8g9E', y: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8' };

describe('HardwareDeviceKey', () => {
  beforeEach(() => {
    jest.mocked(generate).mockReset().mockResolvedValue(LEGACY as never);
    jest.mocked(getPublicKeyFixed).mockReset().mockResolvedValue(FIXED as never);
  });

  it('create() returns the same base64url JWK that publicJwk() later puts in every proof', async () => {
    const key = new HardwareDeviceKey('test.tag');
    const created = await key.create();
    expect(created).toEqual({ kty: 'EC', crv: 'P-256', x: FIXED.x, y: FIXED.y });
    expect(created).toEqual(await key.publicJwk());
  });
});
