import ExpoModulesCore

/// requirements.md 3-2: アプリ起動時のオフラインキュー再送を行う AppDelegate フック。
/// 「勉強中？」確認の通知(カテゴリ・アクションの登録、応答の受け取り)は JS 側
/// (src/features/timer/studyCheckNotifications.ts、5-2c)だけが扱う(problem P-031)。
/// expo-module.config.json の appDelegateSubscribers に登録される(Expo Modules の仕組み。
/// ios/ は生成物のため、ここに書いたコードが prebuild の度に再生成される AppDelegate から呼ばれる)
public class StudySyncAppDelegateSubscriber: ExpoAppDelegateSubscriber {
    public func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        Task {
            _ = await StudySyncAPI.flushQueue()
        }

        return true
    }
}
