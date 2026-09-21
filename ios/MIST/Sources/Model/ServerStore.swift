import Combine
import Foundation

/// The one Mac this phone is paired with. Name and addresses in UserDefaults,
/// the token in the Keychain.
@MainActor
final class ServerStore: ObservableObject {
    @Published private(set) var pairing: Pairing?
    @Published private(set) var pairedAt: Date?

    private struct Stored: Codable {
        var name: String
        var urls: [String]
        var discovery: String?
        var since: Date
    }

    private let key = "pairing.v1"
    private let tokenKey = "pairing-token"

    init() { load() }

    private func load() {
        guard let data = UserDefaults.standard.data(forKey: key),
              let s = try? JSONDecoder().decode(Stored.self, from: data),
              let token = Keychain.get(tokenKey)
        else { pairing = nil; return }
        pairing = Pairing(name: s.name, urls: s.urls, token: token, discovery: s.discovery)
        pairedAt = s.since
    }

    private func persist() {
        guard let p = pairing else {
            UserDefaults.standard.removeObject(forKey: key)
            Keychain.delete(tokenKey)
            return
        }
        let s = Stored(name: p.name, urls: p.urls, discovery: p.discovery, since: pairedAt ?? Date())
        if let data = try? JSONEncoder().encode(s) {
            UserDefaults.standard.set(data, forKey: key)
        }
        Keychain.set(p.token, for: tokenKey)
    }

    func apply(_ p: Pairing) {
        pairing = p
        pairedAt = Date()
        persist()
    }

    func forget() {
        pairing = nil
        pairedAt = nil
        persist()
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
        // Addresses only this phone remembers (old networks, old tunnels) trail
        // the Mac's list and are capped, so the candidate set does not grow
        // with every network the Mac has ever joined.
        var extras = 0
        for u in p.urls where !u.isEmpty && !seen.contains(u) && extras < 6 {
            seen.insert(u)
            out.append(u)
            extras += 1
        }
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
        guard var p = pairing, !u.isEmpty, !p.urls.contains(u) else { return }
        p.urls.append(u)
        pairing = p
        persist()
    }

    func remove(url: String) {
        guard var p = pairing else { return }
        p.urls.removeAll { $0 == url }
        pairing = p
        persist()
    }
}
