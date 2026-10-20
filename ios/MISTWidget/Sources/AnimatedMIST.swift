import ClockHandKit
import SwiftUI
import WidgetKit

/// "MIST (animated)": the crystal idling on the Home Screen and the CarPlay
/// Dashboard, with an occasional fidget. A widget is a series of snapshots, so
/// the motion comes from WidgetKit's private clock-hand rotation (ClockHandKit):
/// the system turns a view by the current time with no timeline refresh. Each
/// frame sits behind an arc mask with a radius 50x the widget, so at widget
/// scale the arc is a straight band; as the masks turn, one frame at a time
/// passes the viewport. Technique from KeyringWidget (giljihun, MIT).
///
/// The timeline only picks which clip plays: idle for a few minutes, then one
/// fidget, then idle again. Entries are computed ahead, so they cost no reloads.
/// If the private effect stops working (it did once, in iOS 26.1), the masks do
/// not turn and the widget shows a still crystal: degraded, never broken.
///
/// The small counter under the name is a probe: a timer label ticks on its own
/// wherever the host renders live. Ticking counter + still crystal = the host
/// blocks the rotation; both still = the host shows a snapshot.

struct Clip {
    let name: String
    /// Seconds for one loop of the clip (dist/meta.json in mist-anims).
    let period: TimeInterval
}

private let idle = Clip(name: "idle", period: 4)
private let fidgets = [
    Clip(name: "happy", period: 2),
    Clip(name: "curious", period: 4),
    Clip(name: "thinking", period: 2.4),
]
/// Frames per clip, as extracted into Resources/Frames.
private let frameCount = 32

struct ClipEntry: TimelineEntry {
    let date: Date
    let clip: Clip
    let since: Date
}

struct ClipProvider: TimelineProvider {
    func placeholder(in context: Context) -> ClipEntry { ClipEntry(date: .now, clip: idle, since: .now) }

    func getSnapshot(in context: Context, completion: @escaping (ClipEntry) -> Void) {
        completion(ClipEntry(date: .now, clip: idle, since: .now))
    }

    /// Six hours ahead: 3 minutes idle, 40 seconds of the next fidget, repeat.
    func getTimeline(in context: Context, completion: @escaping (Timeline<ClipEntry>) -> Void) {
        let start = Date.now
        var entries: [ClipEntry] = []
        var t = start
        var i = Int.random(in: 0..<fidgets.count)
        while t < start.addingTimeInterval(6 * 3600) {
            entries.append(ClipEntry(date: t, clip: idle, since: start))
            t += 180
            entries.append(ClipEntry(date: t, clip: fidgets[i % fidgets.count], since: start))
            t += 40
            i += 1
        }
        completion(Timeline(entries: entries, policy: .atEnd))
    }
}

/// An arc whose radius is large enough that, at widget scale, it reads as a
/// straight band.
private struct ArcBand: Shape {
    let start: Double
    let end: Double
    let radius: Double

    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.addArc(center: CGPoint(x: rect.midX, y: rect.midY), radius: radius,
                 startAngle: .degrees(start), endAngle: .degrees(end), clockwise: false)
        return p
    }
}

struct FrameLoop: View {
    let clip: Clip
    let size: CGFloat

    var body: some View {
        let radius = Double(size) * 50
        let step = 360.0 / Double(frameCount)
        ZStack {
            ForEach(0..<frameCount, id: \.self) { i in
                frame(i)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
                    .frame(width: size, height: size)
                    .mask(
                        ArcBand(start: -step * Double(i + 1), end: -step * Double(i), radius: radius)
                            .stroke(style: StrokeStyle(lineWidth: Double(size) * 1.5, lineCap: .butt))
                            .frame(width: size, height: size)
                            .clockHandRotationEffect(period: .custom(clip.period))
                            .offset(y: radius)
                    )
            }
        }
        .frame(width: size, height: size)
    }

    private func frame(_ i: Int) -> Image {
        let name = String(format: "%@_%02d", clip.name, i)
        if let url = Bundle.main.url(forResource: name, withExtension: "png"),
           let img = UIImage(contentsOfFile: url.path) {
            return Image(uiImage: img)
        }
        return Image(systemName: "diamond.fill")
    }
}

struct AnimatedMISTView: View {
    let entry: ClipEntry

    var body: some View {
        GeometryReader { g in
            let side = min(g.size.width, g.size.height)
            VStack(spacing: 2) {
                FrameLoop(clip: entry.clip, size: side * 0.78)
                HStack(spacing: 6) {
                    Text("MIST").font(.caption.weight(.semibold))
                    Text(entry.since, style: .timer)
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

struct AnimatedMISTWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "MISTAnimated", provider: ClipProvider()) { entry in
            AnimatedMISTView(entry: entry)
                .widgetURL(URL(string: "mist://open"))
                .containerBackground(for: .widget) { Color("WidgetBackground") }
        }
        .configurationDisplayName("MIST (animated)")
        .description("MIST idling, with the odd fidget. Also works on the CarPlay Dashboard.")
        .supportedFamilies([.systemSmall])
    }
}
