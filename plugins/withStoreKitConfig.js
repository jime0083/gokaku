const fs = require('fs');
const path = require('path');

const { withDangerousMod } = require('expo/config-plugins');

/**
 * Phase 4-1a 技術検証: Xcode の StoreKit 設定ファイル(.storekit)を
 * CNG(Continuous Native Generation。ios/ は .gitignore 済みで `npx expo prebuild` ごとに作り直される)でも
 * 消えない形でシミュレータ実行用のスキームに結び付ける config plugin。
 *
 * 出典: StoreKit 設定ファイルをスキームに結び付ける仕組み自体は Xcode の機能(Product > Scheme > Edit Scheme >
 * Run > Options > StoreKit Configuration)。.xcscheme の XML 要素名 `StoreKitConfigurationFileReference`
 * (LaunchAction の子。identifier 属性に .storekit ファイルへの相対パス)は、
 * CocoaPods の xcodeproj gem(XcodeProj)がこの機能に対応した際の変更で確認した
 * (https://github.com/tuist/XcodeProj/pull/573 、CHANGELOG: https://cocoapods.org/pods/xcodeproj/changelog#7141)。
 *
 * 動作:
 * 1. config/gokaku.storekit(このリポジトリの正)を prebuild のたびに ios/<projectName>.storekit へコピーする
 * 2. ios/<projectName>.xcodeproj/xcshareddata/xcschemes/<projectName>.xcscheme の LaunchAction に
 *    StoreKitConfigurationFileReference が無ければ追記する(相対パスは Node の path.relative で都度計算する)
 */
const withStoreKitConfig = (config) => {
  return withDangerousMod(config, [
    'ios',
    (config) => {
      const projectRoot = config.modRequest.projectRoot;
      const platformProjectRoot = config.modRequest.platformProjectRoot;
      const projectName = config.modRequest.projectName;

      if (!projectName) {
        // prebuild の projectName が取れない場合は何もしない(通常は発生しない)
        return config;
      }

      const sourceStoreKitFile = path.join(projectRoot, 'config', 'gokaku.storekit');
      if (!fs.existsSync(sourceStoreKitFile)) {
        throw new Error(
          `[withStoreKitConfig] ${sourceStoreKitFile} が見つかりません(4-1a で作成した StoreKit 設定ファイル)`
        );
      }

      const destStoreKitFile = path.join(platformProjectRoot, `${projectName}.storekit`);
      fs.copyFileSync(sourceStoreKitFile, destStoreKitFile);

      const schemePath = path.join(
        platformProjectRoot,
        `${projectName}.xcodeproj`,
        'xcshareddata',
        'xcschemes',
        `${projectName}.xcscheme`
      );
      if (!fs.existsSync(schemePath)) {
        // スキーム名がプロジェクト名と異なる構成になった場合は、ここで気づけるようにエラーにする
        throw new Error(`[withStoreKitConfig] スキームファイルが見つかりません: ${schemePath}`);
      }

      const relativeIdentifier = path.relative(path.dirname(schemePath), destStoreKitFile);
      let schemeContents = fs.readFileSync(schemePath, 'utf8');

      if (schemeContents.includes('StoreKitConfigurationFileReference')) {
        // 既に追記済み(同じ prebuild 内の再実行等)。identifier だけ最新のパスに揃える
        schemeContents = schemeContents.replace(
          /<StoreKitConfigurationFileReference\s+identifier\s*=\s*"[^"]*">/,
          `<StoreKitConfigurationFileReference\n      identifier = "${relativeIdentifier}">`
        );
      } else {
        const launchActionCloseTag = '</LaunchAction>';
        const insertion =
          `      <StoreKitConfigurationFileReference\n` +
          `         identifier = "${relativeIdentifier}">\n` +
          `      </StoreKitConfigurationFileReference>\n` +
          `   ${launchActionCloseTag}`;
        if (!schemeContents.includes(launchActionCloseTag)) {
          throw new Error(`[withStoreKitConfig] ${schemePath} に LaunchAction が見つかりません`);
        }
        schemeContents = schemeContents.replace(`   ${launchActionCloseTag}`, insertion);
      }

      fs.writeFileSync(schemePath, schemeContents);

      return config;
    },
  ]);
};

module.exports = withStoreKitConfig;
