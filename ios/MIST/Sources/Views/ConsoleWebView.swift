import SwiftUI
import UIKit
import WebKit

/// The Console page itself. Logs in by loading a form POST to /remote/login
/// (the response sets the mist_remote cookie in this web view's own store and
/// redirects into the app), then stays on the page; every fetch and the event
/// stream carry that cookie from then on.
struct ConsoleWebView: UIViewRepresentable {
    @EnvironmentObject var link: ConsoleLink
    @EnvironmentObject var store: ServerStore

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        // The page reads this suffix and lays itself out for the phone.
        cfg.applicationNameForUserAgent = "MISTShell/1.0"
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.websiteDataStore = .default()
        // The page posts {type:"stream", state:"up"|"down"} here when its event
        // stream drops or returns (shellStream in app.js), and {type:"ready"}
        // once it has booted (sessions loaded, UI usable).
        cfg.userContentController.add(context.coordinator, name: "mist")
        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.navigationDelegate = context.coordinator
        wv.uiDelegate = context.coordinator
        wv.isOpaque = false
        wv.backgroundColor = UIColor(red: 0x09 / 255, green: 0x14 / 255, blue: 0x20 / 255, alpha: 1)
        wv.scrollView.backgroundColor = wv.backgroundColor
        // Edge to edge; the page pads with env(safe-area-inset-*) itself.
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        // The page never scrolls as a whole (the transcript is its own
        // scroller), so the document must not rubber-band.
        wv.scrollView.bounces = false
        wv.allowsBackForwardNavigationGestures = false
        wv.allowsLinkPreview = false
        context.coordinator.webView = wv
        context.coordinator.observeForeground()
        return wv
    }

    func updateUIView(_ wv: WKWebView, context: Context) {
        let c = context.coordinator
        c.link = link
        c.flushPendingScript()
        guard let base = link.base, let token = store.pairing?.token else { return }
        guard c.loadedGeneration != link.loadGeneration else { return }
        c.loadedGeneration = link.loadGeneration
        c.baseHost = base.host
        var req = URLRequest(url: base.appending(path: "remote/login"))
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        let tok = token.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? token
        req.httpBody = "token=\(tok)&next=%2F".data(using: .utf8)
        c.load(req)
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        weak var webView: WKWebView?
        var link: ConsoleLink?
        var loadedGeneration = -1
        var baseHost: String?
        /// True once the page posted {type:"ready"} (or, for a page too old to
        /// post it, the fallback below fired). False from the moment a load
        /// is issued until then.
        var pageLoaded = false
        /// Bumped per load, so a stash that finishes after a newer load was
        /// asked for does not load the older request on top of it.
        private var loadSeq = 0
        /// Status of the last main-frame response, for the didFinish fallback.
        private var lastStatus = 0
        private var readyFallback: DispatchWorkItem?
        private var foreground: NSObjectProtocol?

        deinit {
            if let foreground { NotificationCenter.default.removeObserver(foreground) }
        }

        /// Back from the background with no document (the system reclaimed
        /// the page while the app slept): load it again.
        func observeForeground() {
            guard foreground == nil else { return }
            foreground = NotificationCenter.default.addObserver(
                forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
            ) { [weak self] _ in
                guard let self, let wv = self.webView, wv.url == nil, self.loadedGeneration >= 0 else { return }
                self.pageGone()
            }
        }

        /// Issue a load. Before replacing a live page, ask it to stash the
        /// composer draft and the open chat (window.mistStashDraft in app.js),
        /// waiting at most half a second, so the next boot restores them.
        func load(_ req: URLRequest) {
            guard let wv = webView else { return }
            loadSeq += 1
            let seq = loadSeq
            let hadPage = wv.url != nil
            setLoaded(false)
            guard hadPage else { wv.load(req); return }
            var fired = false
            let go: () -> Void = { [weak self, weak wv] in
                guard !fired else { return }
                fired = true
                guard let self, let wv, seq == self.loadSeq else { return }
                wv.load(req)
            }
            wv.evaluateJavaScript("window.mistStashDraft && window.mistStashDraft('reconnect')") { _, _ in go() }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: go)
        }

        private func setLoaded(_ loaded: Bool) {
            pageLoaded = loaded
            if !loaded { readyFallback?.cancel(); readyFallback = nil }
            let link = self.link
            Task { @MainActor in
                link?.pageAlive = loaded
                if loaded { self.flushPendingScript() }
            }
        }

        /// The page is gone (content process killed, or no document after a
        /// background stretch): mark it and have the link load it again.
        private func pageGone() {
            setLoaded(false)
            let link = self.link
            Task { @MainActor in link?.reloadPage() }
        }

        /// Run the script a deep link queued, once the page has booted and the
        /// link is connected (not on a page about to be replaced).
        @MainActor
        func flushPendingScript() {
            guard pageLoaded, let link, link.state == .connected,
                  let js = link.pendingScript, let wv = webView else { return }
            link.pendingScript = nil
            wv.evaluateJavaScript(js) { _, _ in }
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            setLoaded(false)
        }

        /// "ready" from the page is the real signal. A page served by an older
        /// Console never posts it, so a finished 200 load that stays silent
        /// for 5 s counts as ready too. A login page (401/403) never does.
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard !pageLoaded, lastStatus == 200 else { return }
            readyFallback?.cancel()
            let item = DispatchWorkItem { [weak self] in
                guard let self, !self.pageLoaded, self.lastStatus == 200 else { return }
                self.setLoaded(true)
            }
            readyFallback = item
            DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: item)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            pageGone()
        }

        func userContentController(_ userContentController: WKUserContentController,
                                   didReceive message: WKScriptMessage) {
            guard message.name == "mist", let body = message.body as? [String: Any] else { return }
            switch body["type"] as? String {
            case "ready":
                setLoaded(true)
            case "stream":
                guard let state = body["state"] as? String else { return }
                let link = self.link
                Task { @MainActor in link?.streamChanged(up: state == "up") }
            case "save":
                // A "save" on the page (an image's corner button, the lightbox,
                // the artifacts drawer): fetch the file from the Mac and hand it
                // to the share sheet, so it lands on the phone (Photos, Files,
                // AirDrop) instead of in the Mac's Downloads folder.
                guard let path = body["url"] as? String, let wv = webView,
                      let base = link?.base else { return }
                let name = (body["name"] as? String) ?? ""
                Task { @MainActor in
                    await ArtifactSaver.save(path: path, name: name, base: base, over: wv)
                }
            default:
                return
            }
        }

        // mist: links are the page talking to the shell; foreign links go to Safari.
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else { decisionHandler(.allow); return }
            if url.scheme?.lowercased() == "mist" {
                // Same router as links from outside (MISTApp.handle). A pairing
                // link inside the page is ignored: re-pairing is the settings
                // sheet's job, never the page's.
                let link = self.link
                Task { @MainActor in link?.handle(mistURL: url) }
                decisionHandler(.cancel)
                return
            }
            if navigationAction.navigationType == .linkActivated,
               let host = url.host, host != baseHost,
               ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                Task { @MainActor in UIApplication.shared.open(url) }
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                     decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            if navigationResponse.isForMainFrame, let http = navigationResponse.response as? HTTPURLResponse {
                lastStatus = http.statusCode
                if http.statusCode == 401 || http.statusCode == 403 {
                    let link = self.link
                    Task { @MainActor in link?.pageRejected() }
                }
            }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            setLoaded(false)
            report(error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            report(error)
        }

        private func report(_ error: Error) {
            let ns = error as NSError
            if ns.code == NSURLErrorCancelled { return }
            let link = self.link
            let text = ns.localizedDescription
            Task { @MainActor in link?.pageFailed(text) }
        }

        // target=_blank: there is no second window here, hand it to Safari.
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = navigationAction.request.url {
                Task { @MainActor in UIApplication.shared.open(url) }
            }
            return nil
        }

        // The page uses confirm() and prompt() in a few places; a WKWebView
        // shows nothing for them unless its UI delegate does.
        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            Task { @MainActor in
                let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
                a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
                Self.present(a, over: webView) ?? completionHandler()
            }
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            Task { @MainActor in
                let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
                a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
                a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
                Self.present(a, over: webView) ?? completionHandler(false)
            }
        }

        func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                     defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                     completionHandler: @escaping (String?) -> Void) {
            Task { @MainActor in
                let a = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
                a.addTextField { $0.text = defaultText }
                a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
                a.addAction(UIAlertAction(title: "OK", style: .default) { _ in
                    completionHandler(a.textFields?.first?.text)
                })
                Self.present(a, over: webView) ?? completionHandler(nil)
            }
        }

        /// Present over whatever is frontmost. Returns nil when nothing can
        /// present, so callers still complete the JS callback.
        @MainActor
        @discardableResult
        private static func present(_ alert: UIAlertController, over view: UIView) -> Void? {
            var vc = view.window?.rootViewController
            while let next = vc?.presentedViewController { vc = next }
            guard let host = vc else { return nil }
            host.present(alert, animated: true)
            return ()
        }
    }
}
