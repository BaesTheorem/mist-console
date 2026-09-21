import Combine
import Foundation

/// Where the app stands with the Mac, and which address the web view is on.
@MainActor
final class ConsoleLink: ObservableObject {
    enum State: Equatable {
        case idle
        case probing
        case connected
        case unreachable(String)
        case rejected(String)
    }

    @Published var state: State = .idle
    @Published var base: URL?
    /// Bumped whenever the web view must log in and load again (new address,
    /// re-pair, manual retry). The view compares it against what it last loaded.
    @Published var loadGeneration = 0
    @Published var showSettings = false
    @Published var lastResults: [String: Bool] = [:]
    @Published var lastProbeAt: Date?

    private var inFlight = false

    func reconnect(store: ServerStore) {
        Task { await connect(store: store, force: true) }
    }

    /// Back in the foreground. The page's own event stream reconnects by
    /// itself; this only moves the web view when the Mac is now reachable
    /// somewhere else (home Wi-Fi vs. the tunnel), or raises the overlay when
    /// it is not reachable at all.
    func becameActive(store: ServerStore) {
        Task { await connect(store: store, force: false) }
    }

    func connect(store: ServerStore, force: Bool) async {
        guard let pairing = store.pairing else {
            state = .idle
            base = nil
            return
        }
        if inFlight { return }
        inFlight = true
        defer { inFlight = false }

        let wasConnectedTo: URL? = (state == .connected) ? base : nil
        state = .probing
        let candidates = pairing.urls.compactMap { URL(string: $0) }
        var (picked, results) = await Probe.pick(candidates)
        if picked == nil, let d = pairing.discovery, let du = URL(string: d) {
            let extra = await Probe.discover(du).filter { !pairing.urls.contains($0) }
            if !extra.isEmpty {
                store.merge(urls: extra, discovery: nil)
                let (p2, r2) = await Probe.pick(extra.compactMap { URL(string: $0) })
                picked = p2
                results.merge(r2) { $1 }
            }
        }
        lastResults = results
        lastProbeAt = Date()

        guard let url = picked else {
            state = .unreachable("None of the Mac's addresses answered. Is the Console open, and is the Mac awake and online?")
            return
        }
        switch await Probe.login(url, token: pairing.token) {
        case .ok:
            if !force, wasConnectedTo == url {
                state = .connected   // same page, same address: leave it alone
            } else {
                base = url
                loadGeneration += 1
                state = .connected
            }
            // Learn any address the Mac has since gained (the tunnel URL moves).
            Task {
                if let c = await Probe.config(url, token: pairing.token) {
                    store.merge(urls: c.urls, discovery: c.discovery)
                }
            }
        case .wrongToken:
            state = .rejected("The Mac rejected this phone's token. Re-pair from the phone section of the Console's settings.")
        case .off:
            state = .unreachable("Remote access is switched off in the Console's settings on the Mac (settings, phone).")
        case .rateLimited:
            state = .unreachable("Too many login attempts from this address. Wait a few minutes and try again.")
        case .unreachable(let why):
            state = .unreachable(why)
        }
    }

    // Reported by the web view.
    func pageFailed(_ message: String) {
        if state == .connected { state = .unreachable(message) }
    }

    func pageRejected() {
        state = .rejected("The Console refused this phone's token. Re-pair from the Mac's phone section.")
    }

    func forgetMac() {
        state = .idle
        base = nil
        lastResults = [:]
    }
}
