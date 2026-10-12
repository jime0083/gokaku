/**
 * 計測中の状態(5-3c-3。requirements 3-2「アプリとロック画面の計測の共有」)。
 * App Group に 1 件だけ置く値の形。アプリ・ロック画面(ライブアクティビティ・ロック画面コントロール)の
 * どちらで開始した計測でも同じ形で持ち、どちらからも読み書き・消去できる。
 * startAt・confirmations は epoch ミリ秒(shared/studyCheck.ts の CheckedStudySession と対応する形)
 */
export type ActiveStudySession = {
  sessionId: string;
  uid: string;
  goalId: string;
  /** 計測開始時刻(epoch ミリ秒) */
  startAt: number;
  checkEnabled: boolean;
  /** 「勉強中」と応答した時刻(epoch ミリ秒)の配列。順不同 */
  confirmations: number[];
};

/**
 * ロック画面(ライブアクティビティの停止ボタン。StopStudyIntent)で止めた最後の計測
 * (5-3c-5a。requirements 3-2「ロック画面で止めたあとにアプリを開いたときは…」)。
 * App Group に 1 件だけ置く(上書き)。stopAt は epoch ミリ秒
 */
export type LastLockscreenStop = {
  sessionId: string;
  stopAt: number;
};
