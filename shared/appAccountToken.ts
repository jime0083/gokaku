/**
 * 購入の持ち主を確認するための appAccountToken(requirements 3-4)。
 *
 * uid から UUID v5 を決定的に計算する(同じ uid なら常に同じ値)。アプリ(購入時に Apple へ渡す)と
 * Cloud Functions(購入の確認時に照合する)の両方で同じ値を得られるよう、shared に置く。
 *
 * shared/ は Node の crypto・外部パッケージ(uuid 等)を import できない(gokaku/shared-imports-only)ため、
 * SHA-1(UUID v5 が内部で使うハッシュ関数)と UTF-8 エンコードを純粋な TypeScript で実装する。
 */

/**
 * appAccountToken 用の名前空間 UUID(固定の定数。一度決めたら変更しない。
 * 変更すると既存ユーザーの appAccountToken が全員変わり、既存の購入の照合ができなくなる)。
 * crypto.randomUUID() で新規に生成した値(2026-10-09)で、Apple や他のシステムの値とは無関係
 */
export const APP_ACCOUNT_TOKEN_NAMESPACE = 'c13f7510-a96e-4298-b833-551e20ce3958';

/** 文字列を UTF-8 のバイト配列にする(サロゲートペアを含む全てのコードポイントに対応) */
function utf8Encode(input: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const codePoint = input.codePointAt(i);
    if (codePoint === undefined) {
      continue;
    }
    if (codePoint > 0xffff) {
      // サロゲートペアの2文字分を1つのコードポイントとして処理したので、次のループで1文字進める
      i += 1;
    }
    if (codePoint < 0x80) {
      bytes.push(codePoint);
    } else if (codePoint < 0x800) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      bytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return bytes;
}

function rotateLeft32(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

/** SHA-1(FIPS 180-4)。入力はバイト配列、出力は20バイトのダイジェスト(バイト配列) */
function sha1(message: readonly number[]): number[] {
  const bitLength = message.length * 8;
  const padded = message.slice();
  padded.push(0x80);
  while (padded.length % 64 !== 56) {
    padded.push(0);
  }
  // 長さ(ビット数)を64bit big-endianで追加する。入力は十分に短い文字列のみを想定するため上位32bitは常に0
  padded.push(0, 0, 0, 0, (bitLength >>> 24) & 0xff, (bitLength >>> 16) & 0xff, (bitLength >>> 8) & 0xff, bitLength & 0xff);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  for (let chunkStart = 0; chunkStart < padded.length; chunkStart += 64) {
    const w = new Array<number>(80).fill(0);
    for (let i = 0; i < 16; i += 1) {
      const offset = chunkStart + i * 4;
      w[i] =
        ((padded[offset] << 24) | (padded[offset + 1] << 16) | (padded[offset + 2] << 8) | padded[offset + 3]) >>> 0;
    }
    for (let i = 16; i < 80; i += 1) {
      w[i] = rotateLeft32(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i += 1) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotateLeft32(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotateLeft32(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const digest: number[] = [];
  for (const h of [h0, h1, h2, h3, h4]) {
    digest.push((h >>> 24) & 0xff, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff);
  }
  return digest;
}

/** 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' 形式の UUID 文字列を16バイトの配列にする */
function parseUuid(uuid: string): number[] {
  const hex = uuid.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new RangeError(`namespace は UUID 形式である必要があります: ${uuid}`);
  }
  const bytes: number[] = [];
  for (let i = 0; i < 32; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return bytes;
}

function toHex(byte: number): string {
  return byte.toString(16).padStart(2, '0');
}

function formatUuid(bytes: readonly number[]): string {
  const hex = bytes.map(toHex).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** namespace(UUID 文字列)と name から UUID v5 を決定的に計算する(RFC 9562) */
export function uuidV5(namespace: string, name: string): string {
  const namespaceBytes = parseUuid(namespace);
  const nameBytes = utf8Encode(name);
  const hash = sha1(namespaceBytes.concat(nameBytes));
  const bytes = hash.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant RFC 9562
  return formatUuid(bytes);
}

/**
 * uid から appAccountToken(UUID v5)を決定的に計算する。
 * アプリは購入時に Apple へこの値を渡し、サーバーは購入の確認時に同じ値を計算して照合する
 */
export function deriveAppAccountToken(uid: string): string {
  if (typeof uid !== 'string' || uid.length === 0) {
    throw new RangeError(`uid は空でない文字列である必要があります: ${uid}`);
  }
  return uuidV5(APP_ACCOUNT_TOKEN_NAMESPACE, uid);
}
