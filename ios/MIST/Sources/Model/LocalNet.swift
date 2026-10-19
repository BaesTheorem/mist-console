import Darwin
import Foundation

/// Which remembered addresses this phone can plausibly reach from the network
/// it is on right now. A private address that is not on any of the phone's
/// own subnets goes out the default route, where only the network's gateway
/// (a cafe router, a carrier) could answer it; the shell must not hand that
/// gateway the pairing token over plain http, and the ping would only time
/// out anyway. https candidates and host names are always plausible: the
/// phone cannot judge them from here.
enum LocalNet {
    struct V4: Equatable {
        let addr: UInt32
        let mask: UInt32
    }

    /// The phone's up, non-loopback IPv4 interfaces with their netmasks.
    static func current() -> [V4] {
        var out: [V4] = []
        var ifap: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifap) == 0, let first = ifap else { return [] }
        defer { freeifaddrs(ifap) }
        for p in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let flags = Int32(p.pointee.ifa_flags)
            guard flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0,
                  let a = p.pointee.ifa_addr, a.pointee.sa_family == UInt8(AF_INET),
                  let m = p.pointee.ifa_netmask else { continue }
            let addr = a.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { UInt32(bigEndian: $0.pointee.sin_addr.s_addr) }
            let mask = m.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { UInt32(bigEndian: $0.pointee.sin_addr.s_addr) }
            out.append(V4(addr: addr, mask: mask))
        }
        return out
    }

    /// An IPv4 literal, in host byte order.
    static func ipv4(_ host: String) -> UInt32? {
        var a = in_addr()
        guard inet_pton(AF_INET, host, &a) == 1 else { return nil }
        return UInt32(bigEndian: a.s_addr)
    }

    private static func inNet(_ ip: UInt32, _ base: UInt32, _ bits: UInt32) -> Bool {
        let mask: UInt32 = bits == 0 ? 0 : ~UInt32(0) << (32 - bits)
        return ip & mask == base & mask
    }

    private static func isPrivate(_ ip: UInt32) -> Bool {
        inNet(ip, 0x0A00_0000, 8) || inNet(ip, 0xAC10_0000, 12)
            || inNet(ip, 0xC0A8_0000, 16) || inNet(ip, 0xA9FE_0000, 16)
    }

    /// Tailscale and other overlay networks hand out 100.64.0.0/10.
    private static func isCGNAT(_ ip: UInt32) -> Bool { inNet(ip, 0x6440_0000, 10) }

    /// The iPhone's own Personal Hotspot subnet. Kept even when no interface
    /// shows it, because the bridge interface only appears once the Mac joins.
    private static func isHotspot(_ ip: UInt32) -> Bool { inNet(ip, 0xAC14_0A00, 28) }

    static func plausible(_ url: URL, nets: [V4]) -> Bool {
        guard url.scheme?.lowercased() == "http",
              let host = url.host, let ip = ipv4(host) else { return true }
        // No interface information at all: do not guess, let the ping decide.
        if nets.isEmpty { return true }
        if isCGNAT(ip) { return nets.contains { isCGNAT($0.addr) } }
        if isHotspot(ip) { return true }
        if isPrivate(ip) { return nets.contains { ip & $0.mask == $0.addr & $0.mask } }
        return true
    }
}
