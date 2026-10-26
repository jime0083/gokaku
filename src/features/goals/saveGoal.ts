import {
  isTimestampLike,
  type JudgementSnapshots,
} from '@shared/judgementHistory';

import { buildGoalDocument } from './buildGoalDocument';
import type { OnboardingDraft } from '../onboarding/types';
import type { GoalDocument } from './types';

/** 既に有効な目標を持つユーザーが登録しようとした場合のエラー(新規ユーザーのみを対象とする。既存目標の扱いは Phase 6) */
export class ActiveGoalAlreadyExistsError extends Error {
  constructor() {
    super('既に有効な目標が設定されています');
    this.name = 'ActiveGoalAlreadyExistsError';
  }
}

/**
 * サーバーのセキュリティルールに保存を拒否された場合のエラー(problem P-021)。
 * goals の startDate は端末が計算した「今日」(buildGoalDocument が params.now から計算)だが、
 * ルールはサーバー側の時計(request.time)の日本時間の今日と一致することを要求する。
 * 端末の日付・時刻が大きくずれていると、この不一致で保存が拒否される。
 * 画面側の文言(「端末の日付と時刻を確認してください」等)は 3-5c-2 で表示する
 */
export class GoalRejectedByServerError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super('サーバーのルールに保存を拒否されました(端末の日付・時刻がずれている可能性があります)');
    this.name = 'GoalRejectedByServerError';
    this.cause = cause;
  }
}

/**
 * Firestore(JS SDK・@react-native-firebase/firestore のいずれも)が security rules の
 * allow 条件を満たさなかった場合に投げるエラーかどうかを判定する。
 * JS SDK は code が 'permission-denied'、RNFB は 'firestore/permission-denied' になる
 * (node_modules/@react-native-firebase/app/lib/internal/NativeFirebaseError.ts の
 * `${namespace}/${code}` 形式を Emulator 上の実測で確認済み)
 */
function isPermissionDeniedError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.endsWith('permission-denied');
}

/** users/{uid} ドキュメントの、保存処理が参照する最小限の形 */
export type UserDocSnapshot = {
  exists(): boolean;
  data(): Record<string, unknown> | undefined;
};

/**
 * Firestore への書き込みをまとめて行うためのトランザクション操作(保存処理から見た最小限の形)。
 * `Ref` は実際のドキュメント参照の型(@react-native-firebase/firestore・firebase/firestore のいずれでも、
 * 同じ関数形(doc/collection/runTransaction)の modular API を満たせば構造的に当てはまる)
 */
export type SaveGoalTransaction<Ref> = {
  get: (ref: Ref) => Promise<UserDocSnapshot>;
  set: (ref: Ref, data: Record<string, unknown>, options?: { merge?: boolean }) => unknown;
};

/** 保存処理が必要とする Firestore 操作(doc 参照の作成とトランザクション実行) */
export type SaveGoalFirestoreDeps<Ref> = {
  /** users/{uid} の参照を返す */
  getUserDocRef: (uid: string) => Ref;
  /** users/{uid}/goals 配下に新しい goalId(自動生成)の参照を作る */
  createGoalDocRef: (uid: string) => { ref: Ref; id: string };
  runTransaction: <T>(updateFunction: (tx: SaveGoalTransaction<Ref>) => Promise<T>) => Promise<T>;
};

/**
 * 初回登録だけで使う履歴操作。
 * SDK固有のTimestamp検査とserverTimestampをadapterから注入する。
 * 既存のSaveGoalFirestoreDepsを継承する置換経路には必須化しない。
 */
export type SaveGoalHistoryDeps<Ref> = {
  isTimestamp: (value: unknown) => boolean;
  getEntryDocRef: (uid: string, revision: number) => Ref;
  serverTimestamp: () => unknown;
};

export type SaveGoalDeps<Ref> = SaveGoalFirestoreDeps<Ref> & {
  /** native初回保存ではtransactionの外で本人の判定履歴を初期化する。legacy純粋依存は省略可 */
  prepareHistory?: (uid: string) => Promise<void>;
  /** native保存のUID拘束。transactionの再試行でも現在の本人を確認する */
  getCurrentUid?: () => string | null;
  /** legacyでは省略可能。metadataが存在する場合は必須 */
  history?: SaveGoalHistoryDeps<Ref>;
  /** 保存に成功した後に一時保存(3-1)を消す(storage.ts の clearOnboardingDraft を渡す) */
  clearOnboardingDraft: () => Promise<void>;
};

export type SaveGoalParams = {
  uid: string;
  draft: OnboardingDraft;
  /** 現在時刻(epoch ミリ秒)。目標の開始日(登録日)の計算に使う。テスト可能にするため呼び出し側から渡す */
  now: number;
};

export type SaveGoalResult = {
  goalId: string;
  goal: GoalDocument;
};

const JUDGEMENT_STREAMS = ['goal', 'settings', 'xLink', 'subscription'] as const;

/** 両metadata absentだけをlegacyとして扱う。壊れたmetadataは書込み前に拒否する。 */
function initialGoalRevisions<Ref>(
  user: Record<string, unknown>,
  history: SaveGoalHistoryDeps<Ref> | undefined,
): (Record<string, unknown> & { goal: number }) | null {
  const hasStartedAt = Object.prototype.hasOwnProperty.call(user, 'judgementHistoryStartedAt');
  const hasRevisions = Object.prototype.hasOwnProperty.call(user, 'judgementRevisions');
  if (!hasStartedAt && !hasRevisions) return null;

  const revisions = user.judgementRevisions;
  if (
    !hasStartedAt
    || !hasRevisions
    || !history
    || !history.isTimestamp(user.judgementHistoryStartedAt)
    || !isTimestampLike(user.judgementHistoryStartedAt)
    || typeof revisions !== 'object'
    || revisions === null
    || Array.isArray(revisions)
  ) {
    throw new Error('判定履歴のmetadataまたは保存依存が不正です');
  }
  const counters = revisions as Record<string, unknown>;
  for (const stream of JUDGEMENT_STREAMS) {
    const revision = counters[stream];
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision <= 0) {
      throw new Error('判定履歴のrevisionが不正です');
    }
  }
  if (!Number.isSafeInteger((counters.goal as number) + 1)) {
    throw new Error('判定履歴のrevisionが上限に達しています');
  }
  return counters as Record<string, unknown> & { goal: number };
}

/**
 * draft(受験・資格)から goals/{goalId} を作り、users/{uid} の activeGoalId を設定する(requirements 4-5, 5)。
 * - 既に有効な目標がある(users/{uid}.activeGoalId が設定済み)場合は何も書き込まず ActiveGoalAlreadyExistsError を投げる
 *   (このタスクでは新規ユーザーのみを対象とする。既存目標がある場合の扱いは Phase 6)
 * - goals の作成と users.activeGoalId の更新は1つのトランザクションで行い、
 *   途中で失敗して goals だけ残る状態を作らない
 * - 保存に成功したら一時保存(3-1)を消す
 */
export async function saveGoal<Ref>(
  deps: SaveGoalDeps<Ref>,
  params: SaveGoalParams,
): Promise<SaveGoalResult> {
  const goal = buildGoalDocument(params.draft, params.now);

  const assertCurrentUid = () => {
    if (deps.getCurrentUid && (!params.uid || deps.getCurrentUid() !== params.uid)) {
      throw new Error('目標保存中に認証ユーザーが変わりました');
    }
  };
  assertCurrentUid();
  // callbackの再試行で初期化を繰り返さない。入力不正・初期化失敗時は保存もdraft消去もしない。
  if (deps.prepareHistory) {
    await deps.prepareHistory(params.uid);
    assertCurrentUid();
  }

  // Firestoreがcallbackを再試行しても、同じgoal参照を使う。
  let goalDoc: { ref: Ref; id: string } | undefined;
  let goalId: string;
  try {
    goalId = await deps.runTransaction(async (tx) => {
      assertCurrentUid();
      const userRef = deps.getUserDocRef(params.uid);
      const userSnapshot = await tx.get(userRef);
      assertCurrentUid();
      const user = userSnapshot.exists() ? userSnapshot.data() ?? {} : {};
      const existingActiveGoalId = user.activeGoalId ?? null;
      if (existingActiveGoalId) {
        throw new ActiveGoalAlreadyExistsError();
      }

      const revisions = initialGoalRevisions(user, deps.history);
      if (revisions && existingActiveGoalId !== null) {
        throw new Error('初回目標登録の旧pointerが不正です');
      }

      const { ref: goalRef, id } = goalDoc ??= deps.createGoalDocRef(params.uid);
      if (revisions) {
        // initialGoalRevisionsでhistoryの存在を検査済み。skipする分岐は設けない。
        const history = deps.history!;
        const revision = revisions.goal + 1;
        const entryRef = history.getEntryDocRef(params.uid, revision);
        const after: NonNullable<JudgementSnapshots['goal']> = {
          goalId: id,
          startDate: goal.startDate,
          examDate: goal.examDate,
          minDailyMinutes: goal.minDailyMinutes,
          goalDailyMinutes: goal.goalDailyMinutes,
        };
        const entry = {
          schemaVersion: 1,
          revision,
          committedAt: history.serverTimestamp(),
          before: null,
          after,
        };
        tx.set(goalRef, goal);
        tx.set(userRef, {
          activeGoalId: id,
          judgementRevisions: { ...revisions, goal: revision },
        }, { merge: true });
        tx.set(entryRef, entry);
      } else {
        tx.set(goalRef, goal);
        tx.set(userRef, { activeGoalId: id }, { merge: true });
      }
      return id;
    });
  } catch (error) {
    if (error instanceof ActiveGoalAlreadyExistsError) {
      throw error;
    }
    if (isPermissionDeniedError(error)) {
      throw new GoalRejectedByServerError(error);
    }
    throw error;
  }

  assertCurrentUid();
  await deps.clearOnboardingDraft();

  return { goalId, goal };
}
