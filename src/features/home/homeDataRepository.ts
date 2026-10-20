/**
 * ホーム画面(6-1)が必要とするデータの読み込み(画面から切り離した層)。
 *
 * 積み上げ時間の計算(shared/homeSummary.ts)には、現在の目標の開始日〜今日までの
 * 判定済みの日(dailyResults)と、判定していない日の計測(sessions)が必要になる。
 * 端末内の保存(src/features/timer/storage.ts)は「今日の勉強時間」の表示にしか使わないため
 * 今日と昨日にかかる分しか残していない(pruneOldSessions)。課金切れで何日も判定されなかった期間が
 * あると、その間のセッションは端末からは失われているため、サーバー(Firestore の
 * users/{uid}/sessions)から現在の目標(goalId)の分をすべて読む(requirements 3-3)。
 * dailyResults も同様に、現在の目標の分をすべて Firestore から読む。
 *
 * セキュリティルール(firestore.rules)は users/{uid} 配下を本人が読める
 * (`match /{document=**} { allow read: if isOwner(uid); }`)ため、
 * サブコレクション(goals・dailyResults・sessions)への where 絞り込みのクエリも本人は実行できる。
 *
 * @react-native-firebase/* は src/config/firebase.ts と同じ理由で、実際に呼び出す関数の中でだけ
 * require する(型だけ import type で取る)
 */
import type * as RNFBApp from '@react-native-firebase/app';
import type * as RNFBFirestore from '@react-native-firebase/firestore';
import type { DateKey, HomeDailyResult, HomeGoal, JudgementSession } from '@shared/index';

import { getCurrentUid } from '@/config/firebase';
import { parseEditableGoal } from '@/features/goals/editGoalRepository';
import type { GoalDocument } from '@/features/goals/types';

/**
 * X の投稿失敗・連携切れのお知らせ(requirements 4-6)。
 * users.xNotice の実際の形は 7-3c で決まる(現時点は未決定)。ここでは表示する場所だけ用意するため、
 * 本番の fetchHomeData は常に null を返す(xNotice フィールドを読まない)。
 * 7-3c で、実際の形に合わせてこの型と読み込みを差し替える
 */
export type HomeNotice = { message: string } | null;

export type HomeData = {
  goalId: string;
  goal: HomeGoal;
  goalDocument?: GoalDocument;
  dailyResults: readonly HomeDailyResult[];
  sessions: readonly JudgementSession[];
  notice: HomeNotice;
};

export type HomeDataResult =
  | { status: 'ok'; data: HomeData }
  /** ログインしていない・有効な目標がない(本来のユーザーには起きない。timer.tsx と同じ開発用フォールバック) */
  | { status: 'no_goal' }
  /** 通信エラー・データの形が不正などで読み込めなかった(requirements 4-8) */
  | { status: 'error' };

/** goals/{goalId} のうち、ホームの計算(shared/homeSummary.ts)に必要な項目を取り出す。形が不正なら null */
function parseGoal(data: Record<string, unknown> | undefined): HomeGoal | null {
  const startDate = data?.startDate;
  const examDate = data?.examDate;
  const targetHours = data?.targetHours;
  if (typeof startDate !== 'string' || typeof examDate !== 'string' || typeof targetHours !== 'number') {
    return null;
  }
  return { startDate: startDate as DateKey, examDate: examDate as DateKey, targetHours };
}

/** dailyResults/{date} の1件を HomeDailyResult に変換する。形が不正なら null */
function parseDailyResult(id: string, data: Record<string, unknown> | undefined): HomeDailyResult | null {
  const goalId = data?.goalId;
  const studiedMinutes = data?.studiedMinutes;
  if (typeof goalId !== 'string' || typeof studiedMinutes !== 'number') {
    return null;
  }
  return {
    date: id as DateKey,
    goalId,
    studiedMinutes,
    metMin: data?.metMin === true,
    metGoal: data?.metGoal === true,
  };
}

/** sessions/{sessionId} の1件を JudgementSession に変換する。形が不正なら null */
function parseSession(id: string, data: Record<string, unknown> | undefined): JudgementSession | null {
  const goalId = data?.goalId;
  const startAt = data?.startAt;
  if (typeof goalId !== 'string' || typeof startAt !== 'number') {
    return null;
  }
  const stopAt = data?.stopAt;
  const confirmations = data?.confirmations;
  return {
    id,
    goalId,
    startAt,
    stopAt: typeof stopAt === 'number' ? stopAt : null,
    checkEnabled: data?.checkEnabled === true,
    confirmations: Array.isArray(confirmations)
      ? confirmations.filter((value): value is number => typeof value === 'number')
      : [],
  };
}

/**
 * ホーム画面に必要なデータを読む(requirements 4-6, 3-3, 5)。
 * ログインしていない・有効な目標がない場合は 'no_goal'、通信エラー・データの形が不正な場合は 'error' を返す
 * (この関数の中で例外を投げない。呼び出し側は結果の status だけを見ればよい)
 */
export async function fetchHomeData(): Promise<HomeDataResult> {
  const uid = getCurrentUid();
  if (!uid) {
    return { status: 'no_goal' };
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getApp } = require('@react-native-firebase/app') as typeof RNFBApp;
    const { getFirestore, doc, getDoc, collection, query, where, getDocs } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('@react-native-firebase/firestore') as typeof RNFBFirestore;

    const firestore = getFirestore(getApp());

    const userSnapshot = await getDoc(doc(firestore, 'users', uid));
    const activeGoalId = userSnapshot.exists()
      ? (userSnapshot.data()?.activeGoalId as unknown)
      : null;
    if (typeof activeGoalId !== 'string' || activeGoalId.length === 0) {
      return { status: 'no_goal' };
    }

    const goalSnapshot = await getDoc(doc(firestore, 'users', uid, 'goals', activeGoalId));
    if (!goalSnapshot.exists()) {
      return { status: 'no_goal' };
    }
    const goal = parseGoal(goalSnapshot.data());
    if (!goal) {
      return { status: 'error' };
    }

    const dailyResultsSnapshot = await getDocs(
      query(collection(firestore, 'users', uid, 'dailyResults'), where('goalId', '==', activeGoalId)),
    );
    const dailyResults = dailyResultsSnapshot.docs
      .map((docSnap) => parseDailyResult(docSnap.id, docSnap.data()))
      .filter((value): value is HomeDailyResult => value !== null);

    const sessionsSnapshot = await getDocs(
      query(collection(firestore, 'users', uid, 'sessions'), where('goalId', '==', activeGoalId)),
    );
    const sessions = sessionsSnapshot.docs
      .map((docSnap) => parseSession(docSnap.id, docSnap.data()))
      .filter((value): value is JudgementSession => value !== null);

    return {
      status: 'ok',
      data: {
        goalId: activeGoalId,
        goal,
        goalDocument: parseEditableGoal(goalSnapshot.data()),
        dailyResults,
        sessions,
        // xNotice の形が決まっていない(7-3c)ため読まない。常に null(お知らせなし)
        notice: null,
      },
    };
  } catch {
    return { status: 'error' };
  }
}
