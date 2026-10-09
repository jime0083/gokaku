/** Cloud Functions のテスト。Emulator 上で実行する(ルートの `npm run test:functions` から起動) */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  // 'jose'(firebase-admin が内部で使う。ESM のみで ts-jest が直接 require できない)をスタブに置き換える。
  // テストでは Firebase の ID トークン検証を経由しない(CallableRequest を直接組み立てて渡す)ため安全(4-2a)
  moduleNameMapper: {
    '^jose$': '<rootDir>/src/__tests__/stubs/jose.stub.js',
  },
};
