import SwiftUI

/// MIST for iPhone: a native shell around the MIST Console web UI served by
/// the Mac. The Console itself (Flask + the headless `claude` backends) never
/// leaves the Mac; this app pairs with it once, finds it (LAN, tunnel, or a
/// configured address), logs in, and shows the same page every chat lives on.
@main
struct MISTApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var store = ServerStore()
    @StateObject private var link = ConsoleLink()
    @StateObject private var cache = ChatCache()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .environmentObject(link)
                .environmentObject(cache)
                .preferredColorScheme(.dark)
                .onAppear {
                    link.cache = cache
                    if let url = QuickAction.pending { QuickAction.pending = nil; handle(url) }
                }
                .onOpenURL { url in handle(url) }
                .onReceive(NotificationCenter.default.publisher(for: QuickAction.notification)) { note in
                    if let url = note.object as? URL { handle(url) }
                }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { link.becameActive(store: store) }
                }
        }
    }

    /// mist://pair?d=… pairs (or re-pairs); mist://settings opens the sheet;
    /// mist://offline opens the offline copy; mist://new opens a fresh chat.
    private func handle(_ url: URL) {
        if let pairing = Pairing.parse(url: url) {
            store.apply(pairing)
            link.reconnect(store: store)
        } else if url.host?.lowercased() == "settings" {
            link.showSettings = true
        } else if url.host?.lowercased() == "offline" {
            // From the drawer's "Offline" button in the page.
            link.showReader = true
        } else if url.host?.lowercased() == "new" {
            // From the "New chat" widget or the icon's menu: a fresh chat as soon as the page is up.
            link.pendingScript = "if (typeof createSession === 'function') createSession();"
        }
    }
}

extension Color {
    /// The Console's ground (md-tokens.css --md-sys-color-surface) and accent.
    static let surface = Color(red: 0x09 / 255, green: 0x14 / 255, blue: 0x20 / 255)
    static let surfaceLow = Color(red: 0x12 / 255, green: 0x1c / 255, blue: 0x28 / 255)
    static let teal = Color(red: 0x38 / 255, green: 0xdb / 255, blue: 0xdb / 255)
    static let hairline = Color.white.opacity(0.14)
}
