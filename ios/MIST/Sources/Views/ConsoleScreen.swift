import SwiftUI

/// The web view with the connection overlay on top of it.
struct ConsoleScreen: View {
    @EnvironmentObject var store: ServerStore
    @EnvironmentObject var link: ConsoleLink
    @EnvironmentObject var cache: ChatCache

    var body: some View {
        ZStack {
            Color.surface.ignoresSafeArea()
            ConsoleWebView()
                .ignoresSafeArea(.all)
                .opacity(link.state == .connected ? 1 : 0.12)
            overlay
        }
        .task {
            if link.state == .idle {
                await link.connect(store: store, force: true)
            }
        }
    }

    @ViewBuilder
    private var overlay: some View {
        switch link.state {
        case .connected:
            EmptyView()
        case .idle, .probing:
            StatusCard(title: "finding your Mac", message: store.pairing?.name ?? "", spinning: true, actions: [])
        case .unreachable(let why):
            StatusCard(title: "can't reach the Mac", message: why, spinning: false, actions:
                (cache.isEmpty ? [] : [("read cached chats", { link.showReader = true })]) + [
                ("try again", { link.reconnect(store: store) }),
                ("addresses & pairing", { link.showSettings = true }),
            ])
        case .rejected(let why):
            StatusCard(title: "not paired", message: why, spinning: false, actions: [
                ("re-pair", { link.showSettings = true }),
                ("try again", { link.reconnect(store: store) }),
            ])
        }
    }
}

struct StatusCard: View {
    let title: String
    let message: String
    let spinning: Bool
    let actions: [(String, () -> Void)]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                if spinning {
                    ProgressView().tint(.teal)
                }
                Text(title)
                    .font(.system(.headline, design: .monospaced))
                    .foregroundStyle(Color.teal)
            }
            if !message.isEmpty {
                Text(message)
                    .font(.system(.subheadline, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(Array(actions.enumerated()), id: \.offset) { i, action in
                Button(action.0, action: action.1)
                    .buttonStyle(FlatButtonStyle(filled: i == 0))
            }
        }
        .padding(18)
        .frame(maxWidth: 360)
        .background(Color.surfaceLow)
        .overlay(Rectangle().stroke(Color.hairline, lineWidth: 1))
        .padding(24)
    }
}
