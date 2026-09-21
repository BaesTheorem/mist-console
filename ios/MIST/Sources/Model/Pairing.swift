import Foundation

/// What the Console's pairing QR / link carries: `mist://pair?d=<base64url JSON>`
/// with `urls` (LAN first, then whatever reaches the Mac from outside), the
/// pairing `token`, and an optional `discovery` URL the phone can read when
/// none of the addresses answer (the Mac publishes its current off-LAN
/// addresses there).
struct Pairing: Codable, Equatable {
    var name: String
    var urls: [String]
    var token: String
    var discovery: String?

    private struct Wire: Codable {
        var v: Int?
        var name: String?
        var urls: [String]?
        var token: String?
        var discovery: String?
    }

    static func parse(url: URL) -> Pairing? {
        guard url.scheme?.lowercased() == "mist",
              url.host?.lowercased() == "pair",
              let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let d = comps.queryItems?.first(where: { $0.name == "d" })?.value,
              let data = Data(base64url: d),
              let wire = try? JSONDecoder().decode(Wire.self, from: data),
              let token = wire.token, !token.isEmpty,
              let urls = wire.urls, !urls.isEmpty
        else { return nil }
        return Pairing(name: wire.name ?? "MIST Console", urls: urls, token: token,
                       discovery: wire.discovery)
    }

    /// A pasted or scanned string, possibly with whitespace or text around it.
    static func parse(text: String) -> Pairing? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let url = URL(string: trimmed), let p = parse(url: url) { return p }
        if let range = trimmed.range(of: #"mist://pair\?d=[A-Za-z0-9_\-=]+"#, options: .regularExpression),
           let url = URL(string: String(trimmed[range])) {
            return parse(url: url)
        }
        return nil
    }
}

extension Data {
    init?(base64url: String) {
        var s = base64url
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while s.count % 4 != 0 { s += "=" }
        self.init(base64Encoded: s)
    }
}
