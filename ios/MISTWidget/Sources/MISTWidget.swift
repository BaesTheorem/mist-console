import SwiftUI
import WidgetKit

/// Lock Screen (and Home Screen) widgets: the MIST mark as a launcher. Nothing
/// runs on the phone, so there is nothing live to show; the value is one tap
/// from the lock screen into the Console. "New chat" lands in a fresh chat.

struct LaunchEntry: TimelineEntry {
    let date: Date
}

struct LaunchProvider: TimelineProvider {
    func placeholder(in context: Context) -> LaunchEntry { LaunchEntry(date: .now) }
    func getSnapshot(in context: Context, completion: @escaping (LaunchEntry) -> Void) {
        completion(LaunchEntry(date: .now))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<LaunchEntry>) -> Void) {
        completion(Timeline(entries: [LaunchEntry(date: .now)], policy: .never))
    }
}

/// The rhombus from the logo (the same shape the chat rail uses as its status dot).
struct MISTMark: View {
    var body: some View {
        GeometryReader { g in
            Path { p in
                let w = g.size.width, h = g.size.height
                p.move(to: CGPoint(x: w / 2, y: 0))
                p.addLine(to: CGPoint(x: w, y: h / 2))
                p.addLine(to: CGPoint(x: w / 2, y: h))
                p.addLine(to: CGPoint(x: 0, y: h / 2))
                p.closeSubpath()
            }
            .fill()
        }
        .aspectRatio(8.0 / 13.0, contentMode: .fit)
    }
}

struct LaunchView: View {
    @Environment(\.widgetFamily) private var family
    let title: String
    let subtitle: String

    var body: some View {
        switch family {
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                MISTMark().padding(11)
            }
        case .accessoryInline:
            Label {
                Text(title)
            } icon: {
                Image(systemName: "diamond.fill")
            }
        case .accessoryRectangular:
            HStack(spacing: 8) {
                MISTMark().frame(height: 30)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(.headline)
                    Text(subtitle).font(.caption2).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
        default:
            VStack(alignment: .leading, spacing: 6) {
                MISTMark().frame(height: 40).foregroundStyle(Color.teal)
                Spacer(minLength: 0)
                Text(title).font(.headline)
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(14)
        }
    }
}

private let families: [WidgetFamily] = [.accessoryCircular, .accessoryRectangular, .accessoryInline, .systemSmall]

struct MISTLaunchWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "MISTLaunch", provider: LaunchProvider()) { _ in
            LaunchView(title: "MIST", subtitle: "Console on your Mac")
                .widgetURL(URL(string: "mist://open"))
                .containerBackground(for: .widget) { Color("WidgetBackground") }
        }
        .configurationDisplayName("MIST")
        .description("Open the MIST Console.")
        .supportedFamilies(families)
    }
}

struct MISTNewChatWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "MISTNewChat", provider: LaunchProvider()) { _ in
            LaunchView(title: "New chat", subtitle: "MIST, fresh chat")
                .widgetURL(URL(string: "mist://new"))
                .containerBackground(for: .widget) { Color("WidgetBackground") }
        }
        .configurationDisplayName("MIST: new chat")
        .description("Open the MIST Console in a fresh chat.")
        .supportedFamilies(families)
    }
}

@main
struct MISTWidgetBundle: WidgetBundle {
    var body: some Widget {
        MISTLaunchWidget()
        MISTNewChatWidget()
    }
}

extension Color {
    static let teal = Color(red: 0x38 / 255, green: 0xdb / 255, blue: 0xdb / 255)
}
