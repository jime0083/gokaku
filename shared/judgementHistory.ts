/**
 * 0:00直前の判定入力を復元する純粋helper(requirements 5-1)。
 * Firestore SDK・I/O・現在時刻取得には依存しない。
 */
import { isValidDateKey } from './date';
import type { JudgementGoal, JudgementSubscription } from './dailyJudgement';

export type TimestampLike = {
  readonly seconds: number;
  readonly nanoseconds: number;
};

export type JudgementSnapshots = {
  goal: (JudgementGoal & { goalId: string }) | null;
  settings: { xPostEnabled: boolean };
  xLink: { xLinked: boolean };
  subscription: JudgementSubscription | null;
};

export type JudgementStream = keyof JudgementSnapshots;

export type JudgementHistoryEntry<S extends JudgementStream = JudgementStream> = {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly committedAt: TimestampLike;
  readonly before: JudgementSnapshots[S];
  readonly after: JudgementSnapshots[S];
};

export type JudgementHistoryFailureReason =
  | 'invalidMetadata'
  | 'invalidEntries'
  | 'invalidEntry'
  | 'counterMismatch'
  | 'duplicateRevision'
  | 'revisionGap'
  | 'timestampOrder'
  | 'invalidBaseline'
  | 'snapshotMismatch'
  | 'missingBeforeCutoff'
  | 'missingSuccessor';

export type JudgementHistorySelection<S extends JudgementStream = JudgementStream> =
  | { status: 'available'; snapshot: JudgementSnapshots[S] }
  | { status: 'beforeCoverage' }
  | { status: 'missingOrInvalid'; reason: JudgementHistoryFailureReason };

export type JudgementHistorySelectionInput<
  S extends JudgementStream = JudgementStream,
> = {
  stream: S;
  parentRevision: unknown;
  coverageStart: unknown;
  cutoff: unknown;
  entries: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactFields(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  return isRecord(value)
    && Reflect.ownKeys(value).length === fields.length
    && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isTimestampLike(value: unknown): value is TimestampLike {
  return isRecord(value)
    && typeof value.seconds === 'number'
    && Number.isInteger(value.seconds)
    && typeof value.nanoseconds === 'number'
    && Number.isInteger(value.nanoseconds)
    && value.nanoseconds >= 0
    && value.nanoseconds <= 999999999;
}

/** 検査済みTimestamp同士を比較する。epochミリ秒への変換・SDKメソッドは使わない。 */
export function compareTimestamps(a: TimestampLike, b: TimestampLike): -1 | 0 | 1 {
  if (a.seconds !== b.seconds) {
    return a.seconds < b.seconds ? -1 : 1;
  }
  if (a.nanoseconds !== b.nanoseconds) {
    return a.nanoseconds < b.nanoseconds ? -1 : 1;
  }
  return 0;
}

/** dailyJudgementと同じ入力範囲。フォーム固有の範囲・刻みを追加しない。 */
function isMinutes(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function isJudgementSnapshot<S extends JudgementStream>(
  stream: S,
  value: unknown,
): value is JudgementSnapshots[S] {
  switch (stream) {
    case 'goal':
      return value === null || (
        hasExactFields(value, [
          'goalId', 'startDate', 'examDate', 'minDailyMinutes', 'goalDailyMinutes',
        ])
        && typeof value.goalId === 'string'
        && value.goalId.length > 0
        && typeof value.startDate === 'string'
        && isValidDateKey(value.startDate)
        && typeof value.examDate === 'string'
        && isValidDateKey(value.examDate)
        && isMinutes(value.minDailyMinutes)
        && isMinutes(value.goalDailyMinutes)
      );
    case 'settings':
      return hasExactFields(value, ['xPostEnabled'])
        && typeof value.xPostEnabled === 'boolean';
    case 'xLink':
      return hasExactFields(value, ['xLinked'])
        && typeof value.xLinked === 'boolean';
    case 'subscription':
      return value === null || (
        hasExactFields(value, ['expiresAt'])
        && (
          value.expiresAt === null
          || (typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt))
        )
      );
    default:
      return false;
  }
}

export function isJudgementHistoryEntry<S extends JudgementStream>(
  stream: S,
  value: unknown,
): value is JudgementHistoryEntry<S> {
  return hasExactFields(value, [
    'schemaVersion', 'revision', 'committedAt', 'before', 'after',
  ])
    && value.schemaVersion === 1
    && isRevision(value.revision)
    && isTimestampLike(value.committedAt)
    && isJudgementSnapshot(stream, value.before)
    && isJudgementSnapshot(stream, value.after);
}

/** 最小snapshotのフィールドはprimitiveのみ。キーの挿入順に依存しない。 */
function sameSnapshot(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && a[key] === b[key]);
}

function invalid(
  reason: JudgementHistoryFailureReason,
): { status: 'missingOrInvalid'; reason: JudgementHistoryFailureReason } {
  return { status: 'missingOrInvalid', reason };
}

/**
 * 呼出側契約:
 * - parentRevision、coverageStart、候補entryを同一transactionで読む。
 * - cutoffは判定対象日の翌0:00(Asia/Tokyo)をTimestamp精度で渡す。
 * - 候補にはcommittedAt < cutoffの真の最大entry
 *   (同時刻はrevision最大)と、存在すればcutoff以降の真の最初のentry
 *   (同時刻はrevision最小)を含める。
 * - 追加候補を渡す場合も連続したrevisionのwindowとする。
 *   全履歴・baselineの毎回取得は要求しない。
 *
 * 純粋helperはqueryの完全性やtransaction境界自体を証明できない。
 * 親counterと隣接revisionを照合し、古いentryへの黙ったfallbackを防ぐ。
 * 導入後のmissingOrInvalidは呼出側がエラー記録・再試行する。
 */
export function selectJudgementHistory<S extends JudgementStream>(
  input: JudgementHistorySelectionInput<S>,
): JudgementHistorySelection<S> {
  const { stream, parentRevision, coverageStart, cutoff } = input;
  if (
    !['goal', 'settings', 'xLink', 'subscription'].includes(stream)
    || !isTimestampLike(coverageStart)
    || !isTimestampLike(cutoff)
  ) {
    return invalid('invalidMetadata');
  }

  // 開始時刻の等号も導入前。過去日の値を推測しない。
  if (compareTimestamps(coverageStart, cutoff) >= 0) {
    return { status: 'beforeCoverage' };
  }
  if (!isRevision(parentRevision)) return invalid('invalidMetadata');
  if (!Array.isArray(input.entries)) return invalid('invalidEntries');

  const entries: JudgementHistoryEntry<S>[] = [];
  for (const candidate of input.entries) {
    if (!isJudgementHistoryEntry(stream, candidate)) {
      return invalid('invalidEntry');
    }
    entries.push(candidate);
  }
  // 呼出元の配列は変更しない。
  entries.sort((a, b) => a.revision - b.revision);

  let previous: JudgementHistoryEntry<S> | undefined;
  let selected: JudgementHistoryEntry<S> | undefined;
  let successor: JudgementHistoryEntry<S> | undefined;

  for (const current of entries) {
    if (current.revision > parentRevision) return invalid('counterMismatch');
    if (compareTimestamps(current.committedAt, coverageStart) < 0) {
      return invalid('timestampOrder');
    }
    if (
      current.revision === 1
      && (
        compareTimestamps(current.committedAt, coverageStart) !== 0
        || !sameSnapshot(current.before, current.after)
      )
    ) {
      return invalid('invalidBaseline');
    }
    if (previous) {
      if (current.revision === previous.revision) {
        return invalid('duplicateRevision');
      }
      if (current.revision !== previous.revision + 1) {
        return invalid('revisionGap');
      }
      if (compareTimestamps(previous.committedAt, current.committedAt) > 0) {
        return invalid('timestampOrder');
      }
      if (!sameSnapshot(previous.after, current.before)) {
        return invalid('snapshotMismatch');
      }
    }

    if (compareTimestamps(current.committedAt, cutoff) < 0) {
      selected = current;
    } else if (!successor) {
      successor = current;
    }
    previous = current;
  }

  if (!selected) return invalid('missingBeforeCutoff');
  if (selected.revision === parentRevision) {
    if (successor) return invalid('counterMismatch');
  } else {
    if (!successor || successor.revision !== selected.revision + 1) {
      return invalid('missingSuccessor');
    }
    if (compareTimestamps(successor.committedAt, cutoff) < 0) {
      return invalid('timestampOrder');
    }
    if (!sameSnapshot(selected.after, successor.before)) {
      return invalid('snapshotMismatch');
    }
  }
  return { status: 'available', snapshot: selected.after };
}
