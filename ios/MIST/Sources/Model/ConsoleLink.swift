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
    /// JavaScript the web view runs once the page has booted (it posts
    /// {type:"ready"}) and the link is connected: a widget deep link asking
    /// for a new chat, for instance. Cleared once run.
    @Published var pendingScript: String?
    @Published var showReader = false
    /// The offline copy of every chat; refreshed after each successful connect.
    weak var cache: ChatCache?
    /// Set by the web view: the page posted "ready" and its content process is
    /// still alive. False from the moment a load starts.
    var pageAlive = false
    /// The address and token the page was last loaded with. A connect that
    /// lands on the same pair while the page is alive does not reload it.
    private var loadedWith: (url: URL, token: String)?

    private var inFlight = false
    /// Bumped by every connect that runs. A connect checks it after each
    /// await and stops when a newer one (a forced reconnect after a re-pair,
    /// a forget) has started, so a stale token's result never lands.
    private var connectGen = 0
    /// The address that worked last time, tried alone first: on a warm start
    /// that is one round trip, not a race with a timeout in it.
    private var lastGood: URL? {
        get { UserDefaults.standard.string(forKey: "lastGoodBase").flatMap(URL.init(string:)) }
        set { UserDefaults.standard.set(newValue?.absoluteString, forKey: "lastGoodBase") }
    }
    private static func isTunnel(_ u: URL) -> Bool { (u.host ?? "").hasSuffix("trycloudflare.com") }
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

    /// The mist: links, from the page (in-page links) and from outside (the
    /// widget, the icon's menu, onOpenURL) alike. Pairing links are handled by
    /// MISTApp, which asks first. Returns false for anything unknown.
    @discardableResult
    func handle(mistURL url: URL) -> Bool {
        switch url.host?.lowercased() {
        case "settings":
            showSettings = true
        case "offline":
            // From the drawer's "Offline" button in the page.
            showReader = true
        case "new":
            // From the "New chat" widget or the icon's menu: a fresh chat as soon as the page is up.
            pendingScript = "if (typeof createSession === 'function') createSession();"
        default:
            return false
        }
        return true
    }

    /// Load the page again at the current address (its web content process
    /// died, or it came back from the background with no document).
    func reloadPage() {
        guard base != nil else { return }
        pageAlive = false
        loadGeneration += 1
    }

    // MARK: - the connect

    func connect(store: ServerStore, force: Bool) async {
        self.store = store
        guard let pairing = store.pairing else {
            connectGen += 1
            inFlight = false
            state = .idle
            base = nil
            return
        }
        // A forced connect (re-pair, "try again") supersedes one in flight;
        // a background re-check just yields to it.
        if inFlight && !force { return }
        connectGen += 1
        let gen = connectGen
        inFlight = true
        defer { if gen == connectGen { inFlight = false } }
        retryTimer?.invalidate()
        func stale() -> Bool { gen != connectGen }

        let wasConnectedTo: URL? = (state == .connected) ? base : nil
        // Already on the page and just re-checking (foreground, a path change):
        // stay connected and look quietly. The overlay is for a real outage.
        let quiet = wasConnectedTo != nil && !force
        if !quiet { state = .probing }

        // Fast path: the address that worked last time, alone, short timeout.
        var picked: URL? = nil
        var results: [String: Bool] = [:]
        if let last = wasConnectedTo ?? lastGood,
           LocalNet.plausible(last, nets: LocalNet.current()),
           await Probe.ping(last, timeout: 1.5) {
            picked = last
            results[last.absoluteString] = true
        }
        if stale() { return }
        // Round one: what the phone remembers, then the discovery document.
        let candidates = pairing.urls.compactMap { URL(string: $0) }
        if picked == nil {
            let (p1, r1) = await Probe.pick(candidates)
            if stale() { return }
            picked = p1
            results = r1
        }
        if picked == nil, let d = pairing.discovery, let du = URL(string: d) {
            let extra = await Probe.discover(du).filter { !pairing.urls.contains($0) }
            if stale() { return }
            if !extra.isEmpty {
                store.merge(urls: extra, discovery: nil)
                let (p2, r2) = await Probe.pick(extra.compactMap { URL(string: $0) })
                if stale() { return }
                picked = p2
                results.merge(r2) { $1 }
            }
        }
        guard var url = picked else {
            store.noteAnswered(results.filter { $0.value }.map { $0.key })
            lastResults = results
            lastProbeAt = Date()
            state = .unreachable("None of the Mac's addresses answered. Is the Console open, and is the Mac awake and online?")
            scheduleRetry()
            return
        }

        // Round two: the Mac's own current list, LAN first. A better address
        // that answers replaces the one round one found. On a quiet re-check
        // only a direct address replacing the tunnel is worth a reload.
        // The config call carries the token, so a 401 here is the first sign
        // that the Mac rotated it: show the re-pair card even on a quiet check.
        let cfg = await Probe.config(url, token: pairing.token)
        if stale() { return }
        var configOK = false
        switch cfg {
        case .ok(let urls, let discovery):
            configOK = true
            store.merge(urls: urls, discovery: discovery)
            let fresh = urls.compactMap { URL(string: $0) }
            let (better, r3) = await Probe.pick(fresh)
            if stale() { return }
            results.merge(r3) { $1 }
            if let better, better != url {
                if !quiet || (Self.isTunnel(url) && !Self.isTunnel(better)) { url = better }
            }
        case .unauthorized:
            store.noteAnswered(results.filter { $0.value }.map { $0.key })
            lastResults = results
            lastProbeAt = Date()
            state = .rejected("The Mac rejected this phone's token. Re-pair from the phone section of the Console's settings.")
            return
        case .failed:
            break   // the login below says why (remote off, unreachable)
        }
        store.noteAnswered(results.filter { $0.value }.map { $0.key })
        lastResults = results
        lastProbeAt = Date()

        if quiet, configOK, wasConnectedTo == url {
            lastGood = url
            cache?.sync(base: url, token: pairing.token)   // keep the offline copy current
            return   // nothing to do: same address, still answering
        }
        let login = await Probe.login(url, token: pairing.token)
        if stale() { return }
        switch login {
        case .ok:
            lastGood = url
            // The page already on this address with this token, alive and
            // streaming, stays as it is: a reload would only cost a boot.
            let same = loadedWith.map { $0.url == url && $0.token == pairing.token } ?? false
            if same, base == url, pageAlive, !streamDown {
                state = .connected
            } else {
                base = url
                loadedWith = (url, pairing.token)
                pageAlive = false
                loadGeneration += 1
                state = .connected
            }
            cache?.sync(base: url, token: pairing.token)   // keep the offline copy current
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
        connectGen += 1   // a connect still running drops its result
        inFlight = false
        retryTimer?.invalidate()
        streamTimer?.invalidate()
        lastGood = nil
        loadedWith = nil
        pageAlive = false
        pendingScript = nil
        cache?.cancel()
        state = .idle
        base = nil
        lastResults = [:]
    }
}
