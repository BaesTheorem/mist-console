import Foundation
import UIKit

/// Saving on the phone. The page's "save" button asks the Mac to copy a file
/// into the Mac's Downloads folder; on the phone that would land the file on
/// the wrong device. The page instead posts {type:"save", url, name} to the
/// shell (shellSave in app.js), and this downloads the file over the same
/// pairing token the shell already holds, then opens the share sheet: Save
/// Image, Save to Files, AirDrop, or any app that takes the type.
enum ArtifactSaver {
    private static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 30
        c.timeoutIntervalForResource = 300
        c.httpCookieAcceptPolicy = .never
        return URLSession(configuration: c)
    }()

    @MainActor
    static func save(path: String, name: String, base: URL, over view: UIView) async {
        // `path` is the page's own /file?path=...&at=... URL, relative to its origin.
        guard var comps = URLComponents(url: base, resolvingAgainstBaseURL: false),
              let rel = URL(string: path, relativeTo: base) else { return }
        comps.path = rel.path
        comps.query = rel.query
        var items = comps.queryItems ?? []
        items.removeAll { $0.name == "download" }
        items.append(URLQueryItem(name: "download", value: "1"))
        comps.queryItems = items
        guard let url = comps.url else { return }
        var req = URLRequest(url: url)
        if let token = ServerStore.currentToken() {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let fileName = name.isEmpty ? (url.lastPathComponent.isEmpty ? "artifact" : url.lastPathComponent) : name
        do {
            let (tmp, resp) = try await session.download(for: req)
            guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
                try? FileManager.default.removeItem(at: tmp)
                return
            }
            // Give it its real name: the share sheet and Files show the file name,
            // and Photos decides "Save Image" by the extension.
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("mist-artifacts", isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let dest = dir.appendingPathComponent(fileName)
            try? FileManager.default.removeItem(at: dest)
            try FileManager.default.moveItem(at: tmp, to: dest)
            present(file: dest, over: view)
        } catch {
            return
        }
    }

    @MainActor
    private static func present(file: URL, over view: UIView) {
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        var vc = view.window?.rootViewController
        while let next = vc?.presentedViewController { vc = next }
        guard let host = vc else { return }
        if let pop = sheet.popoverPresentationController {   // iPad anchors the sheet
            pop.sourceView = view
            pop.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.maxY - 80, width: 1, height: 1)
        }
        host.present(sheet, animated: true)
    }
}
