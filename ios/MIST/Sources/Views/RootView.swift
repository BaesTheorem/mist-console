import SwiftUI

struct RootView: View {
    @EnvironmentObject var store: ServerStore
    @EnvironmentObject var link: ConsoleLink

    var body: some View {
        Group {
            if store.pairing == nil {
                PairView()
            } else {
                ConsoleScreen()
            }
        }
        .sheet(isPresented: $link.showSettings) {
            SettingsView()
                .environmentObject(store)
                .environmentObject(link)
        }
    }
}

/// Flat and sharp, like the Console: square corners, a hairline, no shadow.
struct FlatButtonStyle: ButtonStyle {
    var filled = false
    var destructive = false

    func makeBody(configuration: Configuration) -> some View {
        let tint: Color = destructive ? Color(red: 1, green: 0.71, blue: 0.67) : .teal
        configuration.label
            .font(.system(.body, design: .monospaced).weight(filled ? .bold : .regular))
            .padding(.vertical, 11)
            .padding(.horizontal, 14)
            .frame(maxWidth: .infinity)
            .foregroundStyle(filled ? Color.surface : tint)
            .background(filled ? tint : Color.surfaceLow)
            .overlay(Rectangle().stroke(filled ? tint : Color.hairline, lineWidth: 1))
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

struct SectionLabel: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 11, design: .monospaced))
            .tracking(1.5)
            .foregroundStyle(Color.teal)
    }
}
