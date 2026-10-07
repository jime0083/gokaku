import ExpoModulesCore
import UserNotifications

/// requirements.md 3-2: 「勉強中？」確認のローカル通知アクション(アプリを開かずに応答できる)と、
/// アプリ起動時のオフラインキュー再送を行う AppDelegate フック。
/// expo-module.config.json の appDelegateSubscribers に登録される(Expo Modules の仕組み。
/// ios/ は生成物のため、ここに書いたコードが prebuild の度に再生成される AppDelegate から呼ばれる)
public class StudySyncAppDelegateSubscriber: ExpoAppDelegateSubscriber {
    public func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let confirmAction = UNNotificationAction(
            identifier: StudySyncConstants.notificationActionConfirm,
            title: "勉強中",
            options: []
        )
        let category = UNNotificationCategory(
            identifier: StudySyncConstants.notificationCategoryStudyCheck,
            actions: [confirmAction],
            intentIdentifiers: [],
            options: []
        )
        UNUserNotificationCenter.current().setNotificationCategories([category])
        UNUserNotificationCenter.current().delegate = StudySyncNotificationDelegate.shared

        Task {
            _ = await StudySyncAPI.flushQueue()
        }

        return true
    }
}
