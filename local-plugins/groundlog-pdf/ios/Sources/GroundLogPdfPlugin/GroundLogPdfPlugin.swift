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
///
/// Chrome:
///   Nav bar  — Done (left) · title + tappable page X/Y [jump-to-page] (center) · Share (right)
///   Toolbar  — Thumbnails toggle · Continuous/Single toggle · Search
///              (when searching: ‹ prev · "n/m" · next › appear)
/// Continuous vertical scroll by default, auto-scaled. PDFKit handles the heavy
/// tiling/downsampling so large aerial-backed plan sets never OOM the webview.
class GLPdfViewController: UIViewController {
    private let pdfView = PDFView()
    private let thumbnailView = PDFThumbnailView()
    private let document: PDFDocument
    private let fileURL: URL
    private let startPage: Int
    private let deleteOnClose: Bool
    private let docTitle: String
    private let pageLabel = UILabel()
    var onClose: ((Int) -> Void)?
    private var didReportClose = false

    private var isContinuous = true
    private var thumbVisible = false
    private var thumbWidth: NSLayoutConstraint!

    private var searchMatches: [PDFSelection] = []
    private var searchIndex = 0
    private var thumbItem: UIBarButtonItem!
    private var layoutItem: UIBarButtonItem!
    private var searchItem: UIBarButtonItem!
    private var matchLabelItem: UIBarButtonItem!
    private var prevMatchItem: UIBarButtonItem!
    private var nextMatchItem: UIBarButtonItem!

    init(document: PDFDocument, title: String, fileURL: URL, startPage: Int, deleteOnClose: Bool) {
        self.document = document
        self.fileURL = fileURL
        self.startPage = startPage
        self.deleteOnClose = deleteOnClose
        self.docTitle = title
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

        // Collapsible thumbnail strip on the leading edge (width animates 0 ↔ 96).
        thumbnailView.pdfView = pdfView
        thumbnailView.thumbnailSize = CGSize(width: 70, height: 90)
        thumbnailView.layoutMode = .vertical
        thumbnailView.backgroundColor = .secondarySystemBackground
        thumbnailView.clipsToBounds = true
        thumbnailView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(thumbnailView)

        thumbWidth = thumbnailView.widthAnchor.constraint(equalToConstant: 0)
        NSLayoutConstraint.activate([
            thumbnailView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            thumbnailView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            thumbnailView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            thumbWidth,
            pdfView.leadingAnchor.constraint(equalTo: thumbnailView.trailingAnchor),
            pdfView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            pdfView.topAnchor.constraint(equalTo: view.topAnchor),
            pdfView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])

        if startPage > 0, startPage < document.pageCount, let pg = document.page(at: startPage) {
            DispatchQueue.main.async { [weak self] in self?.pdfView.go(to: pg) }
        }

        // Nav bar: Done · title+page (tap page to jump) · Share.
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .done, target: self, action: #selector(closeTapped))
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .action, target: self, action: #selector(shareTapped))

        let titleLbl = UILabel()
        titleLbl.text = docTitle
        titleLbl.font = .systemFont(ofSize: 15, weight: .semibold)
        titleLbl.textAlignment = .center
        titleLbl.lineBreakMode = .byTruncatingMiddle
        pageLabel.font = .systemFont(ofSize: 12, weight: .medium)
        pageLabel.textColor = .secondaryLabel
        pageLabel.textAlignment = .center
        pageLabel.isUserInteractionEnabled = true
        pageLabel.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(jumpTapped)))
        let stack = UIStackView(arrangedSubviews: [titleLbl, pageLabel])
        stack.axis = .vertical
        navigationItem.titleView = stack

        // Bottom toolbar.
        thumbItem = UIBarButtonItem(image: UIImage(systemName: "sidebar.left"),
                                    style: .plain, target: self, action: #selector(toggleThumbnails))
        layoutItem = UIBarButtonItem(image: UIImage(systemName: "doc.plaintext"),
                                     style: .plain, target: self, action: #selector(toggleLayout))
        searchItem = UIBarButtonItem(image: UIImage(systemName: "magnifyingglass"),
                                     style: .plain, target: self, action: #selector(searchTapped))
        matchLabelItem = UIBarButtonItem(title: "", style: .plain, target: nil, action: nil)
        matchLabelItem.isEnabled = false
        prevMatchItem = UIBarButtonItem(image: UIImage(systemName: "chevron.up"),
                                        style: .plain, target: self, action: #selector(prevMatch))
        nextMatchItem = UIBarButtonItem(image: UIImage(systemName: "chevron.down"),
                                        style: .plain, target: self, action: #selector(nextMatch))
        navigationController?.isToolbarHidden = false
        rebuildToolbar(searching: false)

        NotificationCenter.default.addObserver(
            self, selector: #selector(pageChanged),
            name: Notification.Name.PDFViewPageChanged, object: pdfView)
        updatePageLabel()
    }

    private func rebuildToolbar(searching: Bool) {
        let flexA = UIBarButtonItem(barButtonSystemItem: .flexibleSpace, target: nil, action: nil)
        let flexB = UIBarButtonItem(barButtonSystemItem: .flexibleSpace, target: nil, action: nil)
        if searching && !searchMatches.isEmpty {
            setToolbarItems([thumbItem, flexA, prevMatchItem, matchLabelItem, nextMatchItem, flexB, searchItem], animated: true)
        } else {
            setToolbarItems([thumbItem, flexA, layoutItem, flexB, searchItem], animated: true)
        }
    }

    // ── Thumbnails ──
    @objc private func toggleThumbnails() {
        thumbVisible.toggle()
        thumbItem.image = UIImage(systemName: thumbVisible ? "sidebar.left.fill" : "sidebar.left")
        UIView.animate(withDuration: 0.25) {
            self.thumbWidth.constant = self.thumbVisible ? 96 : 0
            self.view.layoutIfNeeded()
        }
    }

    // ── Continuous / single-page toggle ──
    @objc private func toggleLayout() {
        isContinuous.toggle()
        pdfView.displayMode = isContinuous ? .singlePageContinuous : .singlePage
        layoutItem.image = UIImage(systemName: isContinuous ? "doc.plaintext" : "doc")
    }

    // ── Jump to page ──
    @objc private func jumpTapped() {
        let total = document.pageCount
        guard total > 0 else { return }
        let ac = UIAlertController(title: "Go to page", message: "1–\(total)", preferredStyle: .alert)
        ac.addTextField { tf in tf.keyboardType = .numberPad; tf.placeholder = "Page number" }
        ac.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        ac.addAction(UIAlertAction(title: "Go", style: .default) { [weak self] _ in
            guard let self = self,
                  let text = ac.textFields?.first?.text, let n = Int(text),
                  n >= 1, n <= self.document.pageCount,
                  let pg = self.document.page(at: n - 1) else { return }
            self.pdfView.go(to: pg)
        })
        present(ac, animated: true)
    }

    // ── In-document search ──
    @objc private func searchTapped() {
        let ac = UIAlertController(title: "Find in document", message: nil, preferredStyle: .alert)
        ac.addTextField { tf in tf.placeholder = "Search text"; tf.autocapitalizationType = .none }
        ac.addAction(UIAlertAction(title: "Clear", style: .destructive) { [weak self] _ in self?.clearSearch() })
        ac.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        ac.addAction(UIAlertAction(title: "Find", style: .default) { [weak self] _ in
            self?.performSearch(ac.textFields?.first?.text ?? "")
        })
        present(ac, animated: true)
    }

    private func performSearch(_ raw: String) {
        clearSearch()
        let query = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return }
        let matches = document.findString(query, withOptions: [.caseInsensitive])
        searchMatches = matches
        searchIndex = 0
        if matches.isEmpty {
            flashMessage("No matches")
            rebuildToolbar(searching: false)
            return
        }
        for m in matches { m.color = .systemYellow }
        pdfView.highlightedSelections = matches
        goToMatch(0)
        rebuildToolbar(searching: true)
    }

    private func clearSearch() {
        searchMatches = []
        searchIndex = 0
        pdfView.highlightedSelections = nil
        rebuildToolbar(searching: false)
    }

    private func goToMatch(_ i: Int) {
        guard i >= 0, i < searchMatches.count else { return }
        searchIndex = i
        let sel = searchMatches[i]
        pdfView.setCurrentSelection(sel, animate: true)
        pdfView.go(to: sel)
        matchLabelItem.title = "\(i + 1)/\(searchMatches.count)"
    }

    @objc private func prevMatch() {
        guard !searchMatches.isEmpty else { return }
        goToMatch((searchIndex - 1 + searchMatches.count) % searchMatches.count)
    }

    @objc private func nextMatch() {
        guard !searchMatches.isEmpty else { return }
        goToMatch((searchIndex + 1) % searchMatches.count)
    }

    private func flashMessage(_ text: String) {
        let lbl = UILabel()
        lbl.text = "  \(text)  "
        lbl.font = .systemFont(ofSize: 14, weight: .medium)
        lbl.textColor = .white
        lbl.backgroundColor = UIColor.black.withAlphaComponent(0.8)
        lbl.textAlignment = .center
        lbl.layer.cornerRadius = 10
        lbl.layer.masksToBounds = true
        lbl.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(lbl)
        NSLayoutConstraint.activate([
            lbl.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            lbl.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -70),
            lbl.heightAnchor.constraint(equalToConstant: 34)
        ])
        lbl.alpha = 0
        UIView.animate(withDuration: 0.2, animations: { lbl.alpha = 1 }) { _ in
            UIView.animate(withDuration: 0.3, delay: 1.0, options: [], animations: { lbl.alpha = 0 }) { _ in
                lbl.removeFromSuperview()
            }
        }
    }

    // ── Page indicator ──
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

    // ── Share / close ──
    @objc private func shareTapped() {
        let av = UIActivityViewController(activityItems: [fileURL], applicationActivities: nil)
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
