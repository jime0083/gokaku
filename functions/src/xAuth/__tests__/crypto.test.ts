import crypto from 'node:crypto';
import {
  createPkce,
  createPkceChallenge,
  createState,
  decrypt,
  encrypt,
  hashState,
  type EncryptionContext,
} from '../crypto';

const FAILURE = 'X auth cryptography failed';
// このテスト内だけで生成する鍵。本番設定・共有データは使用しない。
const key = crypto.randomBytes(32).toString('base64');
const context: EncryptionContext = { uid: 'test-user', purpose: 'accessToken' };

function expectFailure(operation: () => unknown): void {
  let failure: unknown;
  try {
    operation();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe(FAILURE);
  expect(Object.prototype.hasOwnProperty.call(failure, 'cause')).toBe(false);
}

function changedPart(envelope: string, index: number): string {
  const parts = envelope.split('.');
  const bytes = Buffer.from(parts[index], 'base64url');
  bytes[0] ^= 1;
  parts[index] = bytes.toString('base64url');
  return parts.join('.');
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('server X auth cryptography', () => {
  it('PKCE/stateはそれぞれrandomBytes(32)、verifierは43文字', () => {
    const random = jest.spyOn(crypto, 'randomBytes');
    const pkce = createPkce();
    const state = createState();

    expect(random.mock.calls.map((call) => call[0])).toEqual([32, 32]);
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(pkce.verifier, 'base64url')).toHaveLength(32);
    expect(Buffer.from(state, 'base64url')).toHaveLength(32);
    expect(pkce.challengeMethod).toBe('S256');
    expect(pkce.challenge).toBe(
      crypto.createHash('sha256').update(pkce.verifier).digest('base64url'),
    );
    expect(pkce.verifier).not.toBe(state);
    expect(createState()).not.toBe(state);
    expect(createPkce().verifier).not.toBe(pkce.verifier);
  });

  it('RFC7636 S256既知値とSHA256 state hashに一致する', () => {
    expect(
      createPkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    ).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(hashState('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(hashState('abc')).not.toBe(hashState('ABC'));
  });

  it.each(['accessToken', 'refreshToken', 'pkceVerifier'] as const)(
    '%sをJSON経由でも復号でき、IVは毎回12bytes、TAGは16bytes',
    (purpose) => {
      const bound = { uid: '利用者/é', purpose };
      const text = 'test-token_日本語';
      const random = jest.spyOn(crypto, 'randomBytes');
      const first = encrypt(text, key, bound);
      const second = encrypt(text, key, bound);
      expect(random.mock.calls.map((call) => call[0])).toEqual([12, 12]);
      const parts = first.split('.');
      expect(parts).toHaveLength(4);
      expect(parts[0]).toBe('v1');
      expect(Buffer.from(parts[1], 'base64url')).toHaveLength(12);
      expect(Buffer.from(parts[2], 'base64url')).toHaveLength(16);
      expect(first).not.toBe(second);
      expect(parts[1]).not.toBe(second.split('.')[1]);
      expect(first).not.toContain(text);
      expect(decrypt(JSON.parse(JSON.stringify(first)), key, bound)).toBe(text);
    },
  );

  it('公開wire/AAD仕様を使った独立node:crypto codecと双方向互換', () => {
    const bytes = Buffer.from(key, 'base64');
    const iv = crypto.randomBytes(12);
    const data = Buffer.from(
      JSON.stringify(['gokaku/xAuth', 'v1', context.uid, context.purpose]),
      'utf8',
    );
    const cipher = crypto.createCipheriv('aes-256-gcm', bytes, iv, {
      authTagLength: 16,
    });
    cipher.setAAD(data);
    const ciphertext = Buffer.concat([
      cipher.update('independent-fixture', 'utf8'),
      cipher.final(),
    ]);
    const fixture = [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
    expect(decrypt(fixture, key, context)).toBe('independent-fixture');

    const parts = encrypt('helper-output', key, context).split('.');
    const decoder = crypto.createDecipheriv(
      'aes-256-gcm',
      bytes,
      Buffer.from(parts[1], 'base64url'),
      { authTagLength: 16 },
    );
    decoder.setAAD(data);
    decoder.setAuthTag(Buffer.from(parts[2], 'base64url'));
    expect(
      Buffer.concat([
        decoder.update(Buffer.from(parts[3], 'base64url')),
        decoder.final(),
      ]).toString('utf8'),
    ).toBe('helper-output');
  });

  it('UID/用途を正規化せず厳密に認証する', () => {
    const bound: EncryptionContext = { uid: 'é', purpose: 'accessToken' };
    const envelope = encrypt('token', key, bound);
    for (const uid of ['other', 'é ', 'e\u0301', 'É']) {
      expectFailure(() => decrypt(envelope, key, { ...bound, uid }));
    }
    for (const purpose of ['refreshToken', 'pkceVerifier'] as const) {
      expectFailure(() => decrypt(envelope, key, { ...bound, purpose }));
    }
  });

  it('ciphertext/IV/TAG各部の改ざんと異なる正しい長さの鍵を拒否', () => {
    const envelope = encrypt('test-token', key, context);
    for (const index of [1, 2, 3]) {
      expectFailure(() => decrypt(changedPart(envelope, index), key, context));
    }
    const otherKey = Buffer.from(key, 'base64');
    otherKey[0] ^= 1;
    expectFailure(() => decrypt(envelope, otherKey.toString('base64'), context));
  });

  it('malformed/unknown version/truncated/noncanonical envelopeを拒否', () => {
    const envelope = encrypt('test-token', key, context);
    const parts = envelope.split('.');
    const invalid: unknown[] = [
      null, undefined, 1, {}, '', 'v1', envelope + '.', ' ' + envelope,
      envelope.replace(/^v1/, 'v2'), envelope.replace(/^v1/, 'V1'),
      parts.slice(0, 3).join('.'),
    ];
    for (const index of [1, 2, 3]) {
      for (const replacement of [
        '', '*', parts[index] + '=', parts[index] + '\n',
        Buffer.from(parts[index], 'base64url').subarray(1).toString('base64url'),
      ]) {
        const modified = [...parts];
        modified[index] = replacement;
        invalid.push(modified.join('.'));
      }
    }
    // 16byte TAGの最終文字は4bitのpaddingを持つ。同じbyteに復号されても拒否。
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const modified = [...parts];
    const tag = modified[2];
    modified[2] = tag.slice(0, -1) +
      alphabet[alphabet.indexOf(tag.slice(-1)) + 1];
    invalid.push(modified.join('.'));
    for (const value of invalid) {
      expectFailure(() => decrypt(value as string, key, context));
    }
  });

  it('鍵はcanonicalな標準base64で厳密32bytesのみ許可する', () => {
    const envelope = encrypt('test-token', key, context);
    const invalid: unknown[] = [
      null, undefined, 1, {}, '', 'not-a-key',
      Buffer.alloc(31).toString('base64'),
      Buffer.alloc(33).toString('base64'),
      Buffer.alloc(32).toString('base64url'),
      Buffer.alloc(32, 255).toString('base64url') + '=',
      Buffer.alloc(32).toString('base64').slice(0, 42) + 'B=',
      key + '\n', ' ' + key,
    ];
    for (const value of invalid) {
      expectFailure(() => encrypt('test-token', value as string, context));
      expectFailure(() => decrypt(envelope, value as string, context));
    }
  });

  it('不正なcontext・文字列とPKCE入力を固定エラーで拒否', () => {
    const envelope = encrypt('test-token', key, context);
    const invalidContexts: unknown[] = [
      null, undefined, {}, { uid: '', purpose: 'accessToken' },
      { uid: '\ud800', purpose: 'accessToken' },
      { uid: 'test-user', purpose: 'unknown' },
      { uid: 'test-user', purpose: 'AccessToken' },
    ];
    for (const value of invalidContexts) {
      expectFailure(() => encrypt('token', key, value as EncryptionContext));
      expectFailure(() => decrypt(envelope, key, value as EncryptionContext));
    }
    for (const value of ['', '\ud800', null, 1]) {
      expectFailure(() => encrypt(value as string, key, context));
      expectFailure(() => hashState(value as string));
    }
    for (const value of ['', 'a'.repeat(42), 'a'.repeat(129), 'a'.repeat(42) + '!']) {
      expectFailure(() => createPkceChallenge(value));
    }
    expect(createPkceChallenge('a'.repeat(128))).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('乱数生成失敗も元例外・秘密値・ログを漏らさない', () => {
    const logs = ['log', 'info', 'warn', 'error', 'debug'].map((method) =>
      jest.spyOn(console, method as 'log').mockImplementation(() => undefined),
    );
    jest.spyOn(crypto, 'randomBytes').mockImplementation(() => {
      throw new Error('synthetic-sensitive-value');
    });
    expectFailure(() => createPkce());
    expectFailure(() => createState());
    expectFailure(() => encrypt('synthetic-token', key, context));
    expectFailure(() => decrypt('invalid', key, context));
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});
