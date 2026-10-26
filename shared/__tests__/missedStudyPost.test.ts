import type { DailyResultDraft } from '../dailyJudgement';
import { addDays } from '../date';
import { buildMissedStudyPost as exportedBuilder } from '../index';
import { buildMissedStudyPost } from '../missedStudyPost';

const GOAL_ID = 'goal-current';
const DATE = '2026-10-26';
type Input = Parameters<typeof buildMissedStudyPost>[0];
const result = (date: string, metMin = false, goalId = GOAL_ID) => ({ date, goalId, metMin });
const input = (overrides: Partial<Input> = {}): Input => ({
  goalId: GOAL_ID,
  date: DATE,
  dailyResults: [result(DATE)],
  ...overrides,
});
const buildUnchecked = (value: unknown) => buildMissedStudyPost(value as Input);

// 7-3a: 投稿可否は判定せず、確定した未達成日の数と投稿素材だけを返す。
describe('buildMissedStudyPost', () => {
  it('承認済みの固定6行をURL・末尾改行なしで返し、画像を分離する', () => {
    expect(buildMissedStudyPost(input())).toEqual({
      text: '本日の最低目標学習時間を達成できませんでした\nまた明日から頑張ります\n勉強時間をフォロワーがチェックし勉強をサボれなくするアプリ\n#合格ウォッチ\n#今月1回目\n#累計1回目',
      mediaIds: [],
      counts: { monthlyMissedDays: 1, totalMissedDays: 1 },
    });
    const mediaIds: readonly string[] = buildMissedStudyPost(input()).mediaIds;
    expect(mediaIds).toEqual([]);
  });

  it('月をまたぐと今月だけを数え直し、対象日も累計に含める', () => {
    const post = buildMissedStudyPost(input({
      date: '2026-11-01',
      dailyResults: [result('2026-10-30'), result('2026-10-31'), result('2026-11-01')],
    }));
    expect(post.counts).toEqual({ monthlyMissedDays: 1, totalMissedDays: 3 });
    expect(post.text).toContain('#今月1回目\n#累計3回目');
  });

  it('年をまたいでも前年同月を今月に含めず、累計には含める', () => {
    const post = buildMissedStudyPost(input({
      date: '2027-01-01',
      dailyResults: [result('2026-01-01'), result('2026-12-31'), result('2027-01-01')],
    }));
    expect(post.counts).toEqual({ monthlyMissedDays: 1, totalMissedDays: 3 });
  });

  it('閏日の未達成を数え、翌月には月の回数だけを数え直す', () => {
    const dailyResults = [result('2028-02-28'), result('2028-02-29'), result('2028-03-01')];
    expect(buildMissedStudyPost(input({ date: '2028-02-29', dailyResults })).counts)
      .toEqual({ monthlyMissedDays: 2, totalMissedDays: 2 });
    expect(buildMissedStudyPost(input({ date: '2028-03-01', dailyResults })).counts)
      .toEqual({ monthlyMissedDays: 1, totalMissedDays: 3 });
  });

  it('目標変更後も同月の旧goal未達成をNへ引き継ぎ、Mだけ新goalで数え直す', () => {
    const dailyResults = [
      result('2026-09-30', false, 'goal-old'),
      result('2026-10-01', false, 'goal-old'),
      result('2026-10-25', false, 'goal-old'),
      result(DATE),
    ];
    const post = buildMissedStudyPost(input({ dailyResults }));
    expect(post.counts).toEqual({ monthlyMissedDays: 3, totalMissedDays: 1 });
    expect(post.text.split('\n').slice(4)).toEqual(['#今月3回目', '#累計1回目']);
    expect(buildMissedStudyPost(input({ dailyResults: dailyResults.slice(1) }))).toEqual(post);
  });

  it('達成済み・欠落した未判定日・対象日より未来の結果を数えない', () => {
    const dailyResults = [
      result('2026-10-22'), result('2026-10-24', true), result(DATE),
      result('2026-10-27'), result('2026-11-01'),
    ];
    expect(buildMissedStudyPost(input({ dailyResults })).counts)
      .toEqual({ monthlyMissedDays: 2, totalMissedDays: 2 });
  });

  it('全postStatusと開始日・投稿OFF・未連携の未達成を数え、投稿可否で拒否しない', () => {
    const statuses = ['none', 'pending', 'posted', 'failed', 'skipped'] as const;
    const reasons = ['start_date', 'x_post_disabled', 'x_not_linked'] as const;
    const dailyResults: (DailyResultDraft & { date: string })[] = [
      ...statuses.map((postStatus, index) => ({
        ...result(addDays('2026-10-01', index)), studiedMinutes: 0, metGoal: false,
        postStatus, postSkipReasons: [],
      })),
      ...reasons.map((reason, index) => ({
        ...result(addDays('2026-10-10', index)), studiedMinutes: 0, metGoal: false,
        postStatus: 'skipped' as const, postSkipReasons: [reason],
      })),
    ];
    for (const target of dailyResults) {
      const expected = dailyResults.filter((row) => row.date <= target.date).length;
      expect(buildMissedStudyPost(input({ date: target.date, dailyResults })).counts)
        .toEqual({ monthlyMissedDays: expected, totalMissedDays: expected });
    }
  });

  it('順序に依存せず、readonly配列と各要素を変更しない', () => {
    const dailyResults = Object.freeze([
      Object.freeze(result(DATE)), Object.freeze(result('2026-09-30')),
      Object.freeze(result('2026-10-01')), Object.freeze(result('2026-10-02', true)),
    ]);
    const before = dailyResults.map((row) => ({ ...row }));
    const post = buildMissedStudyPost(input({ dailyResults }));
    expect(post.counts).toEqual({ monthlyMissedDays: 2, totalMissedDays: 3 });
    expect(buildMissedStudyPost(input({ dailyResults: [...dailyResults].reverse() }))).toEqual(post);
    expect(dailyResults).toEqual(before);
  });

  it('同date・goalId・metMinが同じ重複は旧goalも含め1日として扱う', () => {
    const dailyResults = [
      result('2026-10-23', false, 'goal-old'), result('2026-10-23', false, 'goal-old'),
      result('2026-10-24', true), result('2026-10-24', true),
      result('2026-10-25'), result('2026-10-25'), result(DATE), result(DATE),
    ];
    const post = buildMissedStudyPost(input({ dailyResults }));
    expect(post.counts).toEqual({ monthlyMissedDays: 3, totalMissedDays: 2 });
    expect(buildMissedStudyPost(input({ dailyResults: [...dailyResults].reverse() }))).toEqual(post);
  });

  it('同goal・同dateでmetMinが衝突したら順序によらずRangeError', () => {
    for (const date of ['2026-10-25', DATE]) {
      const dailyResults = [result(date), result(date, true), result(DATE)];
      expect(() => buildMissedStudyPost(input({ dailyResults }))).toThrow(RangeError);
      expect(() => buildMissedStudyPost(input({ dailyResults: [...dailyResults].reverse() })))
        .toThrow(RangeError);
    }
  });

  it('同dateのgoalIdが衝突したらmetMinや順序・対象期間によらずRangeError', () => {
    for (const date of ['2026-09-30', '2026-10-25', DATE, '2026-10-27']) {
      for (const metMin of [false, true]) {
        const dailyResults = [result(date, metMin, 'goal-old'), result(date), result(DATE)];
        expect(() => buildMissedStudyPost(input({ dailyResults }))).toThrow(RangeError);
        expect(() => buildMissedStudyPost(input({ dailyResults: [...dailyResults].reverse() })))
          .toThrow(RangeError);
      }
    }
  });

  it('NとMは半角数字で、累計1000以上でも桁区切りを付けない', () => {
    const dailyResults = Array.from({ length: 1001 }, (_, index) => result(addDays(DATE, -index)));
    const post = buildMissedStudyPost(input({ dailyResults }));
    expect(post.counts).toEqual({ monthlyMissedDays: 26, totalMissedDays: 1001 });
    expect(post.text.split('\n').slice(4)).toEqual(['#今月26回目', '#累計1001回目']);
  });

  it('対象dateの形式・実在性・実行時の型が不正ならRangeError', () => {
    for (const date of ['', '2026-2-01', '2026-02-29', '2026-13-01', '2026-10-26T00:00:00+09:00', null, 20261026]) {
      expect(() => buildUnchecked({ ...input(), date })).toThrow(RangeError);
    }
  });

  it('対象goalIdが空・空白のみ・文字列以外ならRangeError', () => {
    for (const goalId of ['', '  ', null, undefined, 1]) {
      expect(() => buildUnchecked({ ...input(), goalId })).toThrow(RangeError);
    }
  });

  it('入力結果のdateが不正ならRangeError', () => {
    for (const date of ['', '2026-02-30', '2026-10-1', null, undefined, 1]) {
      expect(() => buildUnchecked({
        ...input(), dailyResults: [result(DATE), { ...result('2026-10-01'), date }],
      })).toThrow(RangeError);
    }
  });

  it('入力結果のgoalIdが不正ならRangeError', () => {
    for (const goalId of ['', '  ', null, undefined, 1]) {
      expect(() => buildUnchecked({
        ...input(), dailyResults: [result(DATE), { ...result('2026-10-01'), goalId }],
      })).toThrow(RangeError);
    }
  });

  it('入力結果のmetMinがboolean以外・欠落ならRangeError', () => {
    for (const metMin of [undefined, null, 0, 1, 'false']) {
      expect(() => buildUnchecked({
        ...input(), dailyResults: [result(DATE), { ...result('2026-10-01'), metMin }],
      })).toThrow(RangeError);
    }
    expect(() => buildUnchecked({
      ...input(), dailyResults: [result(DATE), { date: '2026-10-01', goalId: GOAL_ID }],
    })).toThrow(RangeError);
  });

  it('対象日の同goalの結果が欠けていたらRangeError', () => {
    for (const dailyResults of [[], [result('2026-10-25')], [result(DATE, false, 'goal-old')]]) {
      expect(() => buildMissedStudyPost(input({ dailyResults }))).toThrow(RangeError);
    }
  });

  it('対象日が達成済みならRangeError', () => {
    expect(() => buildMissedStudyPost(input({ dailyResults: [result(DATE, true)] })))
      .toThrow(RangeError);
  });

  it('shared/indexから同じAPIを公開する', () => {
    expect(exportedBuilder).toBe(buildMissedStudyPost);
  });
});
