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
    /// A pairing link that would replace the current pairing, waiting for Alex
    /// to confirm it. Any app or web page can open a mist://pair link, so one
    /// must never silently point the phone (and its token) at another server.
    @State private var offered: Pairing?

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
                .alert(offerTitle, isPresented: Binding(get: { offered != nil },
                                                        set: { if !$0 { offered = nil } }),
                       presenting: offered) { p in
                    Button("pair") {
                        offered = nil
                        store.apply(p)
                        link.reconnect(store: store)
                    }
                    Button("cancel", role: .cancel) { offered = nil }
                } message: { p in
                    Text("This replaces the pairing with \(store.pairing?.name ?? "the current Mac"). Only accept a code you just made on your own Mac.\n\n\(p.urls.joined(separator: "\n"))")
                }
        }
    }

    /// mist://pair?d=… pairs (or re-pairs); mist://settings opens the sheet;
    /// mist://offline opens the offline copy; mist://new opens a fresh chat.
    /// The rest goes through ConsoleLink.handle(mistURL:), the same router
    /// the page's own mist: links use.
    private func handle(_ url: URL) {
        if let pairing = Pairing.parse(url: url) {
            if let current = store.pairing, current != pairing {
                offered = pairing   // replacing a pairing: ask first
            } else {
                store.apply(pairing)
                link.reconnect(store: store)
            }
        } else {
            link.handle(mistURL: url)
        }
    }

    private var offerTitle: String {
        guard let p = offered else { return "" }
        let host = p.urls.first.flatMap { URL(string: $0)?.host } ?? "an unknown address"
        return "Pair with \(p.name) at \(host)?"
    }
}

extension Color {
    /// The Console's ground (md-tokens.css --md-sys-color-surface) and accent.
    static let surface = Color(red: 0x09 / 255, green: 0x14 / 255, blue: 0x20 / 255)
    static let surfaceLow = Color(red: 0x12 / 255, green: 0x1c / 255, blue: 0x28 / 255)
    static let teal = Color(red: 0x38 / 255, green: 0xdb / 255, blue: 0xdb / 255)
    static let hairline = Color.white.opacity(0.14)
}
