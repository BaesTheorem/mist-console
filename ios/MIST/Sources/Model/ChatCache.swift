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

/// No id of its own: several tool lines share a timestamp and can share
/// text, so views key rows by their position in the transcript.
struct CachedMessage: Codable {
    var role: String              // user | assistant | tool
    var text: String
    var ts: Double?
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
    /// Identity of the sync `task` runs. A cancelled sync's tail compares its
    /// own id against this before touching shared state, so it can never
    /// clear or overwrite a newer sync.
    private var syncID: UUID?
    /// Results are published to `chats` and the index written once per this
    /// many transcripts, not per chat (the full index is ~1900 entries).
    private static let batch = 25
    private var indexWrite: Task<Void, Never>?

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

    /// Read and decode one cached transcript off the main thread (a long
    /// chat is megabytes of JSON).
    func transcript(for id: String) async -> CachedTranscript? {
        let url = dir.appendingPathComponent("\(id).json")
        return await Task.detached(priority: .userInitiated) { () -> CachedTranscript? in
            guard let data = try? Data(contentsOf: url) else { return nil }
            return try? JSONDecoder().decode(CachedTranscript.self, from: data)
        }.value
    }

    /// Encode and write the index off the main thread. Each write waits for
    /// the one before it, so an older snapshot never lands last.
    private func saveIndex() {
        let list = chats
        let url = indexURL
        let previous = indexWrite
        indexWrite = Task.detached(priority: .utility) {
            await previous?.value
            if let data = try? JSONEncoder().encode(list) { try? data.write(to: url, options: .atomic) }
        }
    }

    /// Bring the cache up to the Mac's registry. Safe to call often; a sync
    /// already running is left alone.
    func sync(base: URL, token: String) {
        guard task == nil else { return }
        let id = UUID()
        syncID = id
        task = Task { [weak self] in
            await self?.run(base: base, token: token, id: id)
            guard let self, self.syncID == id else { return }
            self.task = nil
            self.syncID = nil
        }
    }

    func cancel() {
        task?.cancel()
        task = nil
        syncID = nil
        syncing = false
        pending = 0
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

    private func run(base: URL, token: String, id syncRun: UUID) async {
        func current() -> Bool { !Task.isCancelled && syncID == syncRun }
        syncing = true
        lastError = nil
        defer { if syncID == syncRun { syncing = false } }
        guard let list = await Self.fetchList(base: base, token: token) else {
            if current() { lastError = "couldn't read the chat list" }
            return
        }
        guard current() else { return }

        // Registry wins for titles, pins and existence; transcripts follow.
        var byID = Dictionary(chats.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
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
        let gone = byID.keys.map { dir.appendingPathComponent("\($0).json") }
        if !gone.isEmpty {   // closed on the Mac: drop the copy
            Task.detached(priority: .utility) {
                for u in gone { try? FileManager.default.removeItem(at: u) }
            }
        }
        chats = next.sorted { $0.lastActivity > $1.lastActivity }
        saveIndex()

        let stale = chats.filter { $0.syncedActivity < $0.lastActivity }
        pending = stale.count
        // Newest first, two at a time: the recent chats are the ones worth
        // having if the sync is cut short. Fetch, decode, encode and write
        // all happen in the child tasks, off the main thread; this loop only
        // collects small results and publishes them in batches.
        var index = 0
        var failed = 0
        var done: [String: (synced: Double?, count: Int)] = [:]
        let ids = stale.map { $0.id }
        let folder = dir
        func publish() {
            guard !done.isEmpty else { return }
            for i in chats.indices {
                guard let r = done[chats[i].id] else { continue }
                chats[i].syncedActivity = r.synced ?? chats[i].lastActivity
                chats[i].messageCount = r.count
            }
            done.removeAll()
            saveIndex()
        }
        await withTaskGroup(of: (String, (synced: Double?, count: Int)?).self) { group in
            func enqueue() {
                guard index < ids.count else { return }
                let id = ids[index]; index += 1
                group.addTask { (id, await Self.fetchAndStore(base: base, token: token, id: id, dir: folder)) }
            }
            enqueue(); enqueue()
            var finished = 0
            for await (id, result) in group {
                if !current() { group.cancelAll(); break }
                if let result { done[id] = result } else { failed += 1 }
                finished += 1
                if finished % Self.batch == 0 {
                    publish()
                    pending = ids.count - finished
                }
                enqueue()
            }
        }
        guard current() else { return }
        publish()
        pending = 0
        // Only a sync that copied everything moves "last sync"; a partial one
        // says what is missing and is picked up again on the next connect.
        if failed == 0 {
            lastSync = Date()
            UserDefaults.standard.set(lastSync, forKey: "chatCache.lastSync")
        } else {
            lastError = "\(failed) chat\(failed == 1 ? "" : "s") didn't copy; they'll be tried again on the next connect"
        }
    }

    private nonisolated static func fetchList(base: URL, token: String) async -> [Meta]? {
        var req = URLRequest(url: base.appending(path: "sessions"))
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return try? JSONDecoder().decode([Meta].self, from: data)
    }

    /// Fetch one transcript, decode it, write the phone's copy. Runs in a
    /// task group child, never on the main thread. Returns what the index
    /// needs, or nil when the chat did not copy.
    private nonisolated static func fetchAndStore(base: URL, token: String, id: String,
                                                  dir: URL) async -> (synced: Double?, count: Int)? {
        var req = URLRequest(url: base.appending(path: "sessions/\(id)/transcript"))
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 60
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200,
              let doc = try? JSONDecoder().decode(CachedTranscript.self, from: data),
              let out = try? JSONEncoder().encode(doc),
              (try? out.write(to: dir.appendingPathComponent("\(id).json"), options: .atomic)) != nil
        else { return nil }
        return (doc.last_activity, doc.messages.count)
    }
}
