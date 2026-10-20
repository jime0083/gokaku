import * as Crypto from 'expo-crypto';
import { createAppleNonce } from '../appleNonce';

const HASHED_NONCE_FIXTURE = '6c86c6aac5fb24bcf5d9939cb7d7d5645ce39418f449e03b262dd4fa14b4b92b';

jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' }, CryptoEncoding: { HEX: 'hex' },
  getRandomValues: jest.fn(), getRandomBytes: jest.fn(), digestStringAsync: jest.fn(),
}));
beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(Crypto.getRandomValues).mockImplementation((array) => {
    new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
      .set(Array.from({ length: 32 }, (_, index) => index));
    return array;
  });
  jest.mocked(Crypto.digestStringAsync).mockResolvedValue(HASHED_NONCE_FIXTURE);
});
it('returns separate raw and SHA256 nonces for Firebase and Apple', async () => {
  const result = await createAppleNonce();
  const rawNonce = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
  expect(result).toEqual({ rawNonce, hashedNonce: HASHED_NONCE_FIXTURE });
  expect(result.rawNonce).toMatch(/^[0-9a-f]{64}$/);
  expect(result.hashedNonce).toMatch(/^[0-9a-f]{64}$/);
  expect(result.hashedNonce).not.toBe(result.rawNonce);
  expect(Crypto.getRandomValues).toHaveBeenCalledTimes(1);
  expect(Crypto.getRandomValues).toHaveBeenCalledWith(new Uint8Array(Array.from({ length: 32 }, (_, index) => index)));
  expect(Crypto.digestStringAsync).toHaveBeenCalledWith(Crypto.CryptoDigestAlgorithm.SHA256, rawNonce, { encoding: Crypto.CryptoEncoding.HEX });
  expect(Crypto.getRandomBytes).not.toHaveBeenCalled();
});
it('allocates new random input for each request', async () => {
  await createAppleNonce(); await createAppleNonce();
  expect(Crypto.getRandomValues).toHaveBeenCalledTimes(2);
  expect(jest.mocked(Crypto.getRandomValues).mock.calls[0][0]).not.toBe(jest.mocked(Crypto.getRandomValues).mock.calls[1][0]);
});
it.each(['native unavailable', 'secure random failed'])('%s propagates', async (message) => {
  const error = new Error(message);
  jest.mocked(Crypto.getRandomValues).mockImplementationOnce(() => { throw error; });
  await expect(createAppleNonce()).rejects.toBe(error);
  expect(Crypto.digestStringAsync).not.toHaveBeenCalled();
  expect(Crypto.getRandomBytes).not.toHaveBeenCalled();
});
it('propagates digest rejection without returning a nonce pair', async () => {
  const error = new Error('digest failed');
  jest.mocked(Crypto.digestStringAsync).mockRejectedValueOnce(error);
  await expect(createAppleNonce()).rejects.toBe(error);
});
