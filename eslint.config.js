// https://docs.expo.dev/guides/using-eslint/
const path = require('path');
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const globals = require('globals');

/** アプリと Cloud Functions で共有する純粋な TypeScript の置き場所 */
const SHARED_DIR = path.join(__dirname, 'shared');

/** `./x`・`../x`・`.`・`..` のような相対パスか */
const isRelativeSpecifier = (source) => /^\.{1,2}(\/|$)/.test(source);

/** import 元のファイルから見た相対パスを解決し、shared/ 内(shared/ 自体を含む)を指すか判定する */
const resolvesInsideShared = (filename, source) => {
  const resolved = path.resolve(path.dirname(filename), source);
  return resolved === SHARED_DIR || resolved.startsWith(SHARED_DIR + path.sep);
};

/**
 * shared/ のファイルから shared/ の外を import することを禁止するルール。
 * - 相対パス以外(外部パッケージ・`@/`・`@shared/`・絶対パス等)は全てエラー
 * - 相対パスは import 元のファイル位置から解決し、shared/ の外を指していればエラー
 *   (`../src/...` 等。`./x/../../src` のような迂回も解決後のパスで判定する)
 * 対象: import / export ... from / import() / require() / import x = require()
 */
const sharedImportsOnlyRule = {
  meta: {
    type: 'problem',
    docs: { description: 'shared/ から shared/ の外を import することを禁止する' },
    schema: [],
    messages: {
      notRelative:
        "shared/ では相対パス以外を import できません(外部パッケージ・'@/'・'@shared/' 等は不可): '{{source}}'",
      outsideShared: "shared/ の外を指す import はできません(shared/ 内の相対パスのみ可): '{{source}}'",
    },
  },
  create(context) {
    const check = (node) => {
      if (!node || node.type !== 'Literal' || typeof node.value !== 'string') {
        return;
      }
      const source = node.value;
      if (!isRelativeSpecifier(source)) {
        context.report({ node, messageId: 'notRelative', data: { source } });
        return;
      }
      if (!resolvesInsideShared(context.filename, source)) {
        context.report({ node, messageId: 'outsideShared', data: { source } });
      }
    };
    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      TSExternalModuleReference: (node) => check(node.expression),
      CallExpression: (node) => {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
          check(node.arguments[0]);
        }
      },
    };
  },
};

module.exports = defineConfig([
  expoConfig,
  {
    ignores: [
      'dist/*',
      'web-build/*',
      'ios/*',
      'android/*',
      '.expo/*',
      'coverage/*',
      'functions/lib/*',
      'functions/coverage/*',
    ],
  },
  {
    // Node.js で実行されるファイル(設定ファイル・Cloud Functions・Emulator 上のテスト・開発用スクリプト)。Node のグローバル変数(__dirname 等)を定義する(problem P-006)
    files: [
      '*.config.{js,cjs,mjs}',
      'functions/**/*.{ts,js,cjs,mjs}',
      'tests/**/*.{ts,js,cjs,mjs}',
      'scripts/**/*.{js,cjs,mjs}',
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // shared/ はアプリと Cloud Functions で共有する純粋な TypeScript。shared/ の外(外部パッケージ・別名パス・src/ 等)の import を禁止する
    // .ts 以外のファイルを置かれても制限を抜けられないよう、ESLint が解析する全ての拡張子を対象にする(problem P-005)
    files: ['shared/**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    plugins: {
      gokaku: { rules: { 'shared-imports-only': sharedImportsOnlyRule } },
    },
    rules: {
      'gokaku/shared-imports-only': 'error',
    },
  },
]);
