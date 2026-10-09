import { APP_ACCOUNT_TOKEN_NAMESPACE, deriveAppAccountToken, uuidV5 } from '../appAccountToken';

const UUID_V5_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('deriveAppAccountToken', () => {
  it('同じ uid には常に同じ値を返す(決定的)', () => {
    expect(deriveAppAccountToken('user-1')).toBe(deriveAppAccountToken('user-1'));
  });

  it('異なる uid には異なる値を返す', () => {
    expect(deriveAppAccountToken('user-1')).not.toBe(deriveAppAccountToken('user-2'));
  });

  it('UUID v5(バージョン5・variant RFC 9562)の形式で返す', () => {
    expect(deriveAppAccountToken('user-1')).toMatch(UUID_V5_PATTERN);
    expect(deriveAppAccountToken('日本語のuid')).toMatch(UUID_V5_PATTERN);
    expect(deriveAppAccountToken('a')).toMatch(UUID_V5_PATTERN);
  });

  it('空文字は RangeError', () => {
    expect(() => deriveAppAccountToken('')).toThrow(RangeError);
  });

  it('文字列以外は RangeError', () => {
    expect(() => deriveAppAccountToken(undefined as unknown as string)).toThrow(RangeError);
  });

  it('似た uid(先頭が同じ・末尾1文字違い)でも全く異なる値になる', () => {
    const a = deriveAppAccountToken('abcdefghijklmno-aaaa');
    const b = deriveAppAccountToken('abcdefghijklmno-aaab');
    expect(a).not.toBe(b);
  });
});

describe('uuidV5', () => {
  it('RFC 9562 の既知のテストベクタ(名前空間 DNS + "www.example.com")と一致する', () => {
    // https://www.rfc-editor.org/rfc/rfc9562.html#name-example-of-a-uuidv5-value
    expect(uuidV5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );
  });

  it('名前空間が違えば同じ name でも異なる値になる', () => {
    const a = uuidV5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'same-name');
    const b = uuidV5(APP_ACCOUNT_TOKEN_NAMESPACE, 'same-name');
    expect(a).not.toBe(b);
  });

  it('namespace が UUID 形式でないと RangeError', () => {
    expect(() => uuidV5('not-a-uuid', 'name')).toThrow(RangeError);
  });
});
