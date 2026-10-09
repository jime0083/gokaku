/** Firestore セキュリティルールのテスト。Emulator 上で実行する(`npm run test:rules` から起動) */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests/rules'],
  transform: {
    '\\.ts$': ['babel-jest', { presets: ['babel-preset-expo'] }],
  },
  // tsconfig.json の paths(@shared/*)と同じ解決を babel-jest(tsconfig の paths を見ない)でも行う
  moduleNameMapper: {
    '^@shared/(.*)$': '<rootDir>/shared/$1',
  },
};
