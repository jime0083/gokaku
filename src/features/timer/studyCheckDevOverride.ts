/**
 * 開発ビルドだけで「勉強中？」確認の間隔・応答期限を短くする仕組み(5-3e-2。problem P-011 (3))。
 *
 * - 本番ビルド(__DEV__ が false)では一切動かない。isDev が false のときは必ず shared の既定値
 *   (STUDY_CHECK_INTERVAL_MS・STUDY_CHECK_RESPONSE_WINDOW_MS=60分・10分)を返し、ネイティブ(App Group)
 *   には一切触れない
 * - 開発ビルドでは、開発用の画面(src/app/dev-lockscreen-spike.tsx)の操作で設定を App Group に書く。
 *   アプリ(このファイル)と、ロック画面から開始したときの通知の予約
 *   (targets/_shared/StudySyncCore.swift の StudySyncCheckNotification)の両方が同じ設定を読む
 * - Swift 側は #if DEBUG の外では get/setStudyCheckDevOverride 自体が無い(本番ビルドには存在しない)。
 *   そのため isDev が true でも、本番ビルド相当(ネイティブ関数が無い)では例外を捕まえて既定値にする
 *
 * modules/study-sync/src/StudySyncModule は import すると requireNativeModule が即座に実行されるため
 * (lockscreenSync.ts・studySyncAuthContext.ts と同じ理由)、実際に呼ぶ関数の中でだけ require する
 */
import { STUDY_CHECK_INTERVAL_MS, STUDY_CHECK_RESPONSE_WINDOW_MS } from '@shared/index';

/** 開発ビルドで切り替える短い間隔(2分。requirements に無い開発専用の値) */
export const DEV_STUDY_CHECK_INTERVAL_MS = 2 * 60 * 1000;
/** 開発ビルドで切り替える短い応答期限(1分。requirements に無い開発専用の値) */
export const DEV_STUDY_CHECK_RESPONSE_WINDOW_MS = 1 * 60 * 1000;

export type StudyCheckTiming = {
  intervalMs: number;
  responseWindowMs: number;
};

const PRODUCTION_TIMING: StudyCheckTiming = {
  intervalMs: STUDY_CHECK_INTERVAL_MS,
  responseWindowMs: STUDY_CHECK_RESPONSE_WINDOW_MS,
};

type StudyCheckDevOverrideBridge = {
  getStudyCheckDevOverride(): { intervalMs: number; responseWindowMs: number } | null;
  setStudyCheckDevOverride(intervalMs: number | null, responseWindowMs: number | null): void;
};

/** require に失敗(ネイティブモジュール未登録。Jest 環境・#if DEBUG で関数が無い本番ビルドを含む)した場合は null */
function getBridge(): StudyCheckDevOverrideBridge | null {
  try {
    return (
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../../../modules/study-sync/src/StudySyncModule') as {
        default: StudyCheckDevOverrideBridge;
      }
    ).default;
  } catch {
    return null;
  }
}

function isValidOverride(value: { intervalMs: number; responseWindowMs: number } | null | undefined): boolean {
  return (
    !!value &&
    Number.isFinite(value.intervalMs) &&
    value.intervalMs > 0 &&
    Number.isFinite(value.responseWindowMs) &&
    value.responseWindowMs > 0
  );
}

/**
 * 実際に使う「勉強中？」確認の間隔・応答期限。
 * isDev が false(本番ビルド)のときは必ず shared の既定値(60分・10分)。
 * 開発ビルドで上書き設定が無い・読めない・形が不正な場合も既定値
 */
export function getStudyCheckTiming(isDev: boolean = __DEV__): StudyCheckTiming {
  if (!isDev) {
    return PRODUCTION_TIMING;
  }
  try {
    const override = getBridge()?.getStudyCheckDevOverride() ?? null;
    if (!isValidOverride(override)) {
      return PRODUCTION_TIMING;
    }
    return { intervalMs: override!.intervalMs, responseWindowMs: override!.responseWindowMs };
  } catch {
    return PRODUCTION_TIMING;
  }
}

/**
 * 開発用の画面(dev-lockscreen-spike)から呼ぶ。enabled=true で開発用の短い値(2分・1分)に切り替え、
 * false で本番の値(60分・10分)に戻す。isDev が false(本番ビルド)のときは何もしない
 */
export function setStudyCheckDevOverrideEnabled(enabled: boolean, isDev: boolean = __DEV__): void {
  if (!isDev) {
    return;
  }
  try {
    getBridge()?.setStudyCheckDevOverride(
      enabled ? DEV_STUDY_CHECK_INTERVAL_MS : null,
      enabled ? DEV_STUDY_CHECK_RESPONSE_WINDOW_MS : null,
    );
  } catch {
    // 無視する(開発用の機能。失敗しても本番の動きには影響しない)
  }
}

/** 開発用の画面で、今の設定(短い値に切り替わっているか)を表示するため。isDev が false なら常に false */
export function isStudyCheckDevOverrideEnabled(isDev: boolean = __DEV__): boolean {
  if (!isDev) {
    return false;
  }
  try {
    return isValidOverride(getBridge()?.getStudyCheckDevOverride() ?? null);
  } catch {
    return false;
  }
}
