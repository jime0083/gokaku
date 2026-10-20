import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, setLogLevel, writeBatch } from 'firebase/firestore';

import { addDays, toJstDateKey } from '@shared/index';

// テストごとに一意なプロジェクトIDを使い、他のテストのデータと共有しない(demo- 接頭辞で本番に接続しない)
const PROJECT_ID = `demo-gokaku-rules-${process.pid}-${Date.now()}`;
const OWNER_UID = 'owner-uid';
const OTHER_UID = 'other-uid';

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  // 拒否を期待するテストで SDK が出す PERMISSION_DENIED の警告ログを抑止する
  setLogLevel('error');
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync(resolve(__dirname, '../../firestore.rules'), 'utf8'),
    },
  });
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'users', OWNER_UID), { checkEnabled: true });
    await setDoc(doc(db, 'users', OWNER_UID, 'goals', 'goal-1'), { type: 'cert' });
    await setDoc(doc(db, 'xTokens', OWNER_UID), { expiresAt: 0 });
  });
});

afterAll(async () => {
  if (testEnv) {
    await testEnv.clearFirestore();
    await testEnv.cleanup();
  }
});

describe('users/{uid} の読み取り', () => {
  it('本人は自分のユーザードキュメントを読める', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertSucceeds(getDoc(doc(db, 'users', OWNER_UID)));
  });

  it('本人は自分の配下(goals)を読める', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertSucceeds(getDoc(doc(db, 'users', OWNER_UID, 'goals', 'goal-1')));
  });

  it('他人はユーザードキュメントを読めない', async () => {
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();

    await assertFails(getDoc(doc(db, 'users', OWNER_UID)));
  });

  it('他人は配下(goals)を読めない', async () => {
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();

    await assertFails(getDoc(doc(db, 'users', OWNER_UID, 'goals', 'goal-1')));
  });

  it('未ログインは読めない', async () => {
    const db = testEnv.unauthenticatedContext().firestore();

    await assertFails(getDoc(doc(db, 'users', OWNER_UID)));
  });
});

describe('デフォルト拒否', () => {
  it('本人でも xTokens は読めない', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(getDoc(doc(db, 'xTokens', OWNER_UID)));
  });

  it('本人でも許可されていない項目を書き込めない(3-5c-1 で許可した以外の項目はデフォルト拒否のまま)', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(setDoc(doc(db, 'users', OWNER_UID), { foo: 'bar' }, { merge: true }));
  });
});

// Phase 3-5c-1: users/{uid} のうち本人が書ける項目(activeGoalId・設定系)の書き込み許可(requirements 5)
describe('users/{uid} の書き込み(本人の目標・設定)', () => {
  it('本人でも既存の不完全なgoalへactiveGoalIdを切り替えられない', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(
      setDoc(doc(db, 'users', OWNER_UID), { activeGoalId: 'goal-1' }, { merge: true }),
    );
  });

  it('本人でも未設定activeGoalIdをnullへ変更できない', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(
      setDoc(doc(db, 'users', OWNER_UID), { activeGoalId: null }, { merge: true }),
    );
  });

  it('本人は checkEnabled・xPostEnabled を更新できる', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertSucceeds(
      setDoc(doc(db, 'users', OWNER_UID), { checkEnabled: false, xPostEnabled: true }, { merge: true }),
    );
  });

  it('activeGoalId に空文字は書き込めない', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(setDoc(doc(db, 'users', OWNER_UID), { activeGoalId: '' }, { merge: true }));
  });

  it('checkEnabled に bool 以外を書き込めない', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(setDoc(doc(db, 'users', OWNER_UID), { checkEnabled: 'yes' }, { merge: true }));
  });

  it('本人でも subscription を書き込めない(サーバー専用項目)', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(
      setDoc(
        doc(db, 'users', OWNER_UID),
        { subscription: { status: 'active', productId: 'premium.monthly' } },
        { merge: true },
      ),
    );
  });

  it('本人でも xLinked を書き込めない(サーバー専用項目)', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(setDoc(doc(db, 'users', OWNER_UID), { xLinked: true }, { merge: true }));
  });

  it('許可された項目とサーバー専用項目を同時に書き込もうとすると全体が拒否される', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(
      setDoc(
        doc(db, 'users', OWNER_UID),
        { activeGoalId: 'goal-1', subscription: { status: 'active' } },
        { merge: true },
      ),
    );
  });

  it('他人の users ドキュメントは更新できない', async () => {
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();

    await assertFails(
      setDoc(doc(db, 'users', OWNER_UID), { activeGoalId: 'goal-1' }, { merge: true }),
    );
  });

  it('未ログインは更新できない', async () => {
    const db = testEnv.unauthenticatedContext().firestore();

    await assertFails(
      setDoc(doc(db, 'users', OWNER_UID), { activeGoalId: 'goal-1' }, { merge: true }),
    );
  });
});

// Phase 3-5c-1: goals/{goalId} の新規作成(requirements 4-2・4-3・5、mokuhyo.txt 1 の範囲チェック)

async function createWithPointer(db: ReturnType<ReturnType<RulesTestEnvironment['authenticatedContext']>['firestore']>, owner: string, id: string, data: Record<string, unknown>) {
  // Read fixture metadata with admin privileges so non-owner tests reach the denied commit.
  let current: unknown;
  await testEnv.withSecurityRulesDisabled(async (context) => {
    current = (await getDoc(doc(context.firestore(), 'users', owner))).data()?.activeGoalId;
  });
  const batch = writeBatch(db);
  if (typeof current === 'string') batch.update(doc(db, 'users', owner, 'goals', current), { status: 'replaced' });
  batch.set(doc(db, 'users', owner, 'goals', id), data);
  batch.update(doc(db, 'users', owner), { activeGoalId: id });
  return batch.commit();
}
describe('users/{uid}/goals/{goalId} の作成', () => {
  // ルール(firestore.rules)は startDate がサーバー(request.time)の日本時間の「今日」と一致することを要求する(problem P-021)。
  // そのためテストの startDate も実行時点の今日を使う(固定の過去・未来日付だと常に拒否されてしまう)
  const TODAY_KEY = toJstDateKey(Date.now());
  const FAR_FUTURE_EXAM_DATE = addDays(TODAY_KEY, 30);
  const YESTERDAY_KEY = addDays(TODAY_KEY, -1);
  const FAR_FUTURE_KEY = addDays(TODAY_KEY, 365);

  const validExamGoal = {
    type: 'exam',
    university: '合格大学',
    targetDeviation: 60,
    currentDeviation: 50,
    subjectCount: 3,
    estimatedHours: { status: 'ok', lowerHours: 1080, upperHours: 1800 },
    targetHours: 1800,
    examDate: FAR_FUTURE_EXAM_DATE,
    minDailyMinutes: 60,
    goalDailyMinutes: 120,
    startDate: TODAY_KEY,
    status: 'active',
    createdAt: 1_735_689_600_000,
  };

  const validCertGoal = {
    type: 'cert',
    certId: 'it-passport',
    certOtherName: '',
    estimatedHours: { status: 'ok', lowerHours: null, upperHours: 100 },
    targetHours: 100,
    examDate: FAR_FUTURE_EXAM_DATE,
    minDailyMinutes: 30,
    goalDailyMinutes: 60,
    startDate: TODAY_KEY,
    status: 'active',
    createdAt: 1_735_689_600_000,
  };

  it('本人は有効な受験の goal を作成できる', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertSucceeds(createWithPointer(db, OWNER_UID, 'exam-goal', validExamGoal));
  });

  it('本人は有効な資格(一覧)の goal を作成できる', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertSucceeds(createWithPointer(db, OWNER_UID, 'cert-goal', validCertGoal));
  });

  it('本人は有効な資格(その他)の goal を作成できる', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertSucceeds(
      createWithPointer(db, OWNER_UID, 'cert-other-goal', {
        ...validCertGoal,
        certId: 'other',
        certOtherName: '自作資格',
        estimatedHours: null,
      }),
    );
  });

  it('偏差値が下限・上限そのもの(25.0・80.0)だと作成できる(firestore.rules は shared/ と別実装のため境界値自体も確認する)', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertSucceeds(
      createWithPointer(db, OWNER_UID, 'min-goal', {
        ...validExamGoal,
        targetDeviation: 25.0,
        currentDeviation: 25.0,
      }),
    );
    await assertSucceeds(
      createWithPointer(db, OWNER_UID, 'max-goal', {
        ...validExamGoal,
        targetDeviation: 80.0,
        currentDeviation: 25.0,
      }),
    );
  });

  it.each(['targetDeviation', 'currentDeviation'])('P-048: 新規作成の%sは0.1刻み以外を原子的に拒否する', async (field) => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();
    const userRef = doc(db, 'users', OWNER_UID);
    const before = (await getDoc(userRef)).data();
    for (const value of [60.05, 60.00001]) {
      const id = `invalid-${field}-${String(value).replace('.', '-')}`;
      await assertFails(createWithPointer(db, OWNER_UID, id, { ...validExamGoal, [field]: value }));
      expect((await getDoc(userRef)).data()).toEqual(before);
      expect((await getDoc(doc(db, 'users', OWNER_UID, 'goals', id))).exists()).toBe(false);
    }
  });

  it.each([25, 80, 60.1, 60.1000005])('P-048: 新規作成で両偏差値の正常刻み・許容差%sを受け入れる', async (value) => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();
    const id = 'valid-deviations';
    const goal = { ...validExamGoal, targetDeviation: value, currentDeviation: value };
    await assertSucceeds(createWithPointer(db, OWNER_UID, id, goal));
    expect((await getDoc(doc(db, 'users', OWNER_UID, 'goals', id))).data()).toEqual(goal);
    expect((await getDoc(doc(db, 'users', OWNER_UID))).data()?.activeGoalId).toBe(id);
  });

  it('偏差値が上限を1つ超える(80.1)だと作成できない', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(
      createWithPointer(db, OWNER_UID, 'bad-goal', {
        ...validExamGoal,
        targetDeviation: 80.1,
      }),
    );
  });

  it('偏差値が範囲外(24.9)だと作成できない', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(
      createWithPointer(db, OWNER_UID, 'bad-goal', {
        ...validExamGoal,
        targetDeviation: 24.9,
      }),
    );
  });

  it('受験科目数が下限・上限そのもの(1・8)だと作成できる', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertSucceeds(
      createWithPointer(db, OWNER_UID, 'min-goal', { ...validExamGoal, subjectCount: 1 }),
    );
    await assertSucceeds(
      createWithPointer(db, OWNER_UID, 'max-goal', { ...validExamGoal, subjectCount: 8 }),
    );
  });

  it('受験科目数が範囲外(0・9)だと作成できない', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(
      createWithPointer(db, OWNER_UID, 'bad-goal-0', { ...validExamGoal, subjectCount: 0 }),
    );
    await assertFails(
      createWithPointer(db, OWNER_UID, 'bad-goal-9', { ...validExamGoal, subjectCount: 9 }),
    );
  });

  it('目標勉強時間が下限・上限そのもの(1・20000)だと作成できる', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertSucceeds(
      createWithPointer(db, OWNER_UID, 'min-goal', { ...validExamGoal, targetHours: 1 }),
    );
    await assertSucceeds(
      createWithPointer(db, OWNER_UID, 'max-goal', { ...validExamGoal, targetHours: 20_000 }),
    );
  });

  it('目標勉強時間が範囲外(0・20001)だと作成できない', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(
      createWithPointer(db, OWNER_UID, 'bad-goal-0', { ...validExamGoal, targetHours: 0 }),
    );
    await assertFails(
      createWithPointer(db, OWNER_UID, 'bad-goal-20001', {
        ...validExamGoal,
        targetHours: 20_001,
      }),
    );
  });

  it('1日の最低・努力目標勉強時間が下限・上限そのもの(10分・960分)だと作成できる', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertSucceeds(
      createWithPointer(db, OWNER_UID, 'min-goal', {
        ...validExamGoal,
        minDailyMinutes: 10,
        goalDailyMinutes: 10,
      }),
    );
    await assertSucceeds(
      createWithPointer(db, OWNER_UID, 'max-goal', {
        ...validExamGoal,
        minDailyMinutes: 960,
        goalDailyMinutes: 960,
      }),
    );
  });

  it('1日の最低勉強時間が範囲外(0分・970分)・10分刻みでない(65分)と作成できない', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(
      createWithPointer(db, OWNER_UID, 'bad-goal-0', {
        ...validExamGoal,
        minDailyMinutes: 0,
        goalDailyMinutes: 10,
      }),
    );
    await assertFails(
      createWithPointer(db, OWNER_UID, 'bad-goal-970', {
        ...validExamGoal,
        minDailyMinutes: 970,
        goalDailyMinutes: 970,
      }),
    );
    await assertFails(
      createWithPointer(db, OWNER_UID, 'bad-goal-65', {
        ...validExamGoal,
        minDailyMinutes: 65,
      }),
    );
  });

  it('1日の努力目標勉強時間が最低勉強時間と同じ(境界の等しい場合)だと作成できる', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertSucceeds(
      createWithPointer(db, OWNER_UID, 'equal-goal', {
        ...validExamGoal,
        minDailyMinutes: 60,
        goalDailyMinutes: 60,
      }),
    );
  });

  it('1日の努力目標勉強時間が最低勉強時間未満だと作成できない', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(
      createWithPointer(db, OWNER_UID, 'bad-goal', {
        ...validExamGoal,
        minDailyMinutes: 120,
        goalDailyMinutes: 60,
      }),
    );
  });

  it('目標大学が下限・上限そのもの(1文字・50文字)だと作成できる', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertSucceeds(
      createWithPointer(db, OWNER_UID, 'min-goal', { ...validExamGoal, university: 'あ' }),
    );
    await assertSucceeds(
      createWithPointer(db, OWNER_UID, 'max-goal', {
        ...validExamGoal,
        university: 'あ'.repeat(50),
      }),
    );
  });

  it('目標大学が0文字・51文字だと作成できない', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(
      createWithPointer(db, OWNER_UID, 'bad-goal-0', { ...validExamGoal, university: '' }),
    );
    await assertFails(
      createWithPointer(db, OWNER_UID, 'bad-goal-51', {
        ...validExamGoal,
        university: 'あ'.repeat(51),
      }),
    );
  });

  it('type が exam/cert 以外だと作成できない', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(
      createWithPointer(db, OWNER_UID, 'bad-goal', { ...validExamGoal, type: 'other' }),
    );
  });

  it('status が active 以外だと作成できない', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(
      createWithPointer(db, OWNER_UID, 'bad-goal', { ...validExamGoal, status: 'finished' }),
    );
  });

  it('資格ルートの goal に受験専用フィールド(university 等)が混在すると作成できない', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(
      createWithPointer(db, OWNER_UID, 'bad-goal', {
        ...validCertGoal,
        university: '合格大学',
      }),
    );
  });

  // problem P-021: examDate・startDate のサーバー側検査(実在する日付・登録日は今日・試験日は登録日より後)
  describe('examDate・startDate の検査(problem P-021)', () => {
    it('examDate が不正な形式("not-a-date")だと作成できない', async () => {
      const db = testEnv.authenticatedContext(OWNER_UID).firestore();

      await assertFails(
        createWithPointer(db, OWNER_UID, 'bad-goal', {
          ...validExamGoal,
          examDate: 'not-a-date',
        }),
      );
    });

    it('startDate が実在しない日付("2027-02-30")だと作成できない', async () => {
      const db = testEnv.authenticatedContext(OWNER_UID).firestore();

      await assertFails(
        createWithPointer(db, OWNER_UID, 'bad-goal', {
          ...validExamGoal,
          startDate: '2027-02-30',
        }),
      );
    });

    it('examDate が実在しない日付("2027-02-30")だと作成できない', async () => {
      const db = testEnv.authenticatedContext(OWNER_UID).firestore();

      await assertFails(
        createWithPointer(db, OWNER_UID, 'bad-goal', {
          ...validExamGoal,
          examDate: '2027-02-30',
        }),
      );
    });

    it('startDate が examDate 以降(同じ日・それより後)だと作成できない', async () => {
      const db = testEnv.authenticatedContext(OWNER_UID).firestore();

      await assertFails(
        createWithPointer(db, OWNER_UID, 'bad-goal-same', {
          ...validExamGoal,
          examDate: TODAY_KEY,
        }),
      );
      await assertFails(
        createWithPointer(db, OWNER_UID, 'bad-goal-before', {
          ...validExamGoal,
          examDate: YESTERDAY_KEY,
        }),
      );
    });

    it('startDate が日本時間の今日でない(昨日)と作成できない', async () => {
      const db = testEnv.authenticatedContext(OWNER_UID).firestore();

      await assertFails(
        createWithPointer(db, OWNER_UID, 'bad-goal', {
          ...validExamGoal,
          startDate: YESTERDAY_KEY,
          examDate: TODAY_KEY,
        }),
      );
    });

    it('startDate が日本時間の今日でない(明日)と作成できない', async () => {
      const db = testEnv.authenticatedContext(OWNER_UID).firestore();
      const tomorrowKey = addDays(TODAY_KEY, 1);

      await assertFails(
        createWithPointer(db, OWNER_UID, 'bad-goal', {
          ...validExamGoal,
          startDate: tomorrowKey,
          examDate: addDays(tomorrowKey, 1),
        }),
      );
    });

    it('startDate が日本時間の今日でない(遠い未来)と作成できない', async () => {
      const db = testEnv.authenticatedContext(OWNER_UID).firestore();

      await assertFails(
        createWithPointer(db, OWNER_UID, 'bad-goal', {
          ...validExamGoal,
          startDate: FAR_FUTURE_KEY,
          examDate: addDays(FAR_FUTURE_KEY, 1),
        }),
      );
    });

    it('正常(startDate は今日・examDate は明日以降)だと作成できる', async () => {
      const db = testEnv.authenticatedContext(OWNER_UID).firestore();
      const tomorrowKey = addDays(TODAY_KEY, 1);

      await assertSucceeds(
        createWithPointer(db, OWNER_UID, 'ok-goal-tomorrow', {
          ...validExamGoal,
          startDate: TODAY_KEY,
          examDate: tomorrowKey,
        }),
      );
      await assertSucceeds(
        createWithPointer(db, OWNER_UID, 'ok-goal-far', {
          ...validExamGoal,
          startDate: TODAY_KEY,
          examDate: FAR_FUTURE_EXAM_DATE,
        }),
      );
    });

    // gokaku-review 3-5c-1 再レビュー: isCalendarDate(閏年・月末)・isDateKeyShaped(形式)の
    // 境界値を examDate で確認する(startDate は TODAY_KEY のまま固定し、examDate だけを変える)
    it('閏年の2月29日は、4年に1度は作成できるが、100年に1度(西暦400の倍数を除く)は作成できない', async () => {
      const db = testEnv.authenticatedContext(OWNER_UID).firestore();

      // 2028年はうるう年(4で割れて100で割れない) → 実在する日付
      await assertSucceeds(
        createWithPointer(db, OWNER_UID, 'leap-2028', {
          ...validExamGoal,
          examDate: '2028-02-29',
        }),
      );
      // 2027年はうるう年でない → 2月29日は実在しない
      await assertFails(
        createWithPointer(db, OWNER_UID, 'leap-2027', {
          ...validExamGoal,
          examDate: '2027-02-29',
        }),
      );
      // 2100年は100で割れるが400で割れない(西暦の century rule) → うるう年でない
      await assertFails(
        createWithPointer(db, OWNER_UID, 'leap-2100', {
          ...validExamGoal,
          examDate: '2100-02-29',
        }),
      );
    });

    it('月末が30日までの月の31日は作成できないが、31日まである月の31日は作成できる', async () => {
      const db = testEnv.authenticatedContext(OWNER_UID).firestore();

      // 4月は30日まで
      await assertFails(
        createWithPointer(db, OWNER_UID, 'april-31', {
          ...validExamGoal,
          examDate: '2027-04-31',
        }),
      );
      // 6月は30日まで
      await assertFails(
        createWithPointer(db, OWNER_UID, 'june-31', {
          ...validExamGoal,
          examDate: '2027-06-31',
        }),
      );
      // 12月は31日まである
      await assertSucceeds(
        createWithPointer(db, OWNER_UID, 'dec-31', {
          ...validExamGoal,
          examDate: '2027-12-31',
        }),
      );
    });

    it('月が00・13だと作成できない', async () => {
      const db = testEnv.authenticatedContext(OWNER_UID).firestore();

      await assertFails(
        createWithPointer(db, OWNER_UID, 'month-00', {
          ...validExamGoal,
          examDate: '2027-00-15',
        }),
      );
      await assertFails(
        createWithPointer(db, OWNER_UID, 'month-13', {
          ...validExamGoal,
          examDate: '2027-13-15',
        }),
      );
    });

    it('日が00・32だと作成できない', async () => {
      const db = testEnv.authenticatedContext(OWNER_UID).firestore();

      await assertFails(
        createWithPointer(db, OWNER_UID, 'day-00', {
          ...validExamGoal,
          examDate: '2027-05-00',
        }),
      );
      await assertFails(
        createWithPointer(db, OWNER_UID, 'day-32', {
          ...validExamGoal,
          examDate: '2027-05-32',
        }),
      );
    });

    it('形式が異なる文字列("2027-2-1"・"20270201"・"2027-02-01T00:00")だと作成できない', async () => {
      const db = testEnv.authenticatedContext(OWNER_UID).firestore();

      await assertFails(
        createWithPointer(db, OWNER_UID, 'format-short', {
          ...validExamGoal,
          examDate: '2027-2-1',
        }),
      );
      await assertFails(
        createWithPointer(db, OWNER_UID, 'format-nodash', {
          ...validExamGoal,
          examDate: '20270201',
        }),
      );
      await assertFails(
        createWithPointer(db, OWNER_UID, 'format-time', {
          ...validExamGoal,
          examDate: '2027-02-01T00:00',
        }),
      );
    });

    it('文字列でない値(数値・真偽値)だと作成できない', async () => {
      const db = testEnv.authenticatedContext(OWNER_UID).firestore();

      await assertFails(
        createWithPointer(db, OWNER_UID, 'non-string-number', {
          ...validExamGoal,
          examDate: 20_270_201,
        }),
      );
      await assertFails(
        createWithPointer(db, OWNER_UID, 'non-string-bool', {
          ...validExamGoal,
          examDate: true,
        }),
      );
    });
  });

  it('他人は goals を作成できない', async () => {
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();

    await assertFails(createWithPointer(db, OWNER_UID, 'exam-goal', validExamGoal));
  });

  it('未ログインは goals を作成できない', async () => {
    const db = testEnv.unauthenticatedContext().firestore();

    await assertFails(createWithPointer(db, OWNER_UID, 'exam-goal', validExamGoal));
  });
});

// Phase 1-4 技術検証(gokaku-security によるルール検証): デバイストークン(ハッシュ)は
// クライアントから一切読み書きできてはならない(サーバー(Cloud Functions の Admin SDK)だけが読み書きする)
describe('deviceTokens(Phase 1-4 技術検証: ネイティブ同期用デバイストークンのハッシュ)', () => {
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, 'deviceTokens', OWNER_UID), { tokenHash: 'dummy-hash' });
    });
  });

  it('本人でも deviceTokens を読めない', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(getDoc(doc(db, 'deviceTokens', OWNER_UID)));
  });

  it('他人も deviceTokens を読めない', async () => {
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();

    await assertFails(getDoc(doc(db, 'deviceTokens', OWNER_UID)));
  });

  it('本人でも deviceTokens に書き込めない(トークンのハッシュ上書き・なりすましの防止)', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(setDoc(doc(db, 'deviceTokens', OWNER_UID), { tokenHash: 'attacker-hash' }));
  });

  it('他人も deviceTokens に書き込めない', async () => {
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();

    await assertFails(setDoc(doc(db, 'deviceTokens', OWNER_UID), { tokenHash: 'attacker-hash' }));
  });

  it('未ログインは deviceTokens を読めない', async () => {
    const db = testEnv.unauthenticatedContext().firestore();

    await assertFails(getDoc(doc(db, 'deviceTokens', OWNER_UID)));
  });

  it('未ログインは deviceTokens に書き込めない', async () => {
    const db = testEnv.unauthenticatedContext().firestore();

    await assertFails(setDoc(doc(db, 'deviceTokens', OWNER_UID), { tokenHash: 'attacker-hash' }));
  });
});

// 5-3b-2: 呼び出し回数の制限のカウンタ(rateLimits)は、deviceTokens と同じ理由で
// クライアントから一切読み書きできてはならない(サーバー(Cloud Functions の Admin SDK)だけが読み書きする)
describe('rateLimits(5-3b-2: 呼び出し回数の制限のカウンタ)', () => {
  const RATE_LIMIT_DOC_ID = `${OWNER_UID}_study-event_1`;

  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, 'rateLimits', RATE_LIMIT_DOC_ID), { count: 1 });
    });
  });

  it('本人でも rateLimits を読めない', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(getDoc(doc(db, 'rateLimits', RATE_LIMIT_DOC_ID)));
  });

  it('他人も rateLimits を読めない', async () => {
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();

    await assertFails(getDoc(doc(db, 'rateLimits', RATE_LIMIT_DOC_ID)));
  });

  it('本人でも rateLimits に書き込めない(カウンタの改ざん防止)', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(setDoc(doc(db, 'rateLimits', RATE_LIMIT_DOC_ID), { count: 0 }));
  });

  it('他人も rateLimits に書き込めない', async () => {
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();

    await assertFails(setDoc(doc(db, 'rateLimits', RATE_LIMIT_DOC_ID), { count: 0 }));
  });

  it('未ログインは rateLimits を読めない', async () => {
    const db = testEnv.unauthenticatedContext().firestore();

    await assertFails(getDoc(doc(db, 'rateLimits', RATE_LIMIT_DOC_ID)));
  });

  it('未ログインは rateLimits に書き込めない', async () => {
    const db = testEnv.unauthenticatedContext().firestore();

    await assertFails(setDoc(doc(db, 'rateLimits', RATE_LIMIT_DOC_ID), { count: 0 }));
  });
});

// users/{uid}/syncEvents(Phase 1-4 技術検証用のコレクション)は、5-3b-1 で nativeSync が
// recordStudySessionEvent(共通処理)を使うように直したことで書き込まれなくなった。
// クライアントからの読み書きの扱いは、サーバーのみが書き込む他のコレクション(sessions・sessionEvents。
// 下の describe)と同じ明示的な match が無いため、デフォルト拒否(読み取りは
// users/{uid}/{document=**} の共通ルールで本人のみ可)で変わらない。このコレクション専用のテストは削除した

// Phase 4-2a: 購入の持ち主の固定(appleSubscriptions)はサーバー(Admin SDK)だけが読み書きする
// (requirements 5)。クライアントからは一切アクセスできない(明示的な match がないため default deny)
describe('appleSubscriptions/{originalTransactionId}(Phase 4-2a: 購入の持ち主の固定)', () => {
  const ORIGINAL_TRANSACTION_ID = 'otxn-1';

  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'appleSubscriptions', ORIGINAL_TRANSACTION_ID), {
        uid: OWNER_UID,
        productId: 'com.jime0083.gokakuwatch.premium.monthly',
        environment: 'PRODUCTION',
      });
    });
  });

  it('本人(購入の持ち主)でも読めない', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(getDoc(doc(db, 'appleSubscriptions', ORIGINAL_TRANSACTION_ID)));
  });

  it('他人も読めない', async () => {
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();

    await assertFails(getDoc(doc(db, 'appleSubscriptions', ORIGINAL_TRANSACTION_ID)));
  });

  it('未ログインは読めない', async () => {
    const db = testEnv.unauthenticatedContext().firestore();

    await assertFails(getDoc(doc(db, 'appleSubscriptions', ORIGINAL_TRANSACTION_ID)));
  });

  it('本人でも書き込めない(なりすまし・持ち主の書き換え防止)', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(
      setDoc(doc(db, 'appleSubscriptions', 'otxn-forged'), {
        uid: OWNER_UID,
        productId: 'com.jime0083.gokakuwatch.premium.monthly',
        environment: 'PRODUCTION',
      }),
    );
  });

  it('他人も書き込めない(他人の購入の持ち主を自分に書き換える攻撃の防止)', async () => {
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();

    await assertFails(
      setDoc(doc(db, 'appleSubscriptions', ORIGINAL_TRANSACTION_ID), { uid: OTHER_UID }, { merge: true }),
    );
  });
});

// Phase 5-1b-1: users/{uid}/sessions・users/{uid}/sessionEvents はクライアントから一切書き込めない
// (時刻の補正をサーバー(recordStudyEvent Callable)で行うため。requirements 3-2「アプリからの記録の保存」)。
// 読みは本人のみ(既存の users/{uid}/{document=**} の読み取りの扱いに合わせる。明示的な match を
// 追加していないため、書き込みはどの match にも当たらずデフォルト拒否される)
describe('users/{uid}/sessions(Phase 5-1b-1: 計測セッション。サーバー(recordStudyEvent)のみ書き込み可)', () => {
  const SESSION_ID = 'session-1';

  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'users', OWNER_UID, 'sessions', SESSION_ID), {
        goalId: 'goal-1',
        startAt: 1_735_689_600_000,
        stopAt: null,
        source: 'app',
        endReason: 'manual',
      });
    });
  });

  it('本人は自分の sessions を読める', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertSucceeds(getDoc(doc(db, 'users', OWNER_UID, 'sessions', SESSION_ID)));
  });

  it('他人は sessions を読めない', async () => {
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();

    await assertFails(getDoc(doc(db, 'users', OWNER_UID, 'sessions', SESSION_ID)));
  });

  it('未ログインは sessions を読めない', async () => {
    const db = testEnv.unauthenticatedContext().firestore();

    await assertFails(getDoc(doc(db, 'users', OWNER_UID, 'sessions', SESSION_ID)));
  });

  it('本人でも sessions に新規作成できない(時刻の補正をサーバーで行うため。偽セッションの注入防止)', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(
      setDoc(doc(db, 'users', OWNER_UID, 'sessions', 'forged-session'), {
        goalId: 'goal-1',
        startAt: Date.now(),
        stopAt: null,
      }),
    );
  });

  it('本人でも既存の sessions を書き換えられない(勉強時間の改ざん防止)', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(
      setDoc(
        doc(db, 'users', OWNER_UID, 'sessions', SESSION_ID),
        { stopAt: Date.now() },
        { merge: true },
      ),
    );
  });
});

describe('users/{uid}/sessionEvents(Phase 5-1b-1: idempotencyKey の処理済みの印。サーバーのみ書き込み可)', () => {
  const EVENT_ID = 'evt-1';

  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'users', OWNER_UID, 'sessionEvents', EVENT_ID), {
        sessionId: 'session-1',
        action: 'start',
      });
    });
  });

  it('本人は自分の sessionEvents を読める', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertSucceeds(getDoc(doc(db, 'users', OWNER_UID, 'sessionEvents', EVENT_ID)));
  });

  it('他人は sessionEvents を読めない', async () => {
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();

    await assertFails(getDoc(doc(db, 'users', OWNER_UID, 'sessionEvents', EVENT_ID)));
  });

  it('本人でも sessionEvents に書き込めない(同じ idempotencyKey を2回処理させない仕組みの改ざん防止)', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertFails(
      setDoc(doc(db, 'users', OWNER_UID, 'sessionEvents', 'forged-evt'), {
        sessionId: 'session-1',
        action: 'start',
      }),
    );
  });
});

// Phase 3-5a 技術検証: React Native Firebase クライアント SDK から Emulator の Firestore に
// 読み書きできることを確かめる専用コレクション(本番の書き込み許可は 3-5c で追加する)
describe('devProbe/{uid}(Phase 3-5a 技術検証: クライアント SDK からの読み書き確認用)', () => {
  it('本人は自分の devProbe に書き込める', async () => {
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertSucceeds(setDoc(doc(db, 'devProbe', OWNER_UID), { checkedAt: 1 }));
  });

  it('本人は自分の devProbe を読める', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'devProbe', OWNER_UID), { checkedAt: 1 });
    });
    const db = testEnv.authenticatedContext(OWNER_UID).firestore();

    await assertSucceeds(getDoc(doc(db, 'devProbe', OWNER_UID)));
  });

  it('他人は devProbe を読めない', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'devProbe', OWNER_UID), { checkedAt: 1 });
    });
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();

    await assertFails(getDoc(doc(db, 'devProbe', OWNER_UID)));
  });

  it('他人は devProbe に書き込めない', async () => {
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();

    await assertFails(setDoc(doc(db, 'devProbe', OWNER_UID), { checkedAt: 2 }));
  });

  it('未ログインは devProbe に書き込めない', async () => {
    const db = testEnv.unauthenticatedContext().firestore();

    await assertFails(setDoc(doc(db, 'devProbe', OWNER_UID), { checkedAt: 3 }));
  });
});
