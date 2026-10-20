import * as Crypto from 'expo-crypto';

const NONCE_BYTE_LENGTH = 32;

export async function createAppleNonce(): Promise<{
  rawNonce: string;
  hashedNonce: string;
}> {
  const bytes = Crypto.getRandomValues(new Uint8Array(NONCE_BYTE_LENGTH));
  const rawNonce = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const hashedNonce = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    rawNonce,
    { encoding: Crypto.CryptoEncoding.HEX },
  );
  return { rawNonce, hashedNonce };
}
