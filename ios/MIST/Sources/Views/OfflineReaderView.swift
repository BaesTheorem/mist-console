import SwiftUI

/// Read-only view of the cached chats, for when the Mac is out of reach.
struct OfflineReaderView: View {
    @EnvironmentObject var cache: ChatCache
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var filtered: [CachedChat] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let list = cache.chats.filter { $0.syncedActivity >= 0 }
        return q.isEmpty ? list : list.filter { $0.title.lowercased().contains(q) }
    }

    var body: some View {
        NavigationStack {
            List {
                if cache.chats.isEmpty {
                    Text("Nothing cached yet. Chats copy to the phone whenever the app is connected to the Mac.")
                        .foregroundStyle(.secondary)
                }
                ForEach(filtered) { c in
                    NavigationLink {
                        TranscriptView(chat: c)
                    } label: {
                        HStack(spacing: 8) {
                            if c.pinned { Image(systemName: "pin.fill").font(.caption2).foregroundStyle(Color.teal) }
                            VStack(alignment: .leading, spacing: 2) {
                                Text(c.title).font(.system(.body, design: .monospaced)).lineLimit(2)
                                Text(Date(timeIntervalSince1970: c.lastActivity).formatted(date: .abbreviated, time: .shortened))
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            .searchable(text: $query, prompt: "Search titles")
            .scrollContentBackground(.hidden)
            .background(Color.surface)
            .navigationTitle("cached chats")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("done") { dismiss() } }
            }
            .overlay(alignment: .bottom) {
                if cache.syncing {
                    Text(cache.pending > 0 ? "syncing, \(cache.pending) to go" : "syncing")
                        .font(.caption).foregroundStyle(.secondary).padding(8)
                        .background(Color.surfaceLow).overlay(Rectangle().stroke(Color.hairline))
                        .padding(.bottom, 8)
                }
            }
        }
        .preferredColorScheme(.dark)
    }
}

struct TranscriptView: View {
    @EnvironmentObject var cache: ChatCache
    let chat: CachedChat
    @State private var doc: CachedTranscript?

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if let doc {
                        ForEach(doc.messages) { m in
                            MessageRow(message: m).id(m.id)
                        }
                    } else {
                        Text("No copy of this chat on the phone yet.").foregroundStyle(.secondary)
                    }
                }
                .padding(14)
            }
            .onAppear {
                doc = cache.transcript(for: chat.id)
                if let last = doc?.messages.last { proxy.scrollTo(last.id, anchor: .bottom) }
            }
        }
        .background(Color.surface)
        .navigationTitle(chat.title)
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct MessageRow: View {
    let message: CachedMessage

    private var rendered: AttributedString {
        (try? AttributedString(markdown: message.text,
                               options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(message.text)
    }

    var body: some View {
        switch message.role {
        case "user":
            VStack(alignment: .leading, spacing: 4) {
                Text("ALEX").font(.system(size: 11, design: .monospaced).weight(.bold))
                Text(message.text)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.surfaceLow)
                    .overlay(Rectangle().frame(width: 2).foregroundStyle(Color.white.opacity(0.5)), alignment: .leading)
            }
        case "tool":
            Text(message.text)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(2)
        default:
            VStack(alignment: .leading, spacing: 4) {
                Text("MIST").font(.system(size: 11, design: .monospaced).weight(.bold)).foregroundStyle(Color.teal)
                Text(rendered)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}
