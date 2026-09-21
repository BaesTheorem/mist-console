import Combine
import Foundation
import Network

/// Where the app stands with the Mac, and which address the web view is on.
///
/// Finding the Mac is two rounds. Round one races every address the phone
/// remembers and takes the first by list order that answers (or, if none do,
/// reads the discovery document and races what it learned). Round two asks
/// that Mac for its *current* list (`/remote/config`, LAN first) and races it
/// again, so a better address wins when one exists: on the iPhone's own
/// hotspot the Mac's tether address beats the tunnel that also answers, and
/// the two talk directly instead of out through Cloudflare and back.
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
    /// JavaScript the web view runs once the page is loaded (a widget deep
    /// link asking for a new chat, for instance), then clears.
    @Published var pendingScript: String?

    private var inFlight = false
    private var streamDown = false
    private var streamTimer: Timer?
    private var retryTimer: Timer?
    private var pathMonitor: NWPathMonitor?
    private var pathDebounce: Timer?
    private var lastPathKey = ""
    private weak var store: ServerStore?

    init() {
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            // Wi-Fi to cellular, hotspot on or off, a VPN coming up: the Mac may
            // now be reachable somewhere else (or nowhere), so look again.
            let key = "\(path.status)|\(path.availableInterfaces.map { $0.name }.sorted().joined(separator: ","))"
            Task { @MainActor in self?.pathChanged(key) }
        }
        monitor.start(queue: DispatchQueue(label: "mist.path"))
        pathMonitor = monitor
    }

    // MARK: - triggers

    func reconnect(store: ServerStore) {
        self.store = store
        Task { await connect(store: store, force: true) }
    }

    /// Back in the foreground. The page's own event stream reconnects by
    /// itself; this only moves the web view when a different address should
    /// now carry the connection, or raises the overlay when none answers.
    func becameActive(store: ServerStore) {
        self.store = store
        Task { await connect(store: store, force: false) }
    }

    private func pathChanged(_ key: String) {
        guard key != lastPathKey else { return }
        let first = lastPathKey.isEmpty
        lastPathKey = key
        if first { return }   // the initial report is not a change
        pathDebounce?.invalidate()
        pathDebounce = Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self, let store = self.store else { return }
                await self.connect(store: store, force: false)
            }
        }
    }

    /// From the page: its event stream went down or came back.
    func streamChanged(up: Bool) {
        streamDown = !up
        streamTimer?.invalidate()
        if up {
            if case .unreachable = state { state = .connected }   // the page proved it
            return
        }
        // EventSource retries on its own within a few seconds; only move if
        // it is still down after that.
        streamTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.streamDown, let store = self.store else { return }
                await self.connect(store: store, force: false)
            }
        }
    }

    // MARK: - the connect

    func connect(store: ServerStore, force: Bool) async {
        self.store = store
        guard let pairing = store.pairing else {
            state = .idle
            base = nil
            return
        }
        if inFlight { return }
        inFlight = true
        defer { inFlight = false }
        retryTimer?.invalidate()

        let wasConnectedTo: URL? = (state == .connected) ? base : nil
        state = .probing

        // Round one: what the phone remembers, then the discovery document.
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
        guard var url = picked else {
            lastResults = results
            lastProbeAt = Date()
            state = .unreachable("None of the Mac's addresses answered. Is the Console open, and is the Mac awake and online?")
            scheduleRetry()
            return
        }

        // Round two: the Mac's own current list, LAN first. A better address
        // that answers replaces the one round one found.
        if let cfg = await Probe.config(url, token: pairing.token) {
            store.merge(urls: cfg.urls, discovery: cfg.discovery)
            let fresh = cfg.urls.compactMap { URL(string: $0) }
            let (better, r3) = await Probe.pick(fresh)
            results.merge(r3) { $1 }
            if let better { url = better }
        }
        lastResults = results
        lastProbeAt = Date()

        switch await Probe.login(url, token: pairing.token) {
        case .ok:
            if !force, wasConnectedTo == url {
                state = .connected   // same page, same address: leave it alone
            } else {
                base = url
                loadGeneration += 1
                state = .connected
            }
        case .wrongToken:
            state = .rejected("The Mac rejected this phone's token. Re-pair from the phone section of the Console's settings.")
        case .off:
            state = .unreachable("Remote access is switched off in the Console's settings on the Mac (settings, phone).")
            scheduleRetry()
        case .rateLimited:
            state = .unreachable("Too many login attempts from this address. Wait a few minutes and try again.")
            scheduleRetry(after: 120)
        case .unreachable(let why):
            state = .unreachable(why)
            scheduleRetry()
        }
    }

    /// While the Mac is out of reach, look again on a timer: it may be
    /// booting, joining the hotspot, or publishing a new address right now.
    private func scheduleRetry(after seconds: TimeInterval = 15) {
        retryTimer?.invalidate()
        retryTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self, let store = self.store else { return }
                if case .connected = self.state { return }
                await self.connect(store: store, force: false)
            }
        }
    }

    // Reported by the web view.
    func pageFailed(_ message: String) {
        if state == .connected {
            state = .unreachable(message)
            scheduleRetry()
        }
    }

    func pageRejected() {
        state = .rejected("The Console refused this phone's token. Re-pair from the Mac's phone section.")
    }

    func forgetMac() {
        retryTimer?.invalidate()
        state = .idle
        base = nil
        lastResults = [:]
    }
}
