import { getFirestore, Timestamp } from 'firebase-admin/firestore';

import { ensureAdminApp } from './firebaseAdmin';

/**
 * 計測の記録(recordStudyEvent・nativeSync)と購入の確認(verifyApplePurchase)の、
 * ユーザーごとの1分あたりの呼び出し回数を制限する共通処理(5-3b-2。requirements 3-2「大量の呼び出しへの対策」)。
 *
 * Firestore のトランザクションで rateLimits/{uid}_{kind}_{分の番号} のカウンタを数える。
 * 「分の番号」(rateLimitMinuteBucket)は受信時刻を60,000ms で割った整数なので、1分ごとに別の
 * ドキュメントになり、次の分になれば自然に0件から数え直される(古いカウンタを読んで初期化し直す処理は不要)。
 *
 * 「計測の記録」は recordStudyEvent(Callable。source=app)と nativeSync(source=lockscreen)の
 * 両方から呼ばれるが、kind='study-event' を共有することで、どちらから呼んでも同じ1分あたりの枠になる
 * (requirements 3-2「計測の記録(アプリからの Callable・ロック画面からの nativeSync)...1分あたりの呼び出し回数に上限」)。
 *
 * 数える位置(呼び出し元ごとに、認証が済んだ直後・入力の検査より前に数える。5-3b-2 で決定):
 * - recordStudyEvent: request.auth.uid が確定した直後(Callable は呼び出し時点で ID トークンの検証済み)
 * - nativeSync: デバイストークンの検証(持ち主・期限)に通った直後(不正なリクエストでカウンタを増やさない)
 * - verifyApplePurchase: request.auth.uid が確定した直後
 *
 * 古いカウンタの片付け(5-3b-2 で決定): ドキュメントに expireAt(Firestore の Timestamp。その分の区切りが
 * 終わってから5分後)を持たせる。Firestore の TTL ポリシー(コレクショングループ rateLimits・フィールド
 * expireAt)を有効にすると、期限が来たドキュメントを自動で削除してくれる。TTL ポリシーの有効化はコードだけ
 * では行えず、Firebase コンソールまたは gcloud での一度だけの手動設定が必要(manual-work で案内する)
 */

export type RateLimitKind = 'study-event' | 'purchase-verify';

/** 種類ごとの1分あたりの呼び出し回数の上限(requirements 3-2。2026-10-10 決定の目安をそのまま採用) */
export const RATE_LIMITS: Readonly<Record<RateLimitKind, number>> = {
  'study-event': 60,
  'purchase-verify': 10,
};

const RATE_LIMIT_WINDOW_MS = 60_000;
// 分の区切りが終わってからカウンタを消してよくなるまでの余裕(時計のずれ・処理の遅延を考慮)
const RATE_LIMIT_CLEANUP_BUFFER_MS = 5 * 60_000;

export type RateLimitDeps = { now: () => number };

export function createProductionRateLimitDeps(): RateLimitDeps {
  return { now: () => Date.now() };
}

/** 呼び出し側(Callable・nativeSync)が文言・応答コードに変換するためのエラー(内部の詳細は含まない) */
export class RateLimitExceededError extends Error {
  readonly kind: RateLimitKind;

  constructor(kind: RateLimitKind) {
    super('呼び出し回数の上限に達しました。しばらく待ってから再度お試しください');
    this.name = 'RateLimitExceededError';
    this.kind = kind;
  }
}

/** 受信時刻(epoch ミリ秒)が属する「分の番号」(0分0秒からの経過分数) */
export function rateLimitMinuteBucket(nowMs: number): number {
  return Math.floor(nowMs / RATE_LIMIT_WINDOW_MS);
}

/**
 * カウンタの Firestore ドキュメントパス。テスト・調査から同じドキュメントを直接読み書きできるよう公開する
 * (例: 上限に達した状態を直接作ってから Callable/nativeSync を呼ぶテスト)
 */
export function rateLimitDocPath(uid: string, kind: RateLimitKind, nowMs: number): string {
  return `rateLimits/${uid}_${kind}_${rateLimitMinuteBucket(nowMs)}`;
}

/**
 * uid・kind ごとに1分あたりの呼び出し回数を数える。上限を超えていれば RateLimitExceededError を投げ、
 * カウンタは増やさない。上限に達していなければカウンタを1増やして(無ければ1件目として作って)正常に戻る
 */
export async function enforceRateLimit(uid: string, kind: RateLimitKind, deps: RateLimitDeps): Promise<void> {
  ensureAdminApp();
  const db = getFirestore();
  const nowMs = deps.now();
  const limit = RATE_LIMITS[kind];
  const ref = db.doc(rateLimitDocPath(uid, kind, nowMs));

  const exceeded = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const count = snap.exists ? ((snap.get('count') as number | undefined) ?? 0) : 0;
    if (count >= limit) {
      return true;
    }
    if (snap.exists) {
      tx.update(ref, { count: count + 1 });
    } else {
      const windowEndMs = (rateLimitMinuteBucket(nowMs) + 1) * RATE_LIMIT_WINDOW_MS;
      tx.set(ref, { count: 1, expireAt: Timestamp.fromMillis(windowEndMs + RATE_LIMIT_CLEANUP_BUFFER_MS) });
    }
    return false;
  });

  if (exceeded) {
    throw new RateLimitExceededError(kind);
  }
}
