import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { deleteApp, initializeApp } from 'firebase-admin/app';
import {
  FieldPath, getFirestore, Query,
  type DocumentReference, type Firestore,
} from 'firebase-admin/firestore';

import {
  PendingPostingsError, runPendingPostings, type PendingPostingsSummary,
} from '../runPendingPostings';

// default DBや本番には接続しない。このmoduleだけが使うnamed DBでCGを隔離する。
if (
  process.env.GCLOUD_PROJECT !== 'demo-gokaku'
  || !/^(127\.0\.0\.1|localhost):[0-9]+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')
) {
  throw new Error('Pending posting tests require local demo-gokaku Firestore Emulator');
}
const databaseId = `posting-batch-${randomUUID()}`;
const app = initializeApp({ projectId: 'demo-gokaku' }, databaseId);
const db = getFirestore(app, databaseId);
const date = '2026-10-25';
const statuses = [
  'posted', 'retry_wait', 'failed', 'unknown',
  'cancelled', 'waiting', 'skipped', 'unavailable',
] as const;
type Status = typeof statuses[number];
type Deps = Parameters<typeof runPendingPostings>[0];
type Worker = Deps['processPostingDate'];

function summary(processed = 0, errors = 0, counts: Partial<Record<Status, number>> = {}): PendingPostingsSummary {
  return {
    processed, errors,
    outcomes: {
      posted: 0, retry_wait: 0, failed: 0, unknown: 0,
      cancelled: 0, waiting: 0, skipped: 0, unavailable: 0,
      ...counts,
    },
  };
}
function worker() {
  return jest.fn<ReturnType<Worker>, Parameters<Worker>>()
    .mockResolvedValue({ status: 'posted' });
}
function pending() {
  return db.collectionGroup('dailyResults')
    .where('postStatus', '==', 'pending')
    .orderBy(FieldPath.documentId(), 'asc');
}
function observeQueries() {
  const queries: Query[] = [];
  const original = Query.prototype.get;
  jest.spyOn(Query.prototype, 'get').mockImplementation(function (this: Query) {
    queries.push(this);
    return original.call(this);
  });
  return queries;
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  return { promise, release };
}
async function failure(deps: Deps): Promise<PendingPostingsError> {
  const error: unknown = await runPendingPostings(deps).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(PendingPostingsError);
  if (!(error instanceof PendingPostingsError)) throw new Error('Expected pending posting failure');
  return error;
}
function expectSanitized(error: PendingPostingsError, forbidden: string[]) {
  expect(error).not.toHaveProperty('cause');
  const exposed = JSON.stringify(Object.getOwnPropertyNames(error)
    .map((key) => [key, Reflect.get(error, key)]));
  for (const value of forbidden) expect(exposed).not.toContain(value);
  expect(Object.keys(error.summary).sort()).toEqual(['errors', 'outcomes', 'processed']);
  expect(Object.keys(error.summary.outcomes).sort()).toEqual([...statuses].sort());
}

type Fixtures = {
  prefix: string;
  put: (path: string, data?: Record<string, unknown>) => Promise<DocumentReference>;
  row: (label: string, key?: string, postStatus?: string) => Promise<DocumentReference>;
};
async function fixtures(body: (f: Fixtures) => Promise<void>): Promise<void> {
  const prefix = `batch-${randomUUID()}`;
  const roots = new Map<string, DocumentReference>();
  async function put(path: string, data: Record<string, unknown> = {}) {
    const ref = db.doc(path);
    const rootPath = path.split('/').slice(0, 2).join('/');
    // 必ず書込み前に登録する。親文書がなくてもこのrootの子だけを清掃する。
    roots.set(rootPath, db.doc(rootPath));
    await ref.set({ postStatus: 'pending', ...data });
    return ref;
  }
  try {
    await body({
      prefix, put,
      row: (label, key = date, postStatus = 'pending') =>
        put(`users/${prefix}-${label}/dailyResults/${key}`, { postStatus }),
    });
  } finally {
    // Query.getの故障注入を清掃へ持ち込まない。全DB削除は禁止。
    jest.restoreAllMocks();
    const results = await Promise.allSettled([...roots.values()]
      .map((root) => db.recursiveDelete(root)));
    if (results.some((result) => result.status === 'rejected')) {
      throw new Error('Owned pending posting fixtures could not be cleaned');
    }
  }
}

afterEach(() => { jest.restoreAllMocks(); });
afterAll(async () => {
  try { await db.terminate(); } finally { await deleteApp(app); }
});

test('隔離named DBが空なら固定のゼロ集計だけを返す', async () => {
  const processPostingDate = worker();
  expect(await runPendingPostings({ db, processPostingDate })).toEqual(summary());
  expect(processPostingDate).not.toHaveBeenCalled();
});

test('pendingだけを完全な文書パス順にsnapshot cursorでページ取得する', async () => {
  await fixtures(async (f) => {
    const refs = await Promise.all([
      f.row('b', date), f.row('a', '2026-10-24'), f.row('a', date),
    ]);
    refs.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const cursor = await refs[1].get();
    const queries = observeQueries();
    const processPostingDate = worker();
    expect(await runPendingPostings({ db, processPostingDate, pageSize: 2, concurrency: 1 }))
      .toEqual(summary(3, 0, { posted: 3 }));
    expect(processPostingDate.mock.calls).toEqual(refs.map((ref) => [ref.parent.parent!.id, ref.id]));
    expect(queries).toHaveLength(2);
    expect(queries[0].isEqual(pending().limit(2))).toBe(true);
    expect(queries[1].isEqual(pending().startAfter(cursor).limit(2))).toBe(true);
  });
});

test('none/posted/failed/skipped/欠損を除外し、保存値のUID/dateを使わず書き換えない', async () => {
  await fixtures(async (f) => {
    const ref = await f.put(`users/${f.prefix}-valid/dailyResults/${date}`, {
      uid: 'payload-other-user', date: '1999-01-01', studiedMinutes: 42,
    });
    const excluded = await Promise.all(['none', 'posted', 'failed', 'skipped']
      .map((status) => f.row(status, date, status)));
    excluded.push(await f.put(`users/${f.prefix}-missing/dailyResults/${date}`, { postStatus: null }));
    const absent = await f.row('absent');
    await absent.set({ studiedMinutes: 12 });
    excluded.push(absent);
    const all = [ref, ...excluded];
    const before = await Promise.all(all.map((item) => item.get()));
    const processPostingDate = worker();
    expect(await runPendingPostings({ db, processPostingDate })).toEqual(summary(1, 0, { posted: 1 }));
    expect(processPostingDate.mock.calls).toEqual([[ref.parent.parent!.id, date]]);
    const after = await Promise.all(all.map((item) => item.get()));
    for (let index = 0; index < all.length; index += 1) {
      expect(after[index].data()).toEqual(before[index].data());
      expect(after[index].updateTime!.isEqual(before[index].updateTime!)).toBe(true);
    }
  });
});

test('workerがpendingを解消しても削除済み対象のsnapshot cursorから全件を一度ずつ処理する', async () => {
  await fixtures(async (f) => {
    const refs = await Promise.all(['01', '02', '03', '04', '05'].map((label) => f.row(label)));
    const processPostingDate = worker().mockImplementation(async (uid, key) => {
      await db.doc(`users/${uid}/dailyResults/${key}`).update({ postStatus: 'posted' });
      return { status: 'posted' };
    });
    expect(await runPendingPostings({ db, processPostingDate, pageSize: 2, concurrency: 2 }))
      .toEqual(summary(5, 0, { posted: 5 }));
    expect(processPostingDate.mock.calls.map(([uid, key]) => `users/${uid}/dailyResults/${key}`).sort())
      .toEqual(refs.map((ref) => ref.path).sort());
    for (const ref of refs) expect((await ref.get()).get('postStatus')).toBe('posted');
  });
});

test.each([
  { concurrency: undefined, pageSize: undefined, expectedPeak: 10, expectedLimit: 100 },
  { concurrency: 2, pageSize: 5, expectedPeak: 2, expectedLimit: 5 },
])('既定/指定の並列上限を守る: %p', async (config) => {
  await fixtures(async (f) => {
    await Promise.all(Array.from({ length: 12 }, (_, index) => f.row(String(index).padStart(2, '0'))));
    let active = 0;
    let peak = 0;
    const queries = observeQueries();
    const processPostingDate = worker().mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      try { await new Promise<void>((done) => setImmediate(done)); }
      finally { active -= 1; }
      return { status: 'posted' };
    });
    expect(await runPendingPostings({
      db, processPostingDate, pageSize: config.pageSize, concurrency: config.concurrency,
    })).toEqual(summary(12, 0, { posted: 12 }));
    expect(processPostingDate).toHaveBeenCalledTimes(12);
    expect(peak).toBe(config.expectedPeak);
    expect(active).toBe(0);
    expect(queries[0].isEqual(pending().limit(config.expectedLimit))).toBe(true);
  });
});

test('ページ内の失敗と未完了workerをすべて待ってから次ページへ進む', async () => {
  await fixtures(async (f) => {
    const refs = await Promise.all(['01', '02', '03'].map((label) => f.row(label)));
    const entered = deferred();
    const gate = deferred();
    const queries = observeQueries();
    let finished = false;
    const processPostingDate = worker().mockImplementation(async (uid) => {
      if (uid === refs[0].parent.parent!.id) throw new Error('synthetic-row-failure');
      if (uid === refs[1].parent.parent!.id) {
        entered.release();
        await gate.promise;
        finished = true;
      }
      if (uid === refs[2].parent.parent!.id) expect(finished).toBe(true);
      return { status: 'posted' };
    });
    // 開始直後から拒否を処理し、テスト中も未awaitの拒否を残さない。
    const running = runPendingPostings({ db, processPostingDate, pageSize: 2, concurrency: 2 })
      .catch((error: unknown) => error);
    let result: unknown;
    try {
      await entered.promise;
      expect(queries).toHaveLength(1);
      expect(processPostingDate).toHaveBeenCalledTimes(2);
    } finally {
      gate.release();
      result = await running;
    }
    expect(result).toBeInstanceOf(PendingPostingsError);
    expect((result as PendingPostingsError).summary).toEqual(summary(3, 1, { posted: 2 }));
    expect(queries).toHaveLength(2);
    expect(finished).toBe(true);
    expect(processPostingDate).toHaveBeenCalledTimes(3);
  });
});

test('最後の短いページでも全workerの完了前に成功を返さない', async () => {
  await fixtures(async (f) => {
    await f.row('only');
    const entered = deferred();
    const gate = deferred();
    let settled = false;
    const processPostingDate = worker().mockImplementation(async () => {
      entered.release();
      await gate.promise;
      return { status: 'posted' };
    });
    const running = runPendingPostings({ db, processPostingDate, pageSize: 2 })
      .then((value) => { settled = true; return value; }, (error: unknown) => {
        settled = true;
        return error;
      });
    let result: unknown;
    try {
      await entered.promise;
      expect(settled).toBe(false);
    } finally {
      gate.release();
      result = await running;
    }
    expect(result).toEqual(summary(1, 0, { posted: 1 }));
  });
});

test('実CGの別root/深い階層/不正UID/非実在日付を拒否して正常行は継続する', async () => {
  await fixtures(async (f) => {
    const good = await f.row('good');
    const badPaths = [
      `teams/${f.prefix}/dailyResults/${date}`,
      `users/${f.prefix}-nested/extra/child/dailyResults/${date}`,
      `dailyResults/${f.prefix}-root`,
      `users/${f.prefix}-${'u'.repeat(129)}/dailyResults/${date}`,
      `users/   /dailyResults/${date}`,
      `users/${f.prefix}-bad-date/dailyResults/2026-02-29`,
      `users/${f.prefix}-short-date/dailyResults/2026-1-01`,
      `users/${f.prefix}-newline/dailyResults/${date}\n`,
    ];
    await Promise.all(badPaths.map((path) => f.put(path)));
    const processPostingDate = worker();
    const error = await failure({ db, processPostingDate, pageSize: 2, concurrency: 2 });
    expect(error.summary).toEqual(summary(9, 8, { posted: 1 }));
    expect(processPostingDate.mock.calls).toEqual([[good.parent.parent!.id, date]]);
    expectSanitized(error, [f.prefix, ...badPaths, '2026-02-29']);
  });
});

test('128文字UIDとUnicode UID・実在する閏日はそのまま一度だけ委譲する', async () => {
  await fixtures(async (f) => {
    const uid = `${f.prefix}${'x'.repeat(128 - f.prefix.length)}`;
    await f.put(`users/${uid}/dailyResults/2024-02-29`);
    const unicode = `${f.prefix}-利用者`;
    await f.put(`users/${unicode}/dailyResults/${date}`);
    const processPostingDate = worker();
    expect(await runPendingPostings({ db, processPostingDate, concurrency: 1 }))
      .toEqual(summary(2, 0, { posted: 2 }));
    expect(processPostingDate).toHaveBeenCalledWith(uid, '2024-02-29');
    expect(processPostingDate).toHaveBeenCalledWith(unicode, date);
    expect(processPostingDate).toHaveBeenCalledTimes(2);
  });
});

test.each(['pageSize', 'concurrency'] as const)('不正%sはquery前に拒否する', async (key) => {
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, '2', true]) {
    const io = jest.fn(() => { throw new Error('Unexpected database access'); });
    const database = new Proxy({} as Firestore, { get: io });
    const processPostingDate = worker();
    await expect(runPendingPostings({ db: database, processPostingDate, [key]: value } as Deps))
      .rejects.toBeInstanceOf(Error);
    expect(io).not.toHaveBeenCalled();
    expect(processPostingDate).not.toHaveBeenCalled();
  }
});

test('関数でない必須workerはquery前に拒否する', async () => {
  for (const value of [undefined, null, {}, 'worker', 1]) {
    const io = jest.fn(() => { throw new Error('Unexpected database access'); });
    const database = new Proxy({} as Firestore, { get: io });
    await expect(runPendingPostings({ db: database, processPostingDate: value } as unknown as Deps))
      .rejects.toBeInstanceOf(Error);
    expect(io).not.toHaveBeenCalled();
  }
});

test('個別の同期throw/非同期reject後も全ページを完走し例外とログを秘匿する', async () => {
  await fixtures(async (f) => {
    const refs = await Promise.all(['01', '02', '03', '04'].map((label) => f.row(label)));
    const raw = `synthetic-private-${f.prefix}`;
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const)
      .map((method) => jest.spyOn(console, method).mockImplementation(() => {}));
    const processPostingDate = worker().mockImplementation((uid) => {
      if (uid === refs[0].parent.parent!.id) throw Object.assign(new Error(raw), { token: raw });
      if (uid === refs[1].parent.parent!.id) return Promise.reject({ credential: raw });
      return Promise.resolve({ status: 'posted' });
    });
    const error = await failure({ db, processPostingDate, pageSize: 2, concurrency: 2 });
    expect(error.summary).toEqual(summary(4, 2, { posted: 2 }));
    expect(processPostingDate).toHaveBeenCalledTimes(4);
    expectSanitized(error, [raw, f.prefix, ...refs.map((ref) => ref.path)]);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});

test('全8種類のworker結果を既知outcomesへ集計し追加の戻り値を保持しない', async () => {
  await fixtures(async (f) => {
    const byUid = new Map<string, Status>();
    for (const [index, status] of statuses.entries()) {
      const ref = await f.row(String(index));
      byUid.set(ref.parent.parent!.id, status);
    }
    const processPostingDate = worker().mockImplementation(async (uid) => ({
      status: byUid.get(uid)!, raw: `synthetic-${uid}`,
    }));
    const result = await runPendingPostings({ db, processPostingDate, pageSize: 3, concurrency: 2 });
    expect(result).toEqual(summary(8, 0, {
      posted: 1, retry_wait: 1, failed: 1, unknown: 1,
      cancelled: 1, waiting: 1, skipped: 1, unavailable: 1,
    }));
    expect(JSON.stringify(result)).not.toContain(f.prefix);
  });
});

test('不正worker結果をoutcomesのキーに追加せず処理エラーとして継続する', async () => {
  await fixtures(async (f) => {
    const invalid: unknown[] = [null, {}, { status: '__proto__' }, { status: 'constructor' }, { status: 'synthetic-private' }];
    await Promise.all(Array.from({ length: invalid.length + 1 }, (_, index) => f.row(String(index))));
    let next = 0;
    const processPostingDate = worker().mockImplementation(async () => {
      const index = next;
      next += 1;
      return index < invalid.length ? invalid[index] as Awaited<ReturnType<Worker>> : { status: 'posted' };
    });
    const error = await failure({ db, processPostingDate, pageSize: 2, concurrency: 1 });
    expect(error.summary).toEqual(summary(6, 5, { posted: 1 }));
    expect(processPostingDate).toHaveBeenCalledTimes(6);
    expectSanitized(error, ['synthetic-private', f.prefix]);
  });
});

test('初回queryのcode 14をSDK再試行なしで注入しゼロの安全集計だけを返す', async () => {
  const raw = 'synthetic-private-query-failure';
  const original = Object.assign(new Error(raw), { code: 14, details: raw });
  const query = jest.spyOn(Query.prototype, 'get').mockRejectedValue(original);
  const processPostingDate = worker();
  const error = await failure({ db, processPostingDate });
  expect(query).toHaveBeenCalledTimes(1);
  expect(processPostingDate).not.toHaveBeenCalled();
  expect(error).not.toBe(original);
  expect(error.summary).toEqual(summary());
  expectSanitized(error, [raw]);
});

test('第2ページquery失敗は完了分だけを保持し再実行は残りpendingだけを処理する', async () => {
  await fixtures(async (f) => {
    const refs = await Promise.all(['01', '02', '03'].map((label) => f.row(label)));
    const cursor = await refs[1].get();
    const secondPage = pending().startAfter(cursor).limit(2);
    const original = Query.prototype.get;
    const raw = `synthetic-query-${f.prefix}`;
    let injected = 0;
    const spy = jest.spyOn(Query.prototype, 'get').mockImplementation(function (this: Query) {
      if (this.isEqual(secondPage)) {
        injected += 1;
        return Promise.reject(Object.assign(new Error(raw), { code: 14 }));
      }
      return original.call(this);
    });
    const processPostingDate = worker().mockImplementation(async (uid, key) => {
      await db.doc(`users/${uid}/dailyResults/${key}`).update({ postStatus: 'posted' });
      return { status: 'posted' };
    });
    try {
      const error = await failure({ db, processPostingDate, pageSize: 2, concurrency: 1 });
      expect(injected).toBe(1);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(error.summary).toEqual(summary(2, 0, { posted: 2 }));
      expect(processPostingDate).toHaveBeenCalledTimes(2);
      expectSanitized(error, [raw, f.prefix]);
    } finally {
      spy.mockRestore();
    }
    const before = await Promise.all(refs.slice(0, 2).map((ref) => ref.get()));
    processPostingDate.mockClear();
    expect(await runPendingPostings({ db, processPostingDate, pageSize: 2 }))
      .toEqual(summary(1, 0, { posted: 1 }));
    expect(processPostingDate.mock.calls).toEqual([[refs[2].parent.parent!.id, date]]);
    const after = await Promise.all(refs.slice(0, 2).map((ref) => ref.get()));
    for (let index = 0; index < before.length; index += 1) {
      expect(after[index].data()).toEqual(before[index].data());
      expect(after[index].updateTime!.isEqual(before[index].updateTime!)).toBe(true);
    }
  });
});

test('PendingPostingsErrorは既知集計をコピーし追加値・元の参照を保持しない', () => {
  const input = {
    ...summary(2, 1, { posted: 1 }),
    uid: 'synthetic-private-uid',
    cause: new Error('synthetic-private-cause'),
    outcomes: { ...summary().outcomes, posted: 1, privateValue: 'synthetic-private-value' },
  };
  const error = new PendingPostingsError(input);
  input.processed = 999;
  input.outcomes.posted = 999;
  expect(error.summary).toEqual(summary(2, 1, { posted: 1 }));
  expect(error.summary).not.toBe(input);
  expect(error.summary.outcomes).not.toBe(input.outcomes);
  expectSanitized(error, ['synthetic-private-uid', 'synthetic-private-cause', 'synthetic-private-value']);
});

test('索引JSONは既存2索引・rateLimits TTLを保持しpostStatusの通常3modeとCG ASCだけを追加する', async () => {
  // Emulatorは索引要件を全て強制しない。この検査はデプロイ確認ではない。
  const text = await readFile(resolve(__dirname, '../../../../firestore.indexes.json'), 'utf8');
  const indexes: unknown = JSON.parse(text);
  expect(indexes).toEqual({
    indexes: [
      {
        collectionGroup: 'entries', queryScope: 'COLLECTION',
        fields: [
          { fieldPath: 'committedAt', order: 'ASCENDING' },
          { fieldPath: 'revision', order: 'ASCENDING' },
        ],
      },
      {
        collectionGroup: 'entries', queryScope: 'COLLECTION',
        fields: [
          { fieldPath: 'committedAt', order: 'DESCENDING' },
          { fieldPath: 'revision', order: 'DESCENDING' },
        ],
      },
    ],
    fieldOverrides: [
      { collectionGroup: 'rateLimits', fieldPath: 'expireAt', ttl: true, indexes: [] },
      {
        collectionGroup: 'dailyResults', fieldPath: 'postStatus',
        indexes: expect.arrayContaining([
          { queryScope: 'COLLECTION', order: 'ASCENDING' },
          { queryScope: 'COLLECTION', order: 'DESCENDING' },
          { queryScope: 'COLLECTION', arrayConfig: 'CONTAINS' },
          { queryScope: 'COLLECTION_GROUP', order: 'ASCENDING' },
        ]),
      },
    ],
  });
  const parsed = indexes as { fieldOverrides: { indexes: unknown[] }[] };
  expect(parsed.fieldOverrides[1].indexes).toHaveLength(4);
});
