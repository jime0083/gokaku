const fs = require('fs');
const path = require('path');

const { withFinalizedMod } = require('expo/config-plugins');
const { XcodeProject } = require('@bacons/xcode');
const xcodeParse = require('@bacons/xcode/json');

/**
 * Phase 5-3c-2: nativeSync(ロック画面・ライブアクティビティからの送信先)の URL を、
 * Xcode の build setting `NATIVE_SYNC_BASE_URL` として Debug/Release ごとに書き分ける config plugin。
 *
 * - メインアプリ(app.json の ios.infoPlist.NativeSyncBaseURL)・StudyWidget 拡張(targets/widget/Info.plist)の
 *   どちらの Info.plist にも `NativeSyncBaseURL` キーを `$(NATIVE_SYNC_BASE_URL)` として書いてある。
 *   Xcode は Info.plist の処理時にこの `$(VAR)` を build setting の値に展開する
 *   (Apple のドキュメント「Build Settings Reference」に記載の、Info.plist 内での変数展開の仕組み)。
 * - 値は Swift に直書きせず、実行時に Bundle.main からこのキーを読む(targets/_shared/StudySyncConstants.swift)。
 *   メインアプリ・StudyWidget 拡張のどちらの実行プロセスでも、その時の Bundle.main の Info.plist
 *   (＝それぞれの Debug/Release のビルド設定)が使われる。
 *
 * 開発ビルド(Debug)は Firebase Emulator(shared/functionsRegion.ts の FUNCTIONS_REGION・
 * src/config/firebase-emulator.ts の FIREBASE_EMULATOR_CONFIG と同じ demo-gokaku プロジェクト)、
 * 本番ビルド(Release)は本番の nativeSync(requirements.md 7 の Firebase 本番プロジェクト syuchyuchyu。
 * 4-2b の appleServerNotification と同じ形の URL)を指す。値を変える場合はこのファイルと、
 * 上記の shared/・src/config/ の定数を両方更新すること。
 *
 * @bacons/apple-targets(app.json の "@bacons/apple-targets")が生成する StudyWidget ターゲットは、
 * 標準の Expo `withXcodeProject` とは別の mod("xcodeProjectBeta2")で project.pbxproj を書き込む。
 * `@expo/config-plugins` の mod 実行順は種類ごとに固定(dangerous → xcodeproj → その他(xcodeProjectBeta2 含む)
 * → finalized。mod-compiler.js の precedences 定義)なので、StudyWidget ターゲットが作られた後に
 * project.pbxproj を直接読み書きできるよう、この plugin は `withFinalizedMod`(全ての mod の最後に走る)を使う。
 * dangerousMod で試したところ StudyWidget ターゲットが作られる前に実行され、メインアプリ側にしか
 * build setting が付かなかった(StudyWidget 側が undefined になることを確認済み)
 */

/** shared/functionsRegion.ts の FUNCTIONS_REGION・src/config/firebase-emulator.ts の FIREBASE_EMULATOR_CONFIG と同じ値 */
const DEBUG_NATIVE_SYNC_BASE_URL = 'http://127.0.0.1:5001/demo-gokaku/asia-northeast1/nativeSync';
/** requirements.md 7 の本番 Firebase プロジェクト(syuchyuchyu)の nativeSync */
const RELEASE_NATIVE_SYNC_BASE_URL =
  'https://asia-northeast1-syuchyuchyu.cloudfunctions.net/nativeSync';

const withNativeSyncBaseURL = (config) => {
  return withFinalizedMod(config, [
    'ios',
    (config) => {
      const platformProjectRoot = config.modRequest.platformProjectRoot;
      const projectName = config.modRequest.projectName;
      if (!projectName) {
        return config;
      }

      const pbxprojPath = path.join(
        platformProjectRoot,
        `${projectName}.xcodeproj`,
        'project.pbxproj'
      );
      if (!fs.existsSync(pbxprojPath)) {
        throw new Error(`[withNativeSyncBaseURL] ${pbxprojPath} が見つかりません`);
      }

      const project = XcodeProject.open(pbxprojPath);

      const valueForConfiguration = (configurationName) =>
        configurationName === 'Debug' ? DEBUG_NATIVE_SYNC_BASE_URL : RELEASE_NATIVE_SYNC_BASE_URL;

      // メインアプリターゲット(gokaku)と StudyWidget 拡張ターゲットの両方に設定する。
      // target.setBuildSetting(key, value) は Debug/Release に同じ値を入れてしまうため、
      // buildConfigurationList を直接たどって Debug/Release ごとに別の値を入れる
      const targets = project.rootObject.props.targets;
      for (const target of targets) {
        const buildConfigurations = target.props.buildConfigurationList.props.buildConfigurations;
        for (const buildConfiguration of buildConfigurations) {
          buildConfiguration.props.buildSettings.NATIVE_SYNC_BASE_URL = valueForConfiguration(
            buildConfiguration.props.name
          );
        }
      }

      const contents = xcodeParse.build(project.toJSON());
      fs.writeFileSync(pbxprojPath, contents);

      return config;
    },
  ]);
};

module.exports = withNativeSyncBaseURL;
