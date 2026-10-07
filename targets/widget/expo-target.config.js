/**
 * Phase 1-4 技術検証: ライブアクティビティ・ロック画面コントロール用の WidgetKit 拡張ターゲット。
 * @bacons/apple-targets が `npx expo prebuild` 時にこの設定から Xcode ターゲットを生成する
 * (ios/ は生成物なので、ここ(targets/widget)にある設定・Swift コードだけが正)
 *
 * @type {import('@bacons/apple-targets/app.plugin').ConfigFunction}
 */
module.exports = (config) => ({
  type: 'widget',
  name: 'StudyWidget',
  // 本体アプリ(17.0)と同じ最低 iOS バージョン。iOS 18 専用の機能(ControlWidget)は
  // Swift 側で @available(iOS 18.0, *) / if #available で分岐する
  deploymentTarget: '17.0',
  frameworks: ['SwiftUI', 'WidgetKit', 'ActivityKit', 'AppIntents'],
  entitlements: {
    'com.apple.security.application-groups':
      config.ios.entitlements['com.apple.security.application-groups'],
    'keychain-access-groups': config.ios.entitlements['keychain-access-groups'],
  },
});
