/** Cloud Functions のテスト。Emulator 上で実行する(ルートの `npm run test:functions` から起動) */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
};
