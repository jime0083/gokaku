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

export type SaveGoalDeps<Ref> = SaveGoalFirestoreDeps<Ref> & {
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

  let goalId: string;
  try {
    goalId = await deps.runTransaction(async (tx) => {
      const userRef = deps.getUserDocRef(params.uid);
      const userSnapshot = await tx.get(userRef);
      const existingActiveGoalId = userSnapshot.exists()
        ? (userSnapshot.data()?.activeGoalId as string | null | undefined) ?? null
        : null;
      if (existingActiveGoalId) {
        throw new ActiveGoalAlreadyExistsError();
      }

      const { ref: goalRef, id } = deps.createGoalDocRef(params.uid);
      tx.set(goalRef, goal);
      tx.set(userRef, { activeGoalId: id }, { merge: true });
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

  await deps.clearOnboardingDraft();

  return { goalId, goal };
}
