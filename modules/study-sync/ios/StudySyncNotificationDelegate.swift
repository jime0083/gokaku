import UserNotifications

/// 通知アクション「勉強中」への応答(requirements.md 3-2)を、アプリを開かずに処理する。
/// `didReceive` はアプリが終了していても OS がバックグラウンドで一時的にプロセスを起動して呼ぶため、
/// この中で完了まで(数秒程度)ネットワーク送信を行える
final class StudySyncNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    static let shared = StudySyncNotificationDelegate()

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        guard response.actionIdentifier == StudySyncConstants.notificationActionConfirm,
            let auth = StudySyncKeychain.readDeviceToken()
        else {
            completionHandler()
            return
        }

        let goalId = response.notification.request.content.userInfo["goalId"] as? String ?? ""
        let event = StudySyncEvent(
            uid: auth.uid,
            goalId: goalId,
            action: .confirm,
            source: .notificationAction,
            clientTimeMs: Date().timeIntervalSince1970 * 1000,
            idempotencyKey: UUID().uuidString
        )

        Task {
            await StudySyncAPI.send(event)
            completionHandler()
        }
    }

    /// アプリが前面にある間に通知が届いた場合は、バナー表示だけ行う
    /// (requirements.md 3-2: 前面表示中はアプリ内ダイアログで確認する。ダイアログ自体は Phase 5-2 で実装)
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }
}
