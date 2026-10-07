import { createHash } from 'node:crypto';

/**
 * デバイストークン(Phase 1-4 技術検証の認証方式・候補A)を Firestore に保存する際は、
 * 生の値ではなく sha256 ハッシュだけを保存する(Firestore が漏えいしてもトークンを復元できない)
 */
export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
