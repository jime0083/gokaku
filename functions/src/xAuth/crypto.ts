/**
 * Server-only: Functions からのみ利用する。アプリ/shared/indexへ再exportしない。
 * 鍵はcallerから受け取り、設定・環境変数・永続化・ログにはアクセスしない。
 *
 * Wire codec: v1.<IV base64url>.<TAG base64url>.<ciphertext base64url>
 * 各base64urlはpaddingなし・canonical。v1はAES-256-GCMを意味する。
 * AAD: UTF-8 JSON ["gokaku/xAuth","v1",exactUid,exactPurpose]
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

const RANDOM_BYTES = 32;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const ERROR_MESSAGE = 'X auth cryptography failed';
const PURPOSES = ['accessToken', 'refreshToken', 'pkceVerifier'] as const;

export type EncryptionPurpose = (typeof PURPOSES)[number];

export interface EncryptionContext {
  readonly uid: string;
  readonly purpose: EncryptionPurpose;
}

export interface PkceParameters {
  readonly verifier: string;
  readonly challenge: string;
  readonly challengeMethod: 'S256';
}

/** 入力値や元例外を含めず、失敗を同じエラーにする。 */
function guarded<T>(operation: () => T): T {
  try {
    return operation();
  } catch {
    throw new Error(ERROR_MESSAGE);
  }
}

function requireValue(condition: boolean): asserts condition {
  if (!condition) throw new Error(ERROR_MESSAGE);
}

/** UTF-8への変換で異なる値に置き換わる不正surrogateも拒否する。 */
function requireText(value: unknown): asserts value is string {
  requireValue(
    typeof value === 'string' &&
      value.length > 0 &&
      Buffer.from(value, 'utf8').toString('utf8') === value,
  );
}

function decodeKey(value: unknown): Buffer {
  requireValue(
    typeof value === 'string' &&
      /^[A-Za-z0-9+/]{43}=$/.test(value),
  );
  const key = Buffer.from(value, 'base64');
  requireValue(key.length === KEY_BYTES && key.toString('base64') === value);
  return key;
}

function decodePart(value: unknown, size?: number): Buffer {
  requireValue(typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value));
  const bytes = Buffer.from(value, 'base64url');
  requireValue(
    bytes.length > 0 &&
      bytes.toString('base64url') === value &&
      (size === undefined || bytes.length === size),
  );
  return bytes;
}

function aad(context: EncryptionContext): Buffer {
  requireValue(context !== null && typeof context === 'object');
  requireText(context.uid);
  requireValue(PURPOSES.includes(context.purpose));
  // 配列のJSON符号化により、UIDや用途内の区切り文字による衝突を避ける。
  return Buffer.from(
    JSON.stringify(['gokaku/xAuth', VERSION, context.uid, context.purpose]),
    'utf8',
  );
}

export function createPkceChallenge(verifier: string): string {
  return guarded(() => {
    requireValue(
      typeof verifier === 'string' &&
        /^[A-Za-z0-9._~-]{43,128}$/.test(verifier),
    );
    return createHash('sha256').update(verifier, 'ascii').digest('base64url');
  });
}

export function createPkce(): PkceParameters {
  return guarded(() => {
    const verifier = randomBytes(RANDOM_BYTES).toString('base64url');
    return {
      verifier,
      challenge: createPkceChallenge(verifier),
      challengeMethod: 'S256',
    };
  });
}

export function createState(): string {
  return guarded(() => randomBytes(RANDOM_BYTES).toString('base64url'));
}

/** 保存用SHA-256 hex。stateそのものは返さない。 */
export function hashState(state: string): string {
  return guarded(() => {
    requireText(state);
    return createHash('sha256').update(state, 'utf8').digest('hex');
  });
}

export function encrypt(
  plaintext: string,
  keyBase64: string,
  context: EncryptionContext,
): string {
  return guarded(() => {
    requireText(plaintext);
    const key = decodeKey(keyBase64);
    const authenticatedData = aad(context);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(authenticatedData);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return [
      VERSION,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  });
}

export function decrypt(
  envelope: string,
  keyBase64: string,
  context: EncryptionContext,
): string {
  return guarded(() => {
    const key = decodeKey(keyBase64);
    const authenticatedData = aad(context);
    requireValue(typeof envelope === 'string');
    const parts = envelope.split('.');
    requireValue(parts.length === 4 && parts[0] === VERSION);
    const iv = decodePart(parts[1], IV_BYTES);
    const tag = decodePart(parts[2], TAG_BYTES);
    const ciphertext = decodePart(parts[3]);
    const decipher = createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(authenticatedData);
    decipher.setAuthTag(tag);
    // final()による認証成功まで平文を返さない。
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    const text = plaintext.toString('utf8');
    requireText(text);
    requireValue(Buffer.from(text, 'utf8').equals(plaintext));
    return text;
  });
}
