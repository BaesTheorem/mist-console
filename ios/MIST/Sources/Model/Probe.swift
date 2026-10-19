import Foundation

enum LoginResult {
    case ok
    case wrongToken
    case off
    case rateLimited
    case unreachable(String)
}

/// What /remote/config said. `unauthorized` is the Mac refusing the token
/// (it was rotated): the caller must show the re-pair card, not stay quiet.
enum ConfigResult {
    case ok(urls: [String], discovery: String?)
    case unauthorized
    case failed
}

/// The few requests the shell makes on its own, outside the web view: find the
/// Mac, check the token, learn new addresses. The web view owns the cookie;
/// these carry the token as a bearer where they need it.
enum Probe {
    private static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 4
        c.timeoutIntervalForResource = 6
        c.waitsForConnectivity = false
        c.httpCookieAcceptPolicy = .never
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: c)
    }()

    /// GET /remote/ping: is a MIST Console answering at this base?
    static func ping(_ base: URL, timeout: TimeInterval = 4) async -> Bool {
        var req = URLRequest(url: base.appending(path: "remote/ping"))
        req.timeoutInterval = timeout
        guard let (data, resp) = try? await session.data(for: req),
              let http = resp as? HTTPURLResponse, http.statusCode == 200,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return false }
        // The exact shape app.py's remote_ping returns. The ping is public and
        // carries nothing secret, so this only keeps the token away from a
        // server that is plainly something else; it is not proof of identity.
        return (obj["app"] as? String) == "mist-console"
            && (obj["ok"] as? Bool) == true
            && obj["name"] is String
    }

    /// Race every candidate at once; pick the first *by list order* among those
    /// that answered (LAN before the tunnel when both work). Returns as soon as
    /// an answering candidate has no higher-ranked one still pending, and
    /// cancels the rest, so a dead LAN address after a live one costs nothing.
    /// Candidates this network cannot reach (LocalNet.plausible) are not
    /// pinged at all. Also returns the per-address outcome for the settings
    /// sheet; a cancelled candidate has no entry.
    static func pick(_ urls: [URL]) async -> (URL?, [String: Bool]) {
        var results: [String: Bool] = [:]
        let nets = LocalNet.current()
        var done = [Bool?](repeating: nil, count: urls.count)
        var best: URL?
        await withTaskGroup(of: (Int, Bool).self) { group in
            for (i, u) in urls.enumerated() {
                if LocalNet.plausible(u, nets: nets) {
                    group.addTask { (i, await ping(u)) }
                } else {
                    done[i] = false
                    results[u.absoluteString] = false
                }
            }
            func settled() -> URL? {
                for (i, d) in done.enumerated() {
                    guard let d else { return nil }   // a better one is still out
                    if d { return urls[i] }
                }
                return nil
            }
            if let b = settled() { best = b; group.cancelAll(); return }
            for await (i, ok) in group {
                done[i] = ok
                results[urls[i].absoluteString] = ok
                if let b = settled() {
                    best = b
                    group.cancelAll()
                    break
                }
            }
        }
        return (best, results)
    }

    /// The discovery document the Mac publishes: {"urls": [...]}.
    static func discover(_ discovery: URL) async -> [String] {
        let req = URLRequest(url: discovery)
        guard let (data, resp) = try? await session.data(for: req),
              let http = resp as? HTTPURLResponse, http.statusCode == 200,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let urls = obj["urls"] as? [String]
        else { return [] }
        return urls
    }

    /// POST /remote/login as JSON: validates the token without touching the
    /// web view's cookie jar (that login happens as a form post in the page).
    static func login(_ base: URL, token: String) async -> LoginResult {
        var req = URLRequest(url: base.appending(path: "remote/login"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["token": token])
        do {
            let (data, resp) = try await session.data(for: req)
            guard let http = resp as? HTTPURLResponse else { return .unreachable("no response") }
            let err = ((try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String) ?? ""
            switch http.statusCode {
            case 200: return .ok
            case 429: return .rateLimited
            case 403: return err.contains("off") ? .off : .wrongToken
            default: return .unreachable("the Console answered \(http.statusCode)")
            }
        } catch {
            return .unreachable(error.localizedDescription)
        }
    }

    /// GET /remote/config with the bearer: the Mac's current address list.
    /// A 401 is the Mac refusing this token, kept apart from a plain failure.
    static func config(_ base: URL, token: String) async -> ConfigResult {
        var req = URLRequest(url: base.appending(path: "remote/config"))
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        guard let (data, resp) = try? await session.data(for: req),
              let http = resp as? HTTPURLResponse else { return .failed }
        if http.statusCode == 401 { return .unauthorized }
        guard http.statusCode == 200,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let urls = obj["urls"] as? [String]
        else { return .failed }
        return .ok(urls: urls, discovery: obj["discovery"] as? String)
    }
}
