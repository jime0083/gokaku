import { FieldValue, Timestamp } from 'firebase-admin/firestore';

import {
  isJudgementSnapshot,
  isTimestampLike,
  type JudgementSnapshots,
  type JudgementStream,
} from '../../../shared/judgementHistory';

export type ServerHistoryStream = 'settings' | 'xLink' | 'subscription';

export type ServerHistoryResult = {
  counterPatch: Record<string, number>;
  entries: {
    stream: ServerHistoryStream;
    revisionId: string;
    data: {
      schemaVersion: 1;
      revision: number;
      committedAt: FieldValue;
      before: JudgementSnapshots[ServerHistoryStream];
      after: JudgementSnapshots[ServerHistoryStream];
    };
  }[];
};

export class ServerHistoryError extends Error {
  constructor() {
    super('Judgement history generation failed');
    this.name = 'ServerHistoryError';
  }
}

const ALL_STREAMS = ['goal', 'settings', 'xLink', 'subscription'] as const;
const SERVER_STREAMS = ['settings', 'xLink', 'subscription'] as const;

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSdkTimestamp(value: unknown): value is Timestamp {
  if (!(value instanceof Timestamp) || !isTimestampLike(value)) return false;
  try {
    // SDKの秒範囲とnano範囲を検証する。時刻取得・ミリ秒変換はしない。
    new Timestamp(value.seconds, value.nanoseconds);
    return true;
  } catch {
    return false;
  }
}

function isRevisions(
  value: unknown,
): value is Record<JudgementStream, number> {
  return isRecord(value)
    && Reflect.ownKeys(value).length === ALL_STREAMS.length
    && ALL_STREAMS.every((stream) =>
      hasOwn(value, stream)
      && typeof value[stream] === 'number'
      && Number.isSafeInteger(value[stream])
      && value[stream] > 0,
    );
}

/** 親子の同時指定はFirestore updateの意味が一意でないため拒否する。 */
function requireValidPatch(patch: Record<string, unknown>): void {
  const keys = Object.keys(patch);
  for (const key of keys) {
    if (
      key.split('.').some((part) => part.length === 0)
      || keys.some((other) => other !== key && other.startsWith(key + '.'))
      || key === 'judgementRevisions'
      || key.startsWith('judgementRevisions.')
      || key === 'judgementHistoryStartedAt'
      || key.startsWith('judgementHistoryStartedAt.')
      || key.startsWith('xPostEnabled.')
      || key.startsWith('xLinked.')
      || key.startsWith('subscription.expiresAt.')
      || key.startsWith('deletionInProgress.')
    ) {
      throw new ServerHistoryError();
    }
  }
  if (patch.deletionInProgress === true) throw new ServerHistoryError();
}

function subscriptionProjection(value: unknown): JudgementSnapshots['subscription'] {
  if (value === null) return null;
  if (!isRecord(value) || !hasOwn(value, 'expiresAt')) {
    throw new ServerHistoryError();
  }
  const snapshot = { expiresAt: value.expiresAt };
  if (!isJudgementSnapshot('subscription', snapshot)) {
    throw new ServerHistoryError();
  }
  return snapshot;
}

/**
 * 呼出側契約:
 * - 同じtransaction内のgetWritableAccountで取得したuser.data()を渡す。
 * - parentUpdatePatchはそのtransactionで実際にupdateするpatchを渡す。
 * - counterPatchを親updateへ加え、各entryを同じtransactionでcreateする。
 * - pathはjudgementHistory/{stream}/entries/{revisionId}から組み立てる。
 * - 成功済みreceiptの早期returnは、このhelperを呼ぶ前に行う。
 *
 * I/O・transaction開始・現在時刻取得は行わない。
 * subscriptionは全体置換とexpiresAtのdotted updateに対応する。
 * 他のsubscription子フィールド更新ではexpiresAtを保持する。
 */
export function buildServerHistory(
  userData: Record<string, unknown>,
  parentUpdatePatch: Record<string, unknown>,
): ServerHistoryResult {
  if (!isRecord(userData) || !isRecord(parentUpdatePatch)) {
    throw new ServerHistoryError();
  }
  if (userData.deletionInProgress === true) throw new ServerHistoryError();
  requireValidPatch(parentUpdatePatch);

  const result: ServerHistoryResult = { counterPatch: {}, entries: [] };
  const hasStart = hasOwn(userData, 'judgementHistoryStartedAt');
  const hasCounters = hasOwn(userData, 'judgementRevisions');
  // legacyはsnapshotを補完せず、baselineも作らない。
  if (!hasStart && !hasCounters) return result;

  const revisions = userData.judgementRevisions;
  if (
    !hasStart
    || !hasCounters
    || !isSdkTimestamp(userData.judgementHistoryStartedAt)
    || !isRevisions(revisions)
  ) {
    throw new ServerHistoryError();
  }

  // initializedの欠落・不正値を確認済みnullへ置き換えない。
  const settings = { xPostEnabled: userData.xPostEnabled };
  const xLink = { xLinked: userData.xLinked };
  if (
    !hasOwn(userData, 'xPostEnabled')
    || !hasOwn(userData, 'xLinked')
    || !isJudgementSnapshot('settings', settings)
    || !isJudgementSnapshot('xLink', xLink)
    || !hasOwn(userData, 'subscription')
  ) {
    throw new ServerHistoryError();
  }
  const before: Pick<JudgementSnapshots, ServerHistoryStream> = {
    settings,
    xLink,
    subscription: subscriptionProjection(userData.subscription),
  };

  const keys = Object.keys(parentUpdatePatch);
  const changed = {
    settings: hasOwn(parentUpdatePatch, 'xPostEnabled'),
    xLink: hasOwn(parentUpdatePatch, 'xLinked'),
    subscription: keys.some((key) =>
      key === 'subscription' || key.startsWith('subscription.'),
    ),
  };

  const after: Pick<JudgementSnapshots, ServerHistoryStream> = {
    settings: before.settings,
    xLink: before.xLink,
    subscription: before.subscription,
  };
  if (changed.settings) {
    const snapshot = { xPostEnabled: parentUpdatePatch.xPostEnabled };
    if (!isJudgementSnapshot('settings', snapshot)) {
      throw new ServerHistoryError();
    }
    after.settings = snapshot;
  }
  if (changed.xLink) {
    const snapshot = { xLinked: parentUpdatePatch.xLinked };
    if (!isJudgementSnapshot('xLink', snapshot)) {
      throw new ServerHistoryError();
    }
    after.xLink = snapshot;
  }
  if (changed.subscription) {
    if (hasOwn(parentUpdatePatch, 'subscription')) {
      // updateのmap全体置換。欠落expiresAtを元値から補わない。
      after.subscription = subscriptionProjection(parentUpdatePatch.subscription);
    } else if (hasOwn(parentUpdatePatch, 'subscription.expiresAt')) {
      after.subscription = subscriptionProjection({
        expiresAt: parentUpdatePatch['subscription.expiresAt'],
      });
    } else if (before.subscription === null) {
      // nullへの子フィールドupdateはmapを作るが、expiresAtを証明できない。
      throw new ServerHistoryError();
    } else {
      after.subscription = { expiresAt: before.subscription.expiresAt };
    }
  }

  // 全対象を検証してから返却用entryを生成する。
  const streams = SERVER_STREAMS.filter((stream) => changed[stream]);
  for (const stream of streams) {
    if (
      revisions[stream] === Number.MAX_SAFE_INTEGER
      || !isJudgementSnapshot(stream, before[stream])
      || !isJudgementSnapshot(stream, after[stream])
    ) {
      throw new ServerHistoryError();
    }
  }
  if (streams.length === 0) return result;

  const committedAt = FieldValue.serverTimestamp();
  for (const stream of streams) {
    const revision = revisions[stream] + 1;
    result.counterPatch['judgementRevisions.' + stream] = revision;
    result.entries.push({
      stream,
      revisionId: String(revision),
      data: {
        schemaVersion: 1,
        revision,
        committedAt,
        before: before[stream],
        after: after[stream],
      },
    });
  }
  return result;
}
