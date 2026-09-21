import SwiftUI

/// MIST for iPhone: a native shell around the MIST Console web UI served by
/// the Mac. The Console itself (Flask + the headless `claude` backends) never
/// leaves the Mac; this app pairs with it once, finds it (LAN, tunnel, or a
/// configured address), logs in, and shows the same page every chat lives on.
@main
struct MISTApp: App {
    @StateObject private var store = ServerStore()
    @StateObject private var link = ConsoleLink()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .environmentObject(link)
                .preferredColorScheme(.dark)
                .onOpenURL { url in handle(url) }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { link.becameActive(store: store) }
                }
        }
    }

    /// mist://pair?d=… pairs (or re-pairs); mist://settings opens the sheet.
    private func handle(_ url: URL) {
        if let pairing = Pairing.parse(url: url) {
            store.apply(pairing)
            link.reconnect(store: store)
        } else if url.host?.lowercased() == "settings" {
            link.showSettings = true
        } else if url.host?.lowercased() == "new" {
            // From the "New chat" widget: a fresh chat as soon as the page is up.
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
