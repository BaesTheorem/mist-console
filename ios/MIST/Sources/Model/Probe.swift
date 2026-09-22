import Foundation

enum LoginResult {
    case ok
    case wrongToken
    case off
    case rateLimited
    case unreachable(String)
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
        return (obj["app"] as? String) == "mist-console"
    }

    /// Race every candidate at once; pick the first *by list order* among those
    /// that answered (LAN before the tunnel when both work). Also returns the
    /// per-address outcome for the settings sheet.
    static func pick(_ urls: [URL]) async -> (URL?, [String: Bool]) {
        var results: [String: Bool] = [:]
        await withTaskGroup(of: (Int, Bool).self) { group in
            for (i, u) in urls.enumerated() {
                group.addTask { (i, await ping(u)) }
            }
            for await (i, ok) in group {
                results[urls[i].absoluteString] = ok
            }
        }
        let first = urls.first { results[$0.absoluteString] == true }
        return (first, results)
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
    static func config(_ base: URL, token: String) async -> (urls: [String], discovery: String?)? {
        var req = URLRequest(url: base.appending(path: "remote/config"))
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        guard let (data, resp) = try? await session.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let urls = obj["urls"] as? [String]
        else { return nil }
        return (urls, obj["discovery"] as? String)
    }
}
