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
        // stream drops or returns (shellStream in app.js).
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
        wv.load(req)
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        weak var webView: WKWebView?
        var link: ConsoleLink?
        var loadedGeneration = -1
        var baseHost: String?
        var pageLoaded = false

        /// Run the script a deep link queued, once the page is really there.
        func flushPendingScript() {
            guard pageLoaded, let link, let js = link.pendingScript, let wv = webView else { return }
            link.pendingScript = nil
            // Give the page a beat to finish its own boot (sessions load async).
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                wv.evaluateJavaScript(js) { _, _ in }
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            pageLoaded = true
            let link = self.link
            Task { @MainActor in
                _ = link   // keep the reference alive across the hop
                self.flushPendingScript()
            }
        }

        func userContentController(_ userContentController: WKUserContentController,
                                   didReceive message: WKScriptMessage) {
            guard message.name == "mist",
                  let body = message.body as? [String: Any],
                  body["type"] as? String == "stream",
                  let state = body["state"] as? String else { return }
            let link = self.link
            Task { @MainActor in link?.streamChanged(up: state == "up") }
        }

        // mist: links are the page talking to the shell; foreign links go to Safari.
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else { decisionHandler(.allow); return }
            if url.scheme?.lowercased() == "mist" {
                if url.host?.lowercased() == "settings" {
                    let link = self.link
                    Task { @MainActor in link?.showSettings = true }
                }
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
            if navigationResponse.isForMainFrame,
               let http = navigationResponse.response as? HTTPURLResponse,
               http.statusCode == 401 || http.statusCode == 403 {
                let link = self.link
                Task { @MainActor in link?.pageRejected() }
            }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            pageLoaded = false
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
