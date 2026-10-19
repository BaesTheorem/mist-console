import Combine
import Foundation

/// The one Mac this phone is paired with. Name and addresses in UserDefaults,
/// the token in the Keychain.
@MainActor
final class ServerStore: ObservableObject {
    @Published private(set) var pairing: Pairing?
    @Published private(set) var pairedAt: Date?
    /// Addresses Alex typed in himself. Never evicted by merge; only a swipe
    /// in settings removes one.
    @Published private(set) var pinned: Set<String> = []
    /// When each address last answered a ping. Decides which phone-only
    /// addresses merge keeps (live ones) and when one is stale enough to drop.
    private var lastOK: [String: Date] = [:]

    /// The two optional fields arrived after the first release; an old record
    /// decodes with them nil.
    private struct Stored: Codable {
        var name: String
        var urls: [String]
        var discovery: String?
        var since: Date
        var pinned: [String]?
        var lastOK: [String: Date]?
    }

    /// How many machine-learned addresses only this phone remembers are kept,
    /// and how long one may go without answering before it is dropped.
    private static let maxExtras = 6
    private static let staleAfter: TimeInterval = 14 * 24 * 3600

    private let key = "pairing.v1"
    private let tokenKey = "pairing-token"

    init() { load() }

    /// The pairing token for code outside the SwiftUI tree (ArtifactSaver's
    /// download). Same Keychain item the store reads on launch.
    nonisolated static func currentToken() -> String? { Keychain.get("pairing-token") }

    private func load() {
        guard let data = UserDefaults.standard.data(forKey: key),
              let s = try? JSONDecoder().decode(Stored.self, from: data),
              let token = Keychain.get(tokenKey)
        else { pairing = nil; return }
        pairing = Pairing(name: s.name, urls: s.urls, token: token, discovery: s.discovery)
        pairedAt = s.since
        pinned = Set(s.pinned ?? [])
        // An address from an older record has no history yet: it starts its
        // stale clock now instead of being dropped on the first merge.
        let now = Date()
        lastOK = s.lastOK ?? [:]
        for u in s.urls where lastOK[u] == nil { lastOK[u] = now }
    }

    private func persist() {
        guard let p = pairing else {
            UserDefaults.standard.removeObject(forKey: key)
            Keychain.delete(tokenKey)
            return
        }
        let s = Stored(name: p.name, urls: p.urls, discovery: p.discovery, since: pairedAt ?? Date(),
                       pinned: Array(pinned).sorted(),
                       lastOK: lastOK.filter { p.urls.contains($0.key) })
        if let data = try? JSONEncoder().encode(s) {
            UserDefaults.standard.set(data, forKey: key)
        }
        Keychain.set(p.token, for: tokenKey)
    }

    func apply(_ p: Pairing) {
        // A new pairing keeps the addresses Alex added by hand for the same
        // Mac name; everything else comes from the code.
        let keep = pairing?.name == p.name ? pinned : []
        var q = p
        for u in keep where !q.urls.contains(u) { q.urls.append(u) }
        pairing = q
        pinned = keep
        pairedAt = Date()
        let now = Date()
        lastOK = [:]
        for u in q.urls { lastOK[u] = now }
        persist()
    }

    func forget() {
        pairing = nil
        pairedAt = nil
        pinned = []
        lastOK = [:]
        persist()
    }

    /// Record which addresses answered a ping (ConsoleLink, after each probe).
    func noteAnswered(_ urls: [String]) {
        guard let p = pairing else { return }
        let now = Date()
        var changed = false
        for u in urls where p.urls.contains(u) {
            lastOK[u] = now
            changed = true
        }
        if changed { persist() }
    }

    /// Fold in addresses learned from the Mac (/remote/config) or the discovery
    /// lookup. The Mac's order wins for what it knows (LAN first); anything only
    /// this phone knows stays at the end.
    func merge(urls: [String], discovery: String?) {
        guard var p = pairing else { return }
        var seen = Set<String>()
        var out: [String] = []
        for u in urls where !u.isEmpty && !seen.contains(u) {
            seen.insert(u)
            out.append(u)
        }
        // Addresses only this phone remembers trail the Mac's list. Pinned
        // ones (typed in by Alex) always stay. Machine-learned ones (old
        // networks, old tunnels) are dropped once they have not answered for
        // two weeks, and the rest are capped, keeping the ones that answered
        // most recently, so the candidate set does not grow with every
        // network the Mac has ever joined.
        let now = Date()
        let learned = p.urls.filter { !$0.isEmpty && !seen.contains($0) && !pinned.contains($0) }
        let keep = Set(learned
            .filter { now.timeIntervalSince(lastOK[$0] ?? now) < Self.staleAfter }
            .sorted { (lastOK[$0] ?? .distantPast) > (lastOK[$1] ?? .distantPast) }
            .prefix(Self.maxExtras))
        for u in p.urls where !u.isEmpty && !seen.contains(u) && (pinned.contains(u) || keep.contains(u)) {
            seen.insert(u)
            out.append(u)
        }
        for u in out where lastOK[u] == nil { lastOK[u] = now }
        var changed = out != p.urls
        p.urls = out
        if let d = discovery, !d.isEmpty, d != p.discovery {
            p.discovery = d
            changed = true
        }
        if changed {
            pairing = p
            persist()
        }
    }

    func add(url: String) {
        let u = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var p = pairing, !u.isEmpty else { return }
        if !p.urls.contains(u) { p.urls.append(u) }
        pinned.insert(u)
        lastOK[u] = lastOK[u] ?? Date()
        pairing = p
        persist()
    }

    func remove(url: String) {
        guard var p = pairing else { return }
        p.urls.removeAll { $0 == url }
        pinned.remove(url)
        lastOK[url] = nil
        pairing = p
        persist()
    }
}
