/**
 * @jest-environment node
 */
/**
 * eslint.config.js の shared/ 用 import 制限(problem P-004)のテスト。
 * 実際の設定ファイルを読み込み、shared/ 配下のファイルとして lintText した結果を確認する(ファイルは作らない)
 */
import path from 'path';
import { ESLint } from 'eslint';

const ROOT = path.resolve(__dirname, '../..');
const RULE_ID = 'gokaku/shared-imports-only';

// eslint.config.js は CommonJS。ESLint に読ませると動的 import になり Jest で扱えないため、require して渡す
// eslint-disable-next-line @typescript-eslint/no-require-imports
const config = require(path.join(ROOT, 'eslint.config.js'));

const eslint = new ESLint({ cwd: ROOT, overrideConfigFile: true, overrideConfig: config });

/** 指定パスのファイルとして code を lint し、shared/ 用ルールのエラーだけを返す */
const ruleErrors = async (relativeFile: string, code: string) => {
  const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, relativeFile) });
  const fatal = result.messages.filter((m) => m.fatal);
  expect(fatal).toEqual([]);
  return result.messages.filter((m) => m.ruleId === RULE_ID);
};

describe('shared/ の import 制限', () => {
  describe('shared/ 直下のファイル', () => {
    const file = 'shared/sample.ts';

    it.each([
      ['../src 配下', "import x from '../src/app/index';", 'outsideShared'],
      ['../functions 配下', "import x from '../functions/src/index';", 'outsideShared'],
      ['プロジェクトルート', "import x from '..';", 'outsideShared'],
      ['shared/ を経由して外に出る', "import x from './__tests__/../../src/app/index';", 'outsideShared'],
      ['外部パッケージ', "import { View } from 'react-native';", 'notRelative'],
      ['外部パッケージ(スコープ付き)', "import x from '@firebase/app';", 'notRelative'],
      ['@/ 別名', "import x from '@/app/index';", 'notRelative'],
      ['@shared/ 別名', "import x from '@shared/date';", 'notRelative'],
      ['Node 組み込み', "import fs from 'fs';", 'notRelative'],
      ['export ... from', "export { x } from '../src/app/index';", 'outsideShared'],
      ['export * from', "export * from 'react-native';", 'notRelative'],
      ['import type', "import type { X } from '../src/app/index';", 'outsideShared'],
      ['動的 import', "const m = import('../src/app/index');", 'outsideShared'],
      ['require', "const m = require('react-native');", 'notRelative'],
      ['import = require', "import m = require('../functions/src/index');", 'outsideShared'],
    ])('%s はエラー', async (_label, code, messageId) => {
      const errors = await ruleErrors(file, code);
      expect(errors).toHaveLength(1);
      expect(errors[0].messageId).toBe(messageId);
    });

    it.each([
      ['同階層', "import { addDays } from './date';"],
      ['index', "import { addDays } from './index';"],
      ['./ を経由して shared/ 内に戻る', "import { addDays } from './__tests__/../date';"],
      ['export ... from', "export { addDays } from './date';"],
    ])('%s は通る', async (_label, code) => {
      expect(await ruleErrors(file, code)).toEqual([]);
    });
  });

  describe('shared/ のサブディレクトリのファイル', () => {
    const file = 'shared/__tests__/sample.test.ts';

    it.each([
      ['shared/ 内の親', "import { addDays } from '../date';"],
      ['shared/ 自体(index)', "import { addDays } from '..';"],
      ['同階層', "import { helper } from './helper';"],
    ])('%s は通る', async (_label, code) => {
      expect(await ruleErrors(file, code)).toEqual([]);
    });

    it.each([
      ['../../src 配下', "import x from '../../src/app/index';", 'outsideShared'],
      ['../../functions 配下', "import x from '../../functions/src/index';", 'outsideShared'],
      ['外部パッケージ', "import { View } from 'react-native';", 'notRelative'],
      ['@shared/ 別名', "import x from '@shared/date';", 'notRelative'],
    ])('%s はエラー', async (_label, code, messageId) => {
      const errors = await ruleErrors(file, code);
      expect(errors).toHaveLength(1);
      expect(errors[0].messageId).toBe(messageId);
    });
  });

  // problem P-005: .ts 以外の拡張子でも制限を抜けられないこと
  describe('.ts 以外の拡張子のファイル', () => {
    it.each(['shared/sample.tsx', 'shared/sample.js', 'shared/sample.jsx', 'shared/sample.mjs', 'shared/sample.cjs'])(
      '%s から react-native を import するとエラー',
      async (file) => {
        const errors = await ruleErrors(file, "import { View } from 'react-native';");
        expect(errors).toHaveLength(1);
        expect(errors[0].messageId).toBe('notRelative');
      },
    );

    it.each(['shared/sample.tsx', 'shared/sample.js'])('%s から shared/ の外を import するとエラー', async (file) => {
      const errors = await ruleErrors(file, "import x from '../src/app/index';");
      expect(errors).toHaveLength(1);
      expect(errors[0].messageId).toBe('outsideShared');
    });

    it.each(['shared/sample.tsx', 'shared/sample.js'])('%s から require で react-native を読むとエラー', async (file) => {
      const errors = await ruleErrors(file, "const m = require('react-native');");
      expect(errors).toHaveLength(1);
      expect(errors[0].messageId).toBe('notRelative');
    });

    it.each(['shared/sample.tsx', 'shared/sample.js'])('%s から shared/ 内の相対パスは通る', async (file) => {
      expect(await ruleErrors(file, "import { addDays } from './date';")).toEqual([]);
    });
  });

  it('shared/ 以外のファイルには適用されない', async () => {
    expect(await ruleErrors('src/sample.ts', "import { View } from 'react-native';")).toEqual([]);
  });
});
