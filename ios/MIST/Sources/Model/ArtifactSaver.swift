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
              let rel = URL(string: path, relativeTo: base) else {
            fail("That file's address didn't make sense.", over: view)
            return
        }
        // rel's path and query arrive already percent-encoded from the page;
        // set them as such, or %2F becomes %252F and the Mac answers 404.
        comps.percentEncodedPath = rel.path(percentEncoded: true)
        comps.percentEncodedQuery = rel.query(percentEncoded: true)
        // Stay on the encoded items: a decode and re-encode round trip would
        // leave a "+" in a file name bare, and the Mac reads that as a space.
        var items = comps.percentEncodedQueryItems ?? []
        items.removeAll { $0.name == "download" }
        items.append(URLQueryItem(name: "download", value: "1"))
        comps.percentEncodedQueryItems = items
        guard let url = comps.url else {
            fail("That file's address didn't make sense.", over: view)
            return
        }
        var req = URLRequest(url: url)
        if let token = ServerStore.currentToken() {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let fileName = name.isEmpty ? (url.lastPathComponent.isEmpty ? "artifact" : url.lastPathComponent) : name
        do {
            let (tmp, resp) = try await session.download(for: req)
            guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
                try? FileManager.default.removeItem(at: tmp)
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                fail(code == 404 ? "The Mac no longer has that file." : "The Mac answered \(code) for that file.",
                     over: view)
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
            fail(error.localizedDescription, over: view)
        }
    }

    /// Say why a save did not happen, instead of the button doing nothing.
    @MainActor
    private static func fail(_ message: String, over view: UIView) {
        let a = UIAlertController(title: "Couldn't save the file", message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default))
        topController(for: view)?.present(a, animated: true)
    }

    @MainActor
    private static func topController(for view: UIView) -> UIViewController? {
        var vc = view.window?.rootViewController
        while let next = vc?.presentedViewController { vc = next }
        return vc
    }

    @MainActor
    private static func present(file: URL, over view: UIView) {
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        guard let host = topController(for: view) else { return }
        if let pop = sheet.popoverPresentationController {   // iPad anchors the sheet
            pop.sourceView = view
            pop.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.maxY - 80, width: 1, height: 1)
        }
        host.present(sheet, animated: true)
    }
}
