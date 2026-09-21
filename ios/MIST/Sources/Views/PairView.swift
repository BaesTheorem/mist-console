import SwiftUI

/// First run, or after "forget this Mac": scan the pairing code the Console
/// shows under settings, phone; or paste the link; or type the pieces in.
struct PairView: View {
    @EnvironmentObject var store: ServerStore
    @EnvironmentObject var link: ConsoleLink

    @State private var scanning = false
    @State private var pasted = ""
    @State private var manualURL = ""
    @State private var manualToken = ""
    @State private var problem: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("M I S T")
                    .font(.system(.title2, design: .monospaced).weight(.bold))
                    .foregroundStyle(Color.teal)
                    .padding(.top, 8)
                Text("A window onto the MIST Console running on your Mac. Every chat there is here, live; nothing runs on the phone itself, so the Mac has to be awake.")
                    .font(.system(.subheadline, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text("On the Mac: MIST's settings, the phone section, switch on remote access, then scan the code it shows.")
                    .font(.system(.subheadline, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                Button {
                    scanning = true
                } label: {
                    Label("scan the pairing code", systemImage: "qrcode.viewfinder")
                }
                .buttonStyle(FlatButtonStyle(filled: true))

                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel("or paste the pairing link")
                    TextField("mist://pair?d=…", text: $pasted)
                        .textFieldStyle(FlatFieldStyle())
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("pair") { accept(pasted) }
                        .buttonStyle(FlatButtonStyle())
                        .disabled(pasted.trimmingCharacters(in: .whitespaces).isEmpty)
                }

                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel("or type it in")
                    TextField("http://192.168.1.20:5014", text: $manualURL)
                        .textFieldStyle(FlatFieldStyle())
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("pairing token", text: $manualToken)
                        .textFieldStyle(FlatFieldStyle())
                    Button("pair") { acceptManual() }
                        .buttonStyle(FlatButtonStyle())
                        .disabled(manualURL.isEmpty || manualToken.isEmpty)
                }

                if let problem {
                    Text(problem)
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundStyle(Color(red: 1, green: 0.71, blue: 0.67))
                }
            }
            .padding(20)
        }
        .background(Color.surface.ignoresSafeArea())
        .scrollDismissesKeyboard(.interactively)
        .sheet(isPresented: $scanning) {
            QRScannerSheet { code in
                scanning = false
                accept(code)
            }
        }
    }

    private func accept(_ text: String) {
        guard let p = Pairing.parse(text: text) else {
            problem = "That isn't a MIST pairing code."
            return
        }
        problem = nil
        store.apply(p)
        link.reconnect(store: store)
    }

    private func acceptManual() {
        var u = manualURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if !u.lowercased().hasPrefix("http") { u = "http://" + u }
        guard URL(string: u) != nil else {
            problem = "That address doesn't parse."
            return
        }
        problem = nil
        store.apply(Pairing(name: "MIST Console", urls: [u],
                            token: manualToken.trimmingCharacters(in: .whitespacesAndNewlines),
                            discovery: nil))
        link.reconnect(store: store)
    }
}

struct FlatFieldStyle: TextFieldStyle {
    func _body(configuration: TextField<Self._Label>) -> some View {
        configuration
            .font(.system(.body, design: .monospaced))
            .padding(10)
            .background(Color.surface)
            .overlay(Rectangle().stroke(Color.hairline, lineWidth: 1))
    }
}
