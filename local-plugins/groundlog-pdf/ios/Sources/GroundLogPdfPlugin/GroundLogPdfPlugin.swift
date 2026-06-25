import Foundation
import UIKit
import PDFKit
import Capacitor

/// Native PDF viewer for GroundLog (iOS only).
///
/// Why this exists: rendering large architectural site-plan PDFs (aerial-photo
/// raster backgrounds) with pdf.js + <canvas> inside the WKWebView blows the
/// WebKit memory ceiling → the WebView is OOM-killed and reloads ("kicks back to
/// the daily log"). PDFKit (the engine the Books/Files apps use) does native
/// tiling + downsampling and handles 200 MB plan sets effortlessly.
///
/// The web PWA keeps its pdf.js viewer; JS branches on Capacitor.isNativePlatform().
@objc(GroundLogPdfPlugin)
public class GroundLogPdfPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "GroundLogPdfPlugin"
    public let jsName = "GroundLogPdf"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "present", returnType: CAPPluginReturnPromise)
    ]

    /// present({ url?: string, path?: string, title?: string, startPage?: number })
    ///   url  — a remote (tokenized Firebase Storage) URL; downloaded natively to a
    ///          temp file (streamed to disk, low memory) before display.
    ///   path — a local file path/URL (offline-pinned doc); displayed directly.
    /// Resolves { closed: true, lastPage: <int> } when the user dismisses.
    @objc func present(_ call: CAPPluginCall) {
        let title = call.getString("title") ?? "Document"
        let startPage = call.getInt("startPage") ?? 0
        let urlStr = call.getString("url")
        let pathStr = call.getString("path")

        // Local file path wins (offline-pinned). Accepts "file://…" or a bare path.
        if let p = pathStr, !p.isEmpty {
            let fileURL = p.hasPrefix("file://") ? (URL(string: p) ?? URL(fileURLWithPath: p))
                                                 : URL(fileURLWithPath: p)
            guard FileManager.default.fileExists(atPath: fileURL.path) else {
                call.reject("Offline file not found at path.")
                return
            }
            self.presentViewer(call: call, fileURL: fileURL, title: title, startPage: startPage, isTemp: false)
            return
        }

        guard let urlStr = urlStr, let remoteURL = URL(string: urlStr) else {
            call.reject("No valid 'url' or 'path' provided.")
            return
        }

        // Stream the remote PDF to a temp file (URLSession download = disk-backed,
        // does not load the whole file into memory).
        let task = URLSession.shared.downloadTask(with: remoteURL) { tempURL, response, error in
            if let error = error {
                call.reject("Download failed: \(error.localizedDescription)")
                return
            }
            guard let tempURL = tempURL else {
                call.reject("Download produced no file.")
                return
            }
            // Move to a stable temp path with a .pdf extension (needed for the iOS
            // share sheet / "Copy to Books" to recognise the type).
            let dest = FileManager.default.temporaryDirectory
                .appendingPathComponent("gl-\(UUID().uuidString).pdf")
            do {
                try? FileManager.default.removeItem(at: dest)
                try FileManager.default.moveItem(at: tempURL, to: dest)
            } catch {
                call.reject("Could not stage downloaded PDF: \(error.localizedDescription)")
                return
            }
            self.presentViewer(call: call, fileURL: dest, title: title, startPage: startPage, isTemp: true)
        }
        task.resume()
    }

    private func presentViewer(call: CAPPluginCall, fileURL: URL, title: String, startPage: Int, isTemp: Bool) {
        DispatchQueue.main.async {
            guard let doc = PDFDocument(url: fileURL) else {
                call.reject("Could not open this PDF (it may be corrupt or unsupported).")
                return
            }
            guard let presenter = self.bridge?.viewController else {
                call.reject("No view controller available to present from.")
                return
            }
            let vc = GLPdfViewController(document: doc, title: title, fileURL: fileURL,
                                        startPage: startPage, deleteOnClose: isTemp)
            vc.onClose = { lastPage in
                call.resolve(["closed": true, "lastPage": lastPage])
            }
            let nav = UINavigationController(rootViewController: vc)
            nav.modalPresentationStyle = .fullScreen
            presenter.present(nav, animated: true, completion: nil)
        }
    }
}

/// Full-screen PDFKit viewer hosted in a UINavigationController.
/// v1 chrome: title · page X/Y · Done (close) · Share (to Books/Files).
/// Continuous vertical scroll, auto-scaled. Thumbnails / search / single-page
/// toggle / jump-to-page are a deliberate iteration-2 add (keeps the first
/// native surface tight for the no-Mac CI/TestFlight loop).
class GLPdfViewController: UIViewController {
    private let pdfView = PDFView()
    private let document: PDFDocument
    private let fileURL: URL
    private let startPage: Int
    private let deleteOnClose: Bool
    private let pageLabel = UILabel()
    var onClose: ((Int) -> Void)?
    private var didReportClose = false

    init(document: PDFDocument, title: String, fileURL: URL, startPage: Int, deleteOnClose: Bool) {
        self.document = document
        self.fileURL = fileURL
        self.startPage = startPage
        self.deleteOnClose = deleteOnClose
        super.init(nibName: nil, bundle: nil)
        self.title = title
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        pdfView.document = document
        pdfView.autoScales = true
        pdfView.displayMode = .singlePageContinuous
        pdfView.displayDirection = .vertical
        pdfView.usePageViewController(false)
        pdfView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(pdfView)
        NSLayoutConstraint.activate([
            pdfView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            pdfView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            pdfView.topAnchor.constraint(equalTo: view.topAnchor),
            pdfView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])

        // Jump to the requested start page.
        if startPage > 0, startPage < document.pageCount, let pg = document.page(at: startPage) {
            DispatchQueue.main.async { [weak self] in self?.pdfView.go(to: pg) }
        }

        // Nav bar: Done (left), Share (right), page indicator (title view area).
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .done, target: self, action: #selector(closeTapped))
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .action, target: self, action: #selector(shareTapped))

        pageLabel.font = .systemFont(ofSize: 12, weight: .medium)
        pageLabel.textColor = .secondaryLabel
        pageLabel.textAlignment = .center
        let stack = UIStackView()
        stack.axis = .vertical
        let titleLbl = UILabel()
        titleLbl.text = title
        titleLbl.font = .systemFont(ofSize: 15, weight: .semibold)
        titleLbl.textAlignment = .center
        titleLbl.lineBreakMode = .byTruncatingMiddle
        stack.addArrangedSubview(titleLbl)
        stack.addArrangedSubview(pageLabel)
        navigationItem.titleView = stack

        NotificationCenter.default.addObserver(
            self, selector: #selector(pageChanged),
            name: Notification.Name.PDFViewPageChanged, object: pdfView)
        updatePageLabel()
    }

    @objc private func pageChanged() { updatePageLabel() }

    private func currentPageIndex() -> Int {
        guard let cur = pdfView.currentPage else { return 0 }
        return document.index(for: cur)
    }

    private func updatePageLabel() {
        let total = document.pageCount
        let idx = currentPageIndex() + 1
        pageLabel.text = total > 0 ? "\(idx) / \(total)" : ""
    }

    @objc private func shareTapped() {
        let av = UIActivityViewController(activityItems: [fileURL], applicationActivities: nil)
        // iPad popover anchor.
        av.popoverPresentationController?.barButtonItem = navigationItem.rightBarButtonItem
        present(av, animated: true)
    }

    @objc private func closeTapped() {
        reportCloseAndDismiss()
    }

    private func reportCloseAndDismiss() {
        if !didReportClose {
            didReportClose = true
            onClose?(currentPageIndex())
        }
        dismiss(animated: true) { [weak self] in
            guard let self = self, self.deleteOnClose else { return }
            try? FileManager.default.removeItem(at: self.fileURL)
        }
    }

    // Covers swipe-to-dismiss too (if presentation style ever allows it).
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if !didReportClose {
            didReportClose = true
            onClose?(currentPageIndex())
            if deleteOnClose { try? FileManager.default.removeItem(at: fileURL) }
        }
    }

    deinit { NotificationCenter.default.removeObserver(self) }
}
