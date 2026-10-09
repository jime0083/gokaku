/**
 * Jest 専用のスタブ(functions/jest.config.js の moduleNameMapper で 'jose' の代わりに読まれる)。
 *
 * 'jose'(firebase-admin が内部で ID トークン検証に使う)は v6 以降 ESM のみ(CJS ビルドなし)で、
 * ts-jest(CommonJS)が node_modules 配下の ESM を変換なしに require すると
 * "Cannot use import statement outside a module" で失敗する。
 *
 * テストでは Firebase の ID トークン検証(内部で jose を使う)を一切経由しない
 * (onCall の CallableRequest を直接組み立てて渡すため、本物の検証コードは呼ばれない)ため、
 * 呼ばれない前提の no-op スタブで置き換えてよい。実際に呼ばれた場合はすぐ分かるよう例外を投げる
 */
module.exports = new Proxy(
  {},
  {
    get() {
      return () => {
        throw new Error('jose スタブが呼び出されました(テストでは実際の ID トークン検証を行わない前提)');
      };
    },
  },
);
