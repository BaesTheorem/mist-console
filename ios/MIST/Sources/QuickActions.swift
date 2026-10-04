import SwiftUI
import UIKit

/// The Home Screen icon's long-press menu: "New chat" opens a fresh chat, the
/// same as the widget's mist://new. The item is static (Info.plist
/// UIApplicationShortcutItems); this routes it into the app.
///
/// A cold launch hands the item to the app delegate while the scene is being
/// made, before SwiftUI has a view to tell, so it waits in `pending` until
/// the root view appears. A warm launch reaches the scene delegate, which
/// posts it straight to the running app.
enum QuickAction {
    static let newChat = "com.alexhedtke.mistconsole.new"
    static let notification = Notification.Name("MISTQuickAction")
    static var pending: URL?

    static func url(for item: UIApplicationShortcutItem) -> URL? {
        item.type == newChat ? URL(string: "mist://new") : nil
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        if let item = options.shortcutItem { QuickAction.pending = QuickAction.url(for: item) }
        let config = UISceneConfiguration(name: nil, sessionRole: session.role)
        config.delegateClass = QuickActionSceneDelegate.self
        return config
    }
}

final class QuickActionSceneDelegate: NSObject, UIWindowSceneDelegate {
    func windowScene(_ windowScene: UIWindowScene,
                     performActionFor shortcutItem: UIApplicationShortcutItem,
                     completionHandler: @escaping (Bool) -> Void) {
        guard let url = QuickAction.url(for: shortcutItem) else { completionHandler(false); return }
        NotificationCenter.default.post(name: QuickAction.notification, object: url)
        completionHandler(true)
    }
}
