/**
 * アプリと共有するドメインロジック(リポジトリ直下の shared/)の functions 側の入口。
 * functions のコードは shared を直接 import せず、このモジュール経由で使う。
 *
 * build(tsc)で shared のコードも functions/lib 配下に出力されるため、
 * `firebase deploy --only functions`(functions/ のみアップロード)でも共有コードが含まれる。
 */
export * from '../../shared/index';
