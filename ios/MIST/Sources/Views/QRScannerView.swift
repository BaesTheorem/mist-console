import AVFoundation
import SwiftUI
import UIKit

struct QRScannerSheet: View {
    let onCode: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            QRScannerView(onCode: onCode)
                .ignoresSafeArea()
                .navigationTitle("pairing code")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("cancel") { dismiss() }
                    }
                }
        }
    }
}

struct QRScannerView: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let vc = ScannerController()
        vc.onCode = onCode
        return vc
    }

    func updateUIViewController(_ vc: ScannerController, context: Context) {}
}

final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?
    private let session = AVCaptureSession()
    private var preview: AVCaptureVideoPreviewLayer?
    private var fired = false
    private let note = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        note.textColor = .white
        note.font = UIFont.monospacedSystemFont(ofSize: 14, weight: .regular)
        note.numberOfLines = 0
        note.textAlignment = .center
        note.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(note)
        NSLayoutConstraint.activate([
            note.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            note.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
            note.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -28),
        ])
        note.text = "Point the camera at the pairing code in the Console's phone section."
        AVCaptureDevice.requestAccess(for: .video) { ok in
            DispatchQueue.main.async { ok ? self.start() : self.denied() }
        }
    }

    private func start() {
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else { denied(); return }
        session.addInput(input)
        let out = AVCaptureMetadataOutput()
        guard session.canAddOutput(out) else { denied(); return }
        session.addOutput(out)
        out.setMetadataObjectsDelegate(self, queue: .main)
        out.metadataObjectTypes = [.qr]
        let p = AVCaptureVideoPreviewLayer(session: session)
        p.videoGravity = .resizeAspectFill
        p.frame = view.bounds
        view.layer.insertSublayer(p, at: 0)
        preview = p
        let s = session
        DispatchQueue.global(qos: .userInitiated).async { s.startRunning() }
    }

    private func denied() {
        note.text = "No camera available, or camera access is off for MIST in Settings. Paste the pairing link instead."
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        let s = session
        if s.isRunning { DispatchQueue.global(qos: .userInitiated).async { s.stopRunning() } }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject],
                        from connection: AVCaptureConnection) {
        guard !fired,
              let obj = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let value = obj.stringValue else { return }
        fired = true
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        onCode?(value)
    }
}
