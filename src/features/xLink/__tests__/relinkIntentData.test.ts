import {
  RELINK_INTENT_PREFIX, relinkIntentKey, parseRelinkIntent,
} from '../relinkIntentData';

it('uses the exact canonical encoded UID key without normalizing UID', () => {
  const uid = ' owner/a:% 日本 ';
  const key = RELINK_INTENT_PREFIX + encodeURIComponent(uid);
  expect(relinkIntentKey(uid)).toBe(key);
  expect(parseRelinkIntent(key, JSON.stringify({ version: 1, uid })))
    .toEqual({ version: 1, uid });
});

it.each([undefined, null, 1, {}, '', ' ', '\n'])(
  'rejects invalid UID %j', (uid) => {
    expect(() => relinkIntentKey(uid as string)).toThrow('relink-intent-invalid-uid');
  },
);

it.each([
  '{', 'null', 'false', '0', '[]', '{}',
  '{"version":1}', '{"uid":"owner-a"}',
  '{"version":2,"uid":"owner-a"}',
  '{"version":"1","uid":"owner-a"}',
  '{"version":1,"uid":null}',
  '{"version":1,"uid":1}',
  '{"version":1,"uid":""}',
  '{"version":1,"uid":" "}',
  '{"version":1,"uid":"owner-b"}',
  '{"version":1,"uid":"owner-a","token":"forbidden"}',
  '{"version":1,"uid":"owner-a","profile":null}',
  '{"version":1,"uid":"owner-a","url":null}',
  '{"version":1,"uid":"owner-a","extra":false}',
])('rejects malformed, foreign or extended payload %s', (raw) => {
  expect(parseRelinkIntent(relinkIntentKey('owner-a'), raw)).toBeNull();
});

it.each([
  '', RELINK_INTENT_PREFIX, RELINK_INTENT_PREFIX + '%ZZ',
  RELINK_INTENT_PREFIX + 'owner%2Da',
  'unrelated:owner-a',
])('rejects a noncanonical or unrelated key %s', (key) => {
  expect(parseRelinkIntent(key, '{"version":1,"uid":"owner-a"}')).toBeNull();
});

it('can be imported without initializing storage, auth or the runtime gate', () => {
  const modules = [
    '@/config/firebase',
    '@/features/account/accountOperationRuntime',
    '@react-native-async-storage/async-storage',
  ];
  try {
    for (const name of modules) {
      jest.doMock(name, () => { throw new Error('unexpected-native-import'); });
    }
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pure = require('../relinkIntentData') as typeof import('../relinkIntentData');
      expect(pure.parseRelinkIntent(pure.relinkIntentKey('a'), '{"version":1,"uid":"a"}'))
        .toEqual({ version: 1, uid: 'a' });
    });
  } finally {
    for (const name of modules) jest.dontMock(name);
  }
});
