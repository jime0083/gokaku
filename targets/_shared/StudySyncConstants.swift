import Foundation

/// Phase 5-3c-2: アプリ側(modules/study-sync の Expo Module)とロック画面側
/// (targets/widget の WidgetKit 拡張)で共有する定数。
/// `targets/_shared/` に置くことで、@bacons/apple-targets の仕組みにより
/// メインアプリターゲットと StudyWidget エクステンションターゲットの両方にそのままソースとして含まれる
/// (ios/ は `npx expo prebuild` の生成物で、このファイルが唯一の正)。
/// modules/study-sync/ios/StudySync.podspec の source_files からも同じファイルを指しているため、
/// ExpoModulesCore のブリッジ(別コンパイル単位の CocoaPod)側からも同じ内容を使う。
/// 以前はこのファイルを 2 か所(modules/study-sync/ios・targets/widget)に複製していたため、
/// 内容が少しずつ食い違う問題があった(5-3c-0 の調査)
enum StudySyncConstants {
    static let appGroupIdentifier = "group.com.jime0083.gokakuwatch"

    static let keychainService = "com.jime0083.gokakuwatch.studysync"
    static let keychainAccountDeviceToken = "deviceToken"
    static let keychainAccountUid = "uid"

    static let pendingQueueKey = "studySync.pendingEvents.v1"

    /// App Group のキューに積める件数の上限(5-3c-6)。App Group(UserDefaults)を食いつぶさないよう、
    /// 超えたら最も古いものから捨てる(StudySyncQueue.enqueue)。普通の使い方では、送信できない状態が
    /// 続く(機内モード・サーバー障害等)としても、200件は数日分の開始・停止・確認応答に相当し十分な余裕がある
    static let queueMaxItems = 200

    /// nativeSync(Cloud Functions)の送信先。開発ビルドは Firebase Emulator、本番ビルドは
    /// 本番の nativeSync を指す(requirements.md 3-2)。値は Swift に直書きせず、Info.plist の
    /// `NativeSyncBaseURL` キー(plugins/withNativeSyncBaseURL.js が Xcode の build setting
    /// `NATIVE_SYNC_BASE_URL` を Debug/Release ごとに書き分け、Info.plist 側は
    /// `$(NATIVE_SYNC_BASE_URL)` で展開を受ける)を実行時の `Bundle.main` から読む。
    /// メインアプリ・StudyWidget 拡張のどちらで実行していても、その時の実行プロセスの
    /// Info.plist(＝それぞれの Debug/Release ビルド設定)が使われる。
    /// 値が読めない・URL として不正な場合は nil を返す(P-033 修正: 以前は fatalError でアプリ自体が
    /// 落ちていた。呼び出し元(StudySyncAPI.post)は nil のときは送信せずに操作をキューへ積み、
    /// 送れなかった理由を StudySyncLastSyncError に記録する)。
    /// 次の場合も nil として扱う(5-3c-2 セキュリティ指摘。5-3c-6 で対応):
    /// - ビルド設定の展開がされず `$(NATIVE_SYNC_BASE_URL)` の文字列そのままが入っている場合
    ///   (build setting が未設定・プレースホルダーの展開に失敗した場合に起こりうる)
    /// - scheme が http・https のどちらでもない場合(URL(string:) は "abc" のような文字列も
    ///   scheme なしの相対参照として許容してしまうため、http・https であることを明示的に確認する)
    static var nativeSyncBaseURL: URL? {
        guard
            let raw = Bundle.main.object(forInfoDictionaryKey: "NativeSyncBaseURL") as? String,
            raw != "$(NATIVE_SYNC_BASE_URL)",
            let url = URL(string: raw),
            let scheme = url.scheme?.lowercased(),
            scheme == "http" || scheme == "https"
        else {
            return nil
        }
        return url
    }
}
