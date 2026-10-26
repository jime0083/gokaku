import { randomUUID } from 'node:crypto';

import { deleteApp, initializeApp } from 'firebase-admin/app';
import {
  getFirestore, Timestamp,
  type DocumentReference, type Query, type Transaction,
} from 'firebase-admin/firestore';

import type { JudgementStream } from '../../../../shared/judgementHistory';
import {
  readJudgementHistory, readJudgementStreamPoint,
} from '../../dailyJudgement/historyReader';
import { readPostingConsent } from '../postingConsentReader';

/**
 * 正式7-3b内部「送信前の投稿OFF・再連携検知」のtests-first。
 * このファイルはmainで適用して未実装REDを確認する。ここでは実行していない。
 *
 * 追加exportの契約:
 * readJudgementStreamPoint<S>(tx, userRef, stream, parentRevision,
 *   coverageStart: Timestamp, cutoff: Timestamp)
 *   -> Promise<{ snapshot: JudgementSnapshots[S]; revision: number;
 *                committedAt: Timestamp }>
 * 既存readStreamと同じ2方向bounded queryとselectJudgementHistoryを使う。
 * revision/committedAtは検証済みのcutoff直前beforeDocから取得する。
 * 旧private wrapperとreadJudgementHistoryの戻り値はsnapshotだけのまま。
 * schema/selector/index/既存61件は変更しない。
 *
 * readPostingConsent(tx, userRef, cutoff: Timestamp)の戻り値:
 * { status: 'allowed', linkRevision: number }
 * | { status: 'cancelled', reason: 'posting_disabled' | 'link_changed'
 *     | 'not_authorized_at_cutoff' }
 * | { status: 'beforeCoverage' | 'noAccount' | 'deleting' }
 *
 * settings追加query契約:
 * where('revision', '>', cutoffRevision)
 * .where('revision', '<=', currentCounter).orderBy('revision', 'asc')。
 * 過去全historyを読まず、この範囲の連続性・時刻・終端まで検証する。
 * terminal cancelは履歴から毎回復元する。永続jobの状態遷移は後続単位。
 * goal/subscriptionの適格性は上位jobの確定dailyResultで検証済み。
 * このreaderは全4counterのmetadataを検査するが、その2streamは読まない。
 */
if (
  process.env.GCLOUD_PROJECT !== 'demo-gokaku'
  || !/^(127\.0\.0\.1|localhost):[1-9][0-9]{0,4}$/.test(
    process.env.FIRESTORE_EMULATOR_HOST ?? '',
  )
) {
  throw new Error('postingConsentReader tests require local demo-gokaku Firestore Emulator');
}

const app = initializeApp(
  { projectId: 'demo-gokaku' }, `posting-consent-${randomUUID()}`,
);
const db = getFirestore(app);
const streams: JudgementStream[] = ['goal', 'settings', 'xLink', 'subscription'];
type ConsentStream = 'settings' | 'xLink';
const start = new Timestamp(100, 0);
const cutoff = new Timestamp(200, 500001);
const justBefore = new Timestamp(200, 500000);
const justAfter = new Timestamp(200, 500002);
const later = new Timestamp(201, 0);
const goal = {
  goalId: 'consent-goal', startDate: '2026-10-01', examDate: '2026-12-01',
  minDailyMinutes: 60, goalDailyMinutes: 120,
};
const counters = () => ({ goal: 1, settings: 1, xLink: 1, subscription: 1 });
const root = () => ({
  judgementHistoryStartedAt: start,
  judgementRevisions: counters(),
  activeGoalId: goal.goalId,
  xPostEnabled: true,
  xLinked: true,
  subscription: null,
});
function snapshot(stream: ConsentStream, value: boolean) {
  return stream === 'settings' ? { xPostEnabled: value } : { xLinked: value };
}
function entry(
  revision: number, committedAt: Timestamp, before: unknown, after: unknown,
): Record<string, unknown> {
  return { schemaVersion: 1, revision, committedAt, before, after };
}
function entries(ref: DocumentReference, stream: JudgementStream) {
  return ref.collection('judgementHistory').doc(stream).collection('entries');
}

type Row = {
  id: string;
  ref: DocumentReference;
  value: Record<string, unknown>;
};
function row(
  ref: DocumentReference, stream: ConsentStream, revision: number,
  at = start, before = true, after = true,
): Row {
  return {
    id: String(revision),
    ref: entries(ref, stream).doc(String(revision)),
    value: entry(revision, at, snapshot(stream, before), snapshot(stream, after)),
  };
}

/** SDK Query.isEqualでqueryを検査し、直接get/別tx/全履歴queryを許可しない。 */
function harness(
  ref: DocumentReference,
  metadata: Record<string, unknown> = root(),
  points: Partial<Record<ConsentStream, { before: Row[]; after: Row[] }>> = {},
  suffix: Row[] = [],
) {
  const expected = (['settings', 'xLink'] as const).flatMap((stream) => {
    const collection = entries(ref, stream);
    return [
      {
        name: `${stream}:before`,
        query: collection.where('committedAt', '<', cutoff)
          .orderBy('committedAt', 'desc').orderBy('revision', 'desc').limit(1),
        rows: points[stream]?.before ?? [row(ref, stream, 1)],
      },
      {
        name: `${stream}:after`,
        query: collection.where('committedAt', '>=', cutoff)
          .orderBy('committedAt', 'asc').orderBy('revision', 'asc').limit(1),
        rows: points[stream]?.after ?? [],
      },
    ];
  });
  const revisions = metadata.judgementRevisions as ReturnType<typeof counters>;
  expected.push({
    name: 'settings:suffix',
    query: entries(ref, 'settings').where('revision', '>', 1)
      .where('revision', '<=', revisions.settings).orderBy('revision', 'asc'),
    rows: suffix,
  });
  const seen: string[] = [];
  const get = jest.fn(async (target: DocumentReference | Query) => {
    if (target === ref) {
      seen.push('root');
      return { exists: true, data: () => metadata };
    }
    const match = expected.find(({ query }) => query.isEqual(target as Query));
    if (!match) throw new Error('Unexpected read outside supplied consent transaction');
    seen.push(match.name);
    const docs = match.rows.map((item) => ({
      id: item.id, ref: item.ref, data: () => item.value,
    }));
    return { docs, empty: docs.length === 0, size: docs.length };
  });
  const writes = {
    create: jest.fn(), set: jest.fn(), update: jest.fn(), delete: jest.fn(),
  };
  return { tx: { get, ...writes } as unknown as Transaction, get, writes, seen };
}

async function expectInvalid(operation: () => Promise<unknown>, raw?: string) {
  const failure: unknown = await operation().then(
    () => undefined, (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  if (raw !== undefined) {
    expect(String(failure)).not.toContain(raw);
    expect(JSON.stringify(failure)).not.toContain(raw);
  }
}

afterAll(async () => {
  try {
    await db.terminate();
  } finally {
    await deleteApp(app);
  }
});

describe('postingConsentReader transaction and SDK boundary', () => {
  test('同じtxだけでroot/2stream bounded query/必要なsettings suffixを読む', async () => {
    const ref = db.doc(`users/consent-unit-${randomUUID()}`);
    const second = row(ref, 'settings', 2, cutoff);
    const third = row(ref, 'settings', 3, justAfter);
    const h = harness(ref, {
      ...root(), judgementRevisions: { ...counters(), settings: 3 },
    }, { settings: { before: [row(ref, 'settings', 1)], after: [second] } },
    [second, third]);
    const millis = jest.spyOn(Timestamp.prototype, 'toMillis')
      .mockImplementation(() => { throw new Error('Timestamp precision loss'); });
    const date = jest.spyOn(Timestamp.prototype, 'toDate')
      .mockImplementation(() => { throw new Error('Timestamp precision loss'); });
    const now = jest.spyOn(Date, 'now')
      .mockImplementation(() => { throw new Error('Unexpected wall clock'); });
    try {
      expect(await readPostingConsent(h.tx, ref, cutoff)).toEqual({
        status: 'allowed', linkRevision: 1,
      });
      expect([...h.seen].sort()).toEqual([
        'root', 'settings:after', 'settings:before', 'settings:suffix',
        'xLink:after', 'xLink:before',
      ].sort());
      for (const write of Object.values(h.writes)) expect(write).not.toHaveBeenCalled();
      expect(millis).not.toHaveBeenCalled();
      expect(date).not.toHaveBeenCalled();
      expect(now).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
      date.mockRestore();
      millis.mockRestore();
    }
  });

  test('新point exportはstrict <の検証済beforeDocのsnapshot/revision/SDK時刻を返す', async () => {
    const ref = db.doc(`users/consent-point-${randomUUID()}`);
    const h = harness(ref, root(), {
      settings: {
        before: [row(ref, 'settings', 2, justBefore)],
        after: [row(ref, 'settings', 3, cutoff, true, false)],
      },
    });
    const point = await readJudgementStreamPoint(
      h.tx, ref, 'settings', 3, start, cutoff,
    );
    expect(point).toEqual({
      snapshot: { xPostEnabled: true }, revision: 2, committedAt: justBefore,
    });
    expect(point.committedAt).toBeInstanceOf(Timestamp);
    expect(point.committedAt.seconds).toBe(200);
    expect(point.committedAt.nanoseconds).toBe(500000);
    expect(h.seen.sort()).toEqual(['settings:after', 'settings:before']);
  });

  test('不正user参照/UIDとSDK以外のcutoffをI/O前に拒否する', async () => {
    const refs = [
      { path: 'users/forged' } as DocumentReference,
      db.doc('goals/other'), db.doc('users/owner/goals/child'),
      db.doc('users/__reserved__'), db.doc(`users/${'u'.repeat(129)}`),
      db.doc('users/ '),
      { path: 'users/\ud800' } as DocumentReference,
      { path: 'users/../other' } as DocumentReference,
    ];
    for (const ref of refs) {
      const get = jest.fn();
      await expectInvalid(() => readPostingConsent(
        { get } as unknown as Transaction, ref, cutoff,
      ));
      expect(get).not.toHaveBeenCalled();
    }
    const ref = db.doc(`users/consent-invalid-${randomUUID()}`);
    for (const at of [null, undefined, 200000, new Date(200000), {
      seconds: cutoff.seconds, nanoseconds: cutoff.nanoseconds,
    }]) {
      const get = jest.fn();
      await expectInvalid(() => readPostingConsent(
        { get } as unknown as Transaction, ref, at as Timestamp,
      ));
      expect(get).not.toHaveBeenCalled();
    }
  });

  test('bounded/suffixの他UID文書・ID不一致・偽SDK Timestampを拒否する', async () => {
    const ref = db.doc(`users/consent-boundary-${randomUUID()}`);
    const other = db.doc(`users/consent-other-${randomUUID()}`);
    const changes: ((value: Row) => Row)[] = [
      (value) => ({ ...value, ref: entries(other, 'settings').doc(value.id) }),
      (value) => ({ ...value, id: 'wrong-id' }),
      (value) => ({ ...value, value: {
        ...value.value,
        committedAt: { seconds: 200, nanoseconds: 500001 },
      } }),
    ];
    for (const change of changes) {
      const badBefore = change(row(ref, 'settings', 1));
      const beforeHarness = harness(ref, root(), {
        settings: { before: [badBefore], after: [] },
      });
      await expectInvalid(() => readPostingConsent(beforeHarness.tx, ref, cutoff));
      const second = row(ref, 'settings', 2, cutoff);
      const third = change(row(ref, 'settings', 3, justAfter));
      const suffixHarness = harness(ref, {
        ...root(), judgementRevisions: { ...counters(), settings: 3 },
      }, { settings: { before: [row(ref, 'settings', 1)], after: [second] } },
      [second, third]);
      await expectInvalid(() => readPostingConsent(suffixHarness.tx, ref, cutoff));
    }
  });

  test('root/queryのSDK例外を同じインスタンスで伝播しtx retry判定を維持する', async () => {
    const ref = db.doc(`users/consent-sdk-${randomUUID()}`);
    const failure = Object.assign(new Error('synthetic transaction conflict'), { code: 10 });
    for (const failRoot of [true, false]) {
      const get = jest.fn(async (target: DocumentReference | Query) => {
        if (!failRoot && target === ref) return { exists: true, data: root };
        throw failure;
      });
      await expect(readPostingConsent(
        { get } as unknown as Transaction, ref, cutoff,
      )).rejects.toBe(failure);
    }
  });
});

describe('postingConsentReader real local Firestore', () => {
  // P-142: 実Firestoreへ保存できるマイクロ秒境界。外側のmockは1ns差を維持する。
  const cutoff = new Timestamp(200, 501000);
  const justBefore = new Timestamp(200, 500000);
  const justAfter = new Timestamp(200, 502000);
  let ref: DocumentReference;

  async function seed() {
    // このtestが所有するUID以外は削除しない。繰返しmatrixも独立した正常fixtureへ戻す。
    await db.recursiveDelete(ref);
    const batch = db.batch();
    batch.set(ref, root());
    const values = {
      goal, settings: { xPostEnabled: true }, xLink: { xLinked: true },
      subscription: null,
    };
    for (const stream of streams) {
      batch.set(entries(ref, stream).doc('1'), entry(1, start, values[stream], values[stream]));
    }
    // N/Mの入力となる確定結果。readerは学習数値もpendingも変更しない。
    for (const day of ['2026-10-24', '2026-10-25']) {
      batch.set(ref.collection('dailyResults').doc(day), {
        goalId: goal.goalId, studiedMinutes: 12, metMin: false, metGoal: false,
        postStatus: 'pending', postSkipReasons: [],
      });
    }
    await batch.commit();
  }

  beforeEach(async () => {
    ref = db.doc(`users/posting-consent-${randomUUID()}`);
    await seed();
  });
  afterEach(async () => {
    if (ref) await db.recursiveDelete(ref);
  });
  function read(at = cutoff) {
    return db.runTransaction((tx) => readPostingConsent(tx, ref, at));
  }
  async function history(
    stream: ConsentStream,
    steps: { at: Timestamp; before: boolean; after: boolean }[],
  ) {
    const batch = db.batch();
    steps.forEach((step, index) => {
      batch.set(entries(ref, stream).doc(String(index + 2)), entry(
        index + 2, step.at, snapshot(stream, step.before), snapshot(stream, step.after),
      ));
    });
    const last = steps[steps.length - 1];
    batch.update(ref, {
      [`judgementRevisions.${stream}`]: steps.length + 1,
      ...(last === undefined ? {} : snapshot(stream, last.after)),
    });
    await batch.commit();
  }
  async function storedState() {
    const parent = await ref.get();
    const groups = await Promise.all([
      ref.collection('dailyResults').orderBy('__name__').get(),
      ...streams.map((stream) => entries(ref, stream).orderBy('revision').get()),
    ]);
    return [parent, ...groups.flatMap((group) => group.docs)].map((doc) => ({
      path: doc.ref.path, data: doc.data(), updateTime: doc.updateTime,
    }));
  }

  test('実Firestoreへの保存後もcutoff前/同時/後の境界が一致する', async () => {
    const boundaries = [justBefore, cutoff, justAfter];
    await history('settings', boundaries.map((at) => ({
      at, before: true, after: true,
    })));
    const docs = await db.getAll(
      ...boundaries.map((_, index) => entries(ref, 'settings').doc(String(index + 2))),
    );
    docs.forEach((doc, index) => {
      const actual: unknown = doc.data()?.committedAt;
      expect(actual).toBeInstanceOf(Timestamp);
      if (!(actual instanceof Timestamp)) throw new Error('Expected SDK Timestamp');
      expect(actual.seconds).toBe(boundaries[index].seconds);
      expect(actual.nanoseconds).toBe(boundaries[index].nanoseconds);
      expect(actual.isEqual(boundaries[index])).toBe(true);
    });
  });

  test('正常baselineはallowed、旧readerの公開戻り値と保存済み全データを保持する', async () => {
    const before = await storedState();
    expect(await read()).toEqual({ status: 'allowed', linkRevision: 1 });
    const old = await db.runTransaction((tx) => readJudgementHistory(tx, ref, cutoff));
    const { goalId, ...historicalGoal } = goal;
    expect(old).toEqual({
      status: 'available', goalId, goal: historicalGoal,
      user: { subscription: null, xPostEnabled: true, xLinked: true },
    });
    expect(await storedState()).toEqual(before);
  });

  test('cutoffちょうど/1μs後のOFFを送信前中止とし確定結果を保持する', async () => {
    for (const at of [cutoff, justAfter]) {
      await seed();
      await history('settings', [{ at, before: true, after: false }]);
      const before = await storedState();
      expect(await read()).toEqual({ status: 'cancelled', reason: 'posting_disabled' });
      expect(await storedState()).toEqual(before);
    }
  });

  test('OFF→ONの旧待機は再読取/さらにONを保存しても復活しない', async () => {
    const off = { at: cutoff, before: true, after: false };
    const on = { at: justAfter, before: false, after: true };
    await history('settings', [off, on]);
    const before = await storedState();
    expect(await read()).toEqual({ status: 'cancelled', reason: 'posting_disabled' });
    expect(await read()).toEqual({ status: 'cancelled', reason: 'posting_disabled' });
    expect(await storedState()).toEqual(before);
    await history('settings', [off, on, { at: later, before: true, after: true }]);
    expect(await read()).toEqual({ status: 'cancelled', reason: 'posting_disabled' });
  });

  test('cutoff以降のtrue→true再連携も連携世代の変更として中止する', async () => {
    for (const at of [cutoff, justAfter]) {
      await seed();
      await history('xLink', [{ at, before: true, after: true }]);
      const before = await storedState();
      expect(await read()).toEqual({ status: 'cancelled', reason: 'link_changed' });
      expect(await storedState()).toEqual(before);
    }
  });

  test('同一receipt再送で履歴/counterが増えない入力は同じ世代のまま許可する', async () => {
    // receipt再送自体は既存writerの結合testで検証済み。ここではその読取契約を検証。
    const before = await storedState();
    expect(await read()).toEqual({ status: 'allowed', linkRevision: 1 });
    expect(await read()).toEqual({ status: 'allowed', linkRevision: 1 });
    expect(await storedState()).toEqual(before);
  });

  test('cutoff時点でsettings/xLinkがfalseなら後からtrueでも当初未許可', async () => {
    for (const stream of ['settings', 'xLink'] as const) {
      await seed();
      await entries(ref, stream).doc('1').set(entry(
        1, start, snapshot(stream, false), snapshot(stream, false),
      ));
      await history(stream, [{ at: cutoff, before: false, after: true }]);
      expect(await read()).toEqual({
        status: 'cancelled', reason: 'not_authorized_at_cutoff',
      });
    }
  });

  test('cutoff前のOFF→ON/再連携は最新世代を使い同時刻revision最大を選ぶ', async () => {
    await history('settings', [
      { at: justBefore, before: true, after: false },
      { at: justBefore, before: false, after: true },
      { at: cutoff, before: true, after: true },
    ]);
    await history('xLink', [
      { at: justBefore, before: true, after: true },
      { at: justBefore, before: true, after: true },
    ]);
    expect(await read()).toEqual({ status: 'allowed', linkRevision: 3 });
  });

  test('rootmissing/削除中は安全skipし親を作成しない', async () => {
    await ref.delete();
    expect(await read()).toEqual({ status: 'noAccount' });
    expect((await ref.get()).exists).toBe(false);
    await ref.set({ deletionInProgress: true, judgementRevisions: null });
    expect(await read()).toEqual({ status: 'deleting' });
    expect((await ref.get()).data()).toEqual({
      deletionInProgress: true, judgementRevisions: null,
    });
  });

  test('両metadata absentまたは有効start>=cutoffだけbeforeCoverage', async () => {
    await ref.set({ xPostEnabled: true, xLinked: true, subscription: null });
    expect(await read()).toEqual({ status: 'beforeCoverage' });
    for (const at of [cutoff, justAfter]) {
      await ref.set({ ...root(), judgementHistoryStartedAt: at });
      expect(await read()).toEqual({ status: 'beforeCoverage' });
    }
  });

  test('partial/null/偽Timestamp metadataを導入前やfalseへ補完しない', async () => {
    const malformed = [
      { judgementHistoryStartedAt: start },
      { judgementRevisions: counters() },
      { judgementHistoryStartedAt: null, judgementRevisions: counters() },
      { judgementHistoryStartedAt: { seconds: 100, nanoseconds: 0 }, judgementRevisions: counters() },
      { judgementHistoryStartedAt: start, judgementRevisions: null },
    ];
    for (const metadata of malformed) {
      await ref.set({ xPostEnabled: true, xLinked: true, subscription: null, ...metadata });
      await expectInvalid(() => read());
    }
  });

  test('rootは未読のgoal/subscriptionも含むexact4positive safe counterを要求する', async () => {
    const invalid: Record<string, unknown>[] = [];
    for (const stream of streams) {
      const missing: Record<string, unknown> = counters();
      delete missing[stream];
      invalid.push(missing);
      for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
        invalid.push({ ...counters(), [stream]: value });
      }
    }
    invalid.push({ ...counters(), extra: 1 });
    for (const revisions of invalid) {
      await ref.set({ ...root(), judgementRevisions: revisions });
      await expectInvalid(() => read());
    }
    // start>=cutoffでも壊れたmetadataを正常な導入前へ置き換えない。
    await ref.set({ ...root(), judgementHistoryStartedAt: cutoff, judgementRevisions: {} });
    await expectInvalid(() => read());
  });

  test('現在rootのbool欠落/型不正/最新snapshot不一致は拒否する', async () => {
    for (const field of ['xPostEnabled', 'xLinked'] as const) {
      for (const value of [undefined, null, 'true', 1, false]) {
        const data: Record<string, unknown> = root();
        if (value === undefined) delete data[field];
        else data[field] = value;
        await ref.set(data);
        await expectInvalid(() => read());
      }
    }
    await seed();
    await history('xLink', [{ at: cutoff, before: true, after: true }]);
    await ref.update({ xLinked: false });
    await expectInvalid(() => read());
  });

  test('settings/xLinkの欠損・隣接gap・before不一致を正常中止へ変換しない', async () => {
    for (const stream of ['settings', 'xLink'] as const) {
      await seed();
      await entries(ref, stream).doc('1').delete();
      await expectInvalid(() => read());
      await seed();
      await ref.update({ [`judgementRevisions.${stream}`]: 3 });
      await entries(ref, stream).doc('3').set(entry(
        3, cutoff, snapshot(stream, true), snapshot(stream, true),
      ));
      await expectInvalid(() => read());
      await seed();
      await history(stream, [{ at: cutoff, before: false, after: true }]);
      await expectInvalid(() => read());
    }
  });

  test('settings suffixの途中gap/終端欠損/counter超過を拒否する', async () => {
    for (const mode of ['gap', 'missing-tail', 'counter-overflow']) {
      await seed();
      await history('settings', [
        { at: cutoff, before: true, after: true },
        { at: justAfter, before: true, after: true },
        { at: later, before: true, after: true },
      ]);
      if (mode === 'gap') await entries(ref, 'settings').doc('3').delete();
      if (mode === 'missing-tail') await entries(ref, 'settings').doc('4').delete();
      if (mode === 'counter-overflow') {
        await ref.update({ 'judgementRevisions.settings': 5 });
      }
      await expectInvalid(() => read());
    }
  });

  test('隣接より先のsuffixもschema/型/ID/連続値/時刻を検証する', async () => {
    const changes: Record<string, unknown>[] = [
      { schemaVersion: 2 },
      { revision: 2 },
      { revision: '3' },
      { before: { xPostEnabled: false } },
      { after: { xPostEnabled: 'false' } },
      { after: {} },
      { after: { xPostEnabled: true, extra: true } },
      { committedAt: { seconds: 200, nanoseconds: 500002 } },
      { committedAt: justBefore },
      { extra: 'invalid-entry-field' },
    ];
    for (const patch of changes) {
      await seed();
      await history('settings', [
        { at: cutoff, before: true, after: true },
        { at: justAfter, before: true, after: true },
      ]);
      await entries(ref, 'settings').doc('3').set({
        ...entry(3, justAfter, snapshot('settings', true), snapshot('settings', true)),
        ...patch,
      });
      await expectInvalid(() => read());
    }
  });

  test('suffix committedAtは非減少を要求し同時刻revision順のOFF→ONも中止する', async () => {
    await history('settings', [
      { at: justAfter, before: true, after: true },
      { at: cutoff, before: true, after: true },
    ]);
    await expectInvalid(() => read());
    await seed();
    await history('settings', [
      { at: cutoff, before: true, after: false },
      { at: cutoff, before: false, after: true },
    ]);
    expect(await read()).toEqual({ status: 'cancelled', reason: 'posting_disabled' });
  });

  test('OFFを発見してもsuffix終端の不正を隠さずgeneric errorにする', async () => {
    await history('settings', [
      { at: cutoff, before: true, after: false },
      { at: justAfter, before: false, after: true },
      { at: later, before: true, after: true },
    ]);
    const raw = `invalid-value-${randomUUID()}`;
    await entries(ref, 'settings').doc('4').update({ after: { xPostEnabled: raw } });
    const before = await storedState();
    await expectInvalid(() => read(), raw);
    await expectInvalid(() => read(), ref.id);
    expect(await storedState()).toEqual(before);
  });

  test('goal/subscription履歴は上位の確定判定に委ね2streamだけで送信同意を読む', async () => {
    // rootの4counter契約は維持する。既存readJudgementHistoryの欠損拒否は変更しない。
    await entries(ref, 'goal').doc('1').delete();
    await entries(ref, 'subscription').doc('1').delete();
    expect(await read()).toEqual({ status: 'allowed', linkRevision: 1 });
    await expectInvalid(() => db.runTransaction((tx) => readJudgementHistory(tx, ref, cutoff)));
  });
});
