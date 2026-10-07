/**
 * アプリと Cloud Functions で共有するドメインロジック(日付・日割り・確認による停止・判定・ペース計算)。
 *
 * 制約:
 * - 外部依存なしの純粋な TypeScript(React Native・firebase 等を import しない)
 * - モジュール間の import は拡張子なしの相対パス(Metro と functions の nodenext(CommonJS)の両方で解決できる形)
 * - 現在時刻は Date.now() で取得せず、引数で受け取る
 *
 * 利用方法:
 * - アプリ: `import { ... } from '@shared/index'`(tsconfig の paths)
 * - functions: `functions/src/domain.ts` 経由で import する
 */
export * from './certifications';
export * from './dailyJudgement';
export * from './date';
export * from './displayNumber';
export * from './estimatedHours';
export * from './homeSummary';
export * from './pace';
export * from './studyCheck';
export * from './studyTime';
