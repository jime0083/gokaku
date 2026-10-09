import { addDays, jstStartOfDay } from '@shared/index';

import { INITIAL_ONBOARDING_DRAFT, OTHER_CERTIFICATION_ID, type OnboardingDraft } from '../../onboarding/types';
import { buildGoalDocument } from '../buildGoalDocument';

const REGISTER_DATE = '2027-01-01';
const NOW = jstStartOfDay(REGISTER_DATE) + 1000; // 登録日の 0:00 の少し後
const EXAM_DATE = addDays(REGISTER_DATE, 30);

const examDraft = (overrides: Partial<OnboardingDraft> = {}): OnboardingDraft => ({
  ...INITIAL_ONBOARDING_DRAFT,
  type: 'exam',
  university: '合格大学',
  targetDeviationText: '60.0',
  currentDeviationText: '50.0',
  subjectCount: 3,
  targetHoursText: '1800',
  autoFilledTargetHoursText: '1800',
  examDate: EXAM_DATE,
  minDailyMinutes: 60,
  goalDailyMinutes: 120,
  ...overrides,
});

const certDraft = (overrides: Partial<OnboardingDraft> = {}): OnboardingDraft => ({
  ...INITIAL_ONBOARDING_DRAFT,
  type: 'cert',
  certId: 'it-passport',
  targetHoursText: '100',
  autoFilledTargetHoursText: '100',
  examDate: EXAM_DATE,
  minDailyMinutes: 30,
  goalDailyMinutes: 60,
  ...overrides,
});

describe('buildGoalDocument(受験ルート)', () => {
  it('有効な draft から exam の goal ドキュメントを組み立てる', () => {
    const goal = buildGoalDocument(examDraft(), NOW);

    expect(goal).toEqual({
      type: 'exam',
      university: '合格大学',
      targetDeviation: 60.0,
      currentDeviation: 50.0,
      subjectCount: 3,
      estimatedHours: { status: 'ok', lowerHours: 1080, upperHours: 1800 },
      targetHours: 1800,
      examDate: EXAM_DATE,
      minDailyMinutes: 60,
      goalDailyMinutes: 120,
      startDate: REGISTER_DATE,
      status: 'active',
      createdAt: NOW,
    });
  });

  it('目標大学の前後の空白を取り除く', () => {
    const goal = buildGoalDocument(examDraft({ university: '  合格大学  ' }), NOW);
    expect(goal.type === 'exam' && goal.university).toBe('合格大学');
  });

  it('目標偏差値 ≤ 現在の偏差値の場合 estimatedHours は not_needed', () => {
    const goal = buildGoalDocument(
      examDraft({ targetDeviationText: '50.0', currentDeviationText: '50.0' }),
      NOW,
    );
    expect(goal.estimatedHours).toEqual({ status: 'not_needed' });
  });

  it('目標大学が未入力の場合は RangeError', () => {
    expect(() => buildGoalDocument(examDraft({ university: '' }), NOW)).toThrow(RangeError);
  });

  it('目標大学が51文字の場合は RangeError', () => {
    expect(() => buildGoalDocument(examDraft({ university: 'あ'.repeat(51) }), NOW)).toThrow(
      RangeError,
    );
  });

  it('偏差値が範囲外(24.9)の場合は RangeError', () => {
    expect(() => buildGoalDocument(examDraft({ targetDeviationText: '24.9' }), NOW)).toThrow(
      RangeError,
    );
  });

  it('科目数が範囲外(9)の場合は RangeError', () => {
    expect(() => buildGoalDocument(examDraft({ subjectCount: 9 }), NOW)).toThrow(RangeError);
  });

  it('type が null の場合は RangeError', () => {
    expect(() => buildGoalDocument(examDraft({ type: null }), NOW)).toThrow(RangeError);
  });
});

describe('buildGoalDocument(資格ルート)', () => {
  it('一覧にある資格から cert の goal ドキュメントを組み立てる', () => {
    const goal = buildGoalDocument(certDraft(), NOW);

    expect(goal).toEqual({
      type: 'cert',
      certId: 'it-passport',
      certOtherName: '',
      estimatedHours: { status: 'ok', lowerHours: null, upperHours: 100 },
      targetHours: 100,
      examDate: EXAM_DATE,
      minDailyMinutes: 30,
      goalDailyMinutes: 60,
      startDate: REGISTER_DATE,
      status: 'active',
      createdAt: NOW,
    });
  });

  it('「その他」の場合は certOtherName を使い、estimatedHours は null', () => {
    const goal = buildGoalDocument(
      certDraft({ certId: OTHER_CERTIFICATION_ID, certOtherName: '  自作資格  ', targetHoursText: '500' }),
      NOW,
    );

    expect(goal).toEqual(
      expect.objectContaining({
        type: 'cert',
        certId: OTHER_CERTIFICATION_ID,
        certOtherName: '自作資格',
        estimatedHours: null,
      }),
    );
  });

  it('certId が未選択(null)の場合は RangeError', () => {
    expect(() => buildGoalDocument(certDraft({ certId: null }), NOW)).toThrow(RangeError);
  });

  it('「その他」で資格名が未入力の場合は RangeError', () => {
    expect(() =>
      buildGoalDocument(certDraft({ certId: OTHER_CERTIFICATION_ID, certOtherName: '' }), NOW),
    ).toThrow(RangeError);
  });

  it('一覧にない certId(「その他」以外)の場合は RangeError', () => {
    expect(() => buildGoalDocument(certDraft({ certId: 'no-such-cert' }), NOW)).toThrow(RangeError);
  });
});

describe('buildGoalDocument(共通の入力チェック)', () => {
  it('試験日が未選択(null)の場合は RangeError', () => {
    expect(() => buildGoalDocument(examDraft({ examDate: null }), NOW)).toThrow(RangeError);
  });

  it('試験日が登録日と同じ(明日以降ではない)場合は RangeError', () => {
    expect(() => buildGoalDocument(examDraft({ examDate: REGISTER_DATE }), NOW)).toThrow(RangeError);
  });

  it('目標勉強時間が未入力の場合は RangeError', () => {
    expect(() => buildGoalDocument(examDraft({ targetHoursText: '' }), NOW)).toThrow(RangeError);
  });

  it('目標勉強時間が範囲外(20001)の場合は RangeError', () => {
    expect(() => buildGoalDocument(examDraft({ targetHoursText: '20001' }), NOW)).toThrow(RangeError);
  });

  it('1日の最低勉強時間が未確定(null)の場合は RangeError', () => {
    expect(() => buildGoalDocument(examDraft({ minDailyMinutes: null }), NOW)).toThrow(RangeError);
  });

  it('1日の最低勉強時間が10分刻みでない場合は RangeError', () => {
    expect(() => buildGoalDocument(examDraft({ minDailyMinutes: 65 }), NOW)).toThrow(RangeError);
  });

  it('努力目標が最低勉強時間未満の場合は RangeError', () => {
    expect(() =>
      buildGoalDocument(examDraft({ minDailyMinutes: 120, goalDailyMinutes: 60 }), NOW),
    ).toThrow(RangeError);
  });
});
