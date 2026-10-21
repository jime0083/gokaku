/**
 * 4-3: サーバー確認済みsubscriptionによる利用判定(requirements 3-4)。
 * users.subscription.expiresAtはサーバー保存のミリ秒数値をそのまま渡す。
 * タイマーや購読は持たず、起動・復帰等の明示的な再確認時だけ評価する。
 */
export type SubscriptionWire = Readonly<{
  status: 'active' | 'expired';
  expiresAt: number;
}>;

export type SubscriptionCache = Readonly<{
  uid: string;
  subscription: SubscriptionWire | null;
}>;

/** successはサーバーからの取得成功のみ。ローカルsnapshotは含めない。 */
export type SubscriptionRead =
  | Readonly<{ kind: 'success'; uid: string; subscription: unknown }>
  | Readonly<{ kind: 'unavailable' }>;

export type SubscriptionAccessResult = Readonly<{
  access: 'allowed' | 'locked';
  /** 呼び出し側へ返す最小キャッシュ。保存処理は行わない。 */
  cache: SubscriptionCache | null;
}>;

/** 未検証wireを検査し、判定に必要な項目だけを新しい値として返す。 */
export function normalizeSubscription(value: unknown): SubscriptionWire | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const { status, expiresAt } = record;
  if (
    (status !== 'active' && status !== 'expired') ||
    typeof expiresAt !== 'number' ||
    !Number.isSafeInteger(expiresAt)
  ) {
    return null;
  }
  return { status, expiresAt };
}

/**
 * 通信成功は欠損・不正値も含めて優先する。通信不能時だけ同じUIDの
 * 前回サーバーキャッシュを使用する。UIDは認証済み呼び出し側から渡す。
 * これはクライアント表示用の判定でありサーバーの権限検証を代替しない。
 */
export function resolveSubscriptionAccess(input: Readonly<{
  uid: string;
  read: SubscriptionRead;
  cache: SubscriptionCache | null;
  now: number;
}>): SubscriptionAccessResult {
  const { uid, read, cache, now } = input;
  if (uid.length === 0 || (read.kind === 'success' && read.uid !== uid)) {
    return { access: 'locked', cache: null };
  }

  let nextCache: SubscriptionCache | null;
  if (read.kind === 'success') {
    nextCache = { uid, subscription: normalizeSubscription(read.subscription) };
  } else if (cache?.uid === uid) {
    nextCache = { uid, subscription: normalizeSubscription(cache.subscription) };
  } else {
    nextCache = null;
  }

  const subscription = nextCache?.subscription;
  const allowed = Number.isFinite(now) &&
    subscription?.status === 'active' &&
    subscription.expiresAt > now;
  return { access: allowed ? 'allowed' : 'locked', cache: nextCache };
}
