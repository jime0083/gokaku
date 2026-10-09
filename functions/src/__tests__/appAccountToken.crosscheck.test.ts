import { createHash } from 'node:crypto';

import { APP_ACCOUNT_TOKEN_NAMESPACE, deriveAppAccountToken, uuidV5 } from '../domain';

/**
 * 4-2a: shared/appAccountToken.ts は Node の crypto を使えない(gokaku/shared-imports-only)ため、
 * SHA-1・UTF-8 エンコードを自前実装している。ここ(functions/)では node:crypto による参照実装を作り、
 * 様々な入力(日本語・空に近い文字列を含む)で一致することを確かめる
 */
function referenceUuidV5(namespace: string, name: string): string {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const nameBytes = Buffer.from(name, 'utf8');
  const hash = createHash('sha1').update(Buffer.concat([namespaceBytes, nameBytes])).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

describe('shared/appAccountToken.ts の SHA-1/UUID v5 自前実装が node:crypto の参照実装と一致する', () => {
  const inputs = [
    'a',
    '',
    ' ',
    '0',
    'user-1',
    'user-2',
    'abcdefghijklmno-aaaa',
    'abcdefghijklmno-aaab',
    '日本語のuid',
    'あ',
    '合格ウォッチ',
    '🎌日本語と絵文字😀',
    'x'.repeat(63), // SHA-1 のブロック境界(64バイト)をまたぐ長さ
    'x'.repeat(64),
    'x'.repeat(65),
    'A'.repeat(1000),
    '00000000-0000-0000-0000-000000000000',
    JSON.stringify({ uid: 'nested', n: 1 }),
  ];

  it.each(inputs)('入力 %j で参照実装(node:crypto)と一致する', (name) => {
    expect(uuidV5(APP_ACCOUNT_TOKEN_NAMESPACE, name)).toBe(referenceUuidV5(APP_ACCOUNT_TOKEN_NAMESPACE, name));
  });

  it('deriveAppAccountToken(uid) は uuidV5(namespace, uid) と一致する', () => {
    for (const uid of ['user-1', '日本語のuid', 'a']) {
      expect(deriveAppAccountToken(uid)).toBe(referenceUuidV5(APP_ACCOUNT_TOKEN_NAMESPACE, uid));
    }
  });

  it('別の名前空間(DNS)でも一致する(RFC 9562 の既知の名前空間での確認)', () => {
    const dnsNamespace = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    for (const name of inputs) {
      expect(uuidV5(dnsNamespace, name)).toBe(referenceUuidV5(dnsNamespace, name));
    }
  });
});
