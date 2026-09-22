import Combine
import Foundation

/// Every chat, cached on the phone as readable text so it can be read when the
/// Mac is out of reach. Synced whenever the app connects: the registry is
/// compared against what is cached, and chats with newer activity are
/// fetched newest first, a couple at a time, until the list is current.
struct CachedChat: Codable, Identifiable, Equatable {
    var id: String
    var title: String
    var lastActivity: Double      // server's last_activity (epoch seconds)
    var pinned: Bool
    var syncedActivity: Double    // last_activity the cached transcript covers
    var messageCount: Int
}

struct CachedMessage: Codable, Identifiable {
    var role: String              // user | assistant | tool
    var text: String
    var ts: Double?
    var id: String { "\(ts ?? 0)-\(role)-\(text.hashValue)" }
}

struct CachedTranscript: Codable {
    var id: String?
    var title: String?
    var messages: [CachedMessage]
    var updated: Double?
    var last_activity: Double?
    var pinned: Bool?
}

@MainActor
final class ChatCache: ObservableObject {
    @Published private(set) var chats: [CachedChat] = []
    @Published private(set) var syncing = false
    @Published private(set) var pending = 0
    @Published private(set) var lastSync: Date?
    @Published private(set) var lastError: String?

    private let dir: URL
    private var indexURL: URL { dir.appendingPathComponent("index.json") }
    private var task: Task<Void, Never>?

    init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        dir = base.appendingPathComponent("chats", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        if let data = try? Data(contentsOf: indexURL),
           let list = try? JSONDecoder().decode([CachedChat].self, from: data) {
            chats = list
        }
        lastSync = UserDefaults.standard.object(forKey: "chatCache.lastSync") as? Date
    }

    var isEmpty: Bool { chats.isEmpty }

    var sizeOnDisk: Int64 {
        let items = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.fileSizeKey])) ?? []
        return items.reduce(0) { $0 + Int64((try? $1.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
    }

    func transcript(for id: String) -> CachedTranscript? {
        guard let data = try? Data(contentsOf: dir.appendingPathComponent("\(id).json")) else { return nil }
        return try? JSONDecoder().decode(CachedTranscript.self, from: data)
    }

    private func saveIndex() {
        if let data = try? JSONEncoder().encode(chats) { try? data.write(to: indexURL, options: .atomic) }
    }

    /// Bring the cache up to the Mac's registry. Safe to call often; a sync
    /// already running is left alone.
    func sync(base: URL, token: String) {
        guard task == nil else { return }
        task = Task { [weak self] in
            await self?.run(base: base, token: token)
            self?.task = nil
        }
    }

    func cancel() {
        task?.cancel()
        task = nil
        syncing = false
    }

    func clear() {
        cancel()
        try? FileManager.default.removeItem(at: dir)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        chats = []
        lastSync = nil
        UserDefaults.standard.removeObject(forKey: "chatCache.lastSync")
    }

    private struct Meta: Decodable {
        var id: String
        var title: String
        var last_activity: Double?
        var pinned: Bool?
    }

    private func run(base: URL, token: String) async {
        syncing = true
        lastError = nil
        defer { syncing = false }
        var req = URLRequest(url: base.appending(path: "sessions"))
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200,
              let list = try? JSONDecoder().decode([Meta].self, from: data)
        else { lastError = "couldn't read the chat list"; return }

        // Registry wins for titles, pins and existence; transcripts follow.
        var byID = Dictionary(uniqueKeysWithValues: chats.map { ($0.id, $0) })
        var next: [CachedChat] = []
        for m in list {
            var c = byID[m.id] ?? CachedChat(id: m.id, title: m.title, lastActivity: 0, pinned: false,
                                             syncedActivity: -1, messageCount: 0)
            c.title = m.title
            c.pinned = m.pinned ?? false
            c.lastActivity = m.last_activity ?? c.lastActivity
            next.append(c)
            byID[m.id] = nil
        }
        for gone in byID.keys {   // closed on the Mac: drop the copy
            try? FileManager.default.removeItem(at: dir.appendingPathComponent("\(gone).json"))
        }
        chats = next.sorted { $0.lastActivity > $1.lastActivity }
        saveIndex()

        let stale = chats.filter { $0.syncedActivity < $0.lastActivity }
        pending = stale.count
        // Newest first, two at a time: the recent chats are the ones worth
        // having if the sync is cut short.
        var index = 0
        let ids = stale.map { $0.id }
        await withTaskGroup(of: (String, CachedTranscript?).self) { group in
            func enqueue() {
                guard index < ids.count else { return }
                let id = ids[index]; index += 1
                group.addTask { (id, await Self.fetch(base: base, token: token, id: id)) }
            }
            enqueue(); enqueue()
            for await (id, doc) in group {
                if Task.isCancelled { break }
                if let doc, let data = try? JSONEncoder().encode(doc) {
                    try? data.write(to: dir.appendingPathComponent("\(id).json"), options: .atomic)
                    if let i = chats.firstIndex(where: { $0.id == id }) {
                        chats[i].syncedActivity = doc.last_activity ?? chats[i].lastActivity
                        chats[i].messageCount = doc.messages.count
                    }
                    saveIndex()
                }
                pending = max(0, pending - 1)
                enqueue()
            }
        }
        lastSync = Date()
        UserDefaults.standard.set(lastSync, forKey: "chatCache.lastSync")
    }

    private static func fetch(base: URL, token: String, id: String) async -> CachedTranscript? {
        var req = URLRequest(url: base.appending(path: "sessions/\(id)/transcript"))
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 60
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return try? JSONDecoder().decode(CachedTranscript.self, from: data)
    }
}
