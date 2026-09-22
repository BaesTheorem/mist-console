import SwiftUI

/// The shell's own settings: which Mac, which addresses, the pairing.
/// (MIST's settings live in the page; this is only the transport.)
struct SettingsView: View {
    @EnvironmentObject var store: ServerStore
    @EnvironmentObject var link: ConsoleLink
    @EnvironmentObject var cache: ChatCache
    @Environment(\.dismiss) private var dismiss

    @State private var newURL = ""
    @State private var scanning = false
    @State private var confirmForget = false
    @State private var syncNote = ""

    var body: some View {
        NavigationStack {
            List {
                Section("mac") {
                    row("name", store.pairing?.name ?? "—")
                    row("connected via", link.base?.absoluteString ?? "—")
                    row("paired", store.pairedAt.map { $0.formatted(date: .abbreviated, time: .shortened) } ?? "—")
                    row("last check", link.lastProbeAt.map { $0.formatted(date: .omitted, time: .shortened) } ?? "—")
                }
                Section {
                    ForEach(store.pairing?.urls ?? [], id: \.self) { u in
                        HStack(spacing: 8) {
                            Image(systemName: mark(u))
                                .foregroundStyle(color(u))
                            Text(u)
                                .font(.system(.footnote, design: .monospaced))
                                .lineLimit(2)
                            Spacer()
                            if link.base?.absoluteString == u {
                                Text("in use").font(.caption2).foregroundStyle(Color.teal)
                            }
                        }
                    }
                    .onDelete { idx in
                        let urls = store.pairing?.urls ?? []
                        idx.map { urls[$0] }.forEach { store.remove(url: $0) }
                    }
                    HStack {
                        TextField("add an address (https://…)", text: $newURL)
                            .font(.system(.footnote, design: .monospaced))
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Button("add") {
                            var u = newURL.trimmingCharacters(in: .whitespacesAndNewlines)
                            if !u.isEmpty, !u.lowercased().hasPrefix("http") { u = "https://" + u }
                            store.add(url: u)
                            newURL = ""
                        }
                        .disabled(newURL.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                    Button("check them now") { link.reconnect(store: store) }
                    Button("sync the list from the Mac") { Task { await sync() } }
                    if !syncNote.isEmpty {
                        Text(syncNote).font(.footnote).foregroundStyle(.secondary)
                    }
                } header: {
                    Text("addresses, tried in order")
                } footer: {
                    Text("The Mac's own network address comes first, then a tunnel or a Tailscale name for when you're away. Swipe to remove one. The Mac republishes new addresses to this list whenever the app connects.")
                }
                Section {
                    row("chats on the phone", "\(cache.chats.filter { $0.syncedActivity >= 0 }.count) of \(cache.chats.count)")
                    row("size", ByteCountFormatter.string(fromByteCount: cache.sizeOnDisk, countStyle: .file))
                    row("last sync", cache.lastSync.map { $0.formatted(date: .abbreviated, time: .shortened) } ?? "never")
                    if cache.syncing {
                        Text(cache.pending > 0 ? "syncing, \(cache.pending) to go" : "syncing").font(.footnote).foregroundStyle(.secondary)
                    }
                    if let e = cache.lastError { Text(e).font(.footnote).foregroundStyle(.secondary) }
                    Button("read cached chats") { link.showReader = true }
                    Button("sync now") {
                        if let base = link.base, let token = store.pairing?.token { cache.sync(base: base, token: token) }
                    }
                    .disabled(link.base == nil || cache.syncing)
                    Button("clear the cache", role: .destructive) { cache.clear() }
                } header: {
                    Text("offline copy")
                } footer: {
                    Text("Every chat, as text, copied to the phone whenever the app is connected, newest first. Readable when the Mac is out of reach; not editable.")
                }
                Section("pairing") {
                    Button("scan a new pairing code") { scanning = true }
                    Button("forget this Mac", role: .destructive) { confirmForget = true }
                }
                Section {
                    Text("MIST for iPhone \(version). The Console itself runs on the Mac; this app mirrors it, so the Mac has to be awake and online.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.surface)
            .navigationTitle("phone settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("done") { dismiss() }
                }
            }
            .sheet(isPresented: $scanning) {
                QRScannerSheet { code in
                    scanning = false
                    if let p = Pairing.parse(text: code) {
                        store.apply(p)
                        link.reconnect(store: store)
                        dismiss()
                    } else {
                        syncNote = "That isn't a MIST pairing code."
                    }
                }
            }
            .confirmationDialog("Forget this Mac? You'll need to scan its code again.",
                                isPresented: $confirmForget, titleVisibility: .visible) {
                Button("forget", role: .destructive) {
                    store.forget()
                    link.forgetMac()
                    dismiss()
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private var version: String {
        (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "?"
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .font(.system(.footnote, design: .monospaced))
                .multilineTextAlignment(.trailing)
                .lineLimit(2)
        }
    }

    private func mark(_ u: String) -> String {
        switch link.lastResults[u] {
        case .some(true): return "checkmark.circle"
        case .some(false): return "xmark.circle"
        case .none: return "circle.dashed"
        }
    }

    private func color(_ u: String) -> Color {
        switch link.lastResults[u] {
        case .some(true): return .green
        case .some(false): return Color(red: 1, green: 0.71, blue: 0.67)
        case .none: return .secondary
        }
    }

    private func sync() async {
        guard let base = link.base, let token = store.pairing?.token else {
            syncNote = "Connect first; the list comes from the Mac."
            return
        }
        if let c = await Probe.config(base, token: token) {
            store.merge(urls: c.urls, discovery: c.discovery)
            syncNote = "Synced \(c.urls.count) address\(c.urls.count == 1 ? "" : "es")."
        } else {
            syncNote = "The Mac didn't answer the sync."
        }
    }
}
