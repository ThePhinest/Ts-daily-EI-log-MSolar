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
    ///   url  — a remote (tokenized Firebase Storage) URL; downloaded natively.
    ///   path — a local file path/URL (offline-pinned doc); displayed directly.
    ///
    /// The viewer opens IMMEDIATELY with a loading spinner, then downloads/loads
    /// in the background. On failure it shows an inline "Couldn't load — Retry"
    /// state inside the viewer (not a cryptic webview banner). Resolves
    /// { closed: true, lastPage: <int> } when the user dismisses.
    @objc func present(_ call: CAPPluginCall) {
        let title = call.getString("title") ?? "Document"
        let startPage = call.getInt("startPage") ?? 0
        let urlStr = call.getString("url")
        let pathStr = call.getString("path")

        let source: GLPdfSource
        if let p = pathStr, !p.isEmpty {
            let fileURL = p.hasPrefix("file://") ? (URL(string: p) ?? URL(fileURLWithPath: p))
                                                 : URL(fileURLWithPath: p)
            source = .file(fileURL)
        } else if let u = urlStr, let remote = URL(string: u) {
            source = .remote(remote)
        } else {
            call.reject("No valid 'url' or 'path' provided.")
            return
        }

        DispatchQueue.main.async {
            guard let presenter = self.bridge?.viewController else {
                call.reject("No view controller available to present from.")
                return
            }
            let vc = GLPdfViewController(source: source, title: title, startPage: startPage)
            vc.onClose = { lastPage in call.resolve(["closed": true, "lastPage": lastPage]) }
            let nav = UINavigationController(rootViewController: vc)
            nav.modalPresentationStyle = .fullScreen
            presenter.present(nav, animated: true, completion: nil)
        }
    }
}

enum GLPdfSource {
    case remote(URL)
    case file(URL)
}

/// Full-screen PDFKit viewer hosted in a UINavigationController.
///
/// Chrome:
///   Nav bar  — Done (left) · title + tappable page X/Y [jump-to-page] (center) · Share (right)
///   Toolbar  — Thumbnails toggle · Continuous/Single toggle · Search
///              (when searching: ‹ prev · "n/m" · next › appear)
///
/// The viewer presents instantly with a spinner; the document downloads/loads in
/// the background and chrome stays disabled until it's ready. A load failure
/// shows an inline Retry state. PDFKit handles tiling/downsampling so large
/// aerial-backed plan sets never OOM the webview.
class GLPdfViewController: UIViewController {
    private let pdfView = PDFView()
    private let thumbnailView = PDFThumbnailView()
    private let source: GLPdfSource
    private let startPage: Int
    private let docTitle: String
    var onClose: ((Int) -> Void)?

    private var document: PDFDocument?
    private var loadedFileURL: URL?
    private var deleteOnClose = false
    private var didReportClose = false

    private var isContinuous = true
    private var thumbVisible = false
    private var thumbWidth: NSLayoutConstraint!

    private var searchMatches: [PDFSelection] = []
    private var searchIndex = 0

    private let pageLabel = UILabel()
    private let spinner = UIActivityIndicatorView(style: .large)
    private let loadingLabel = UILabel()
    private var errorView: UIView!
    private let errorLabel = UILabel()

    private var shareItemNav: UIBarButtonItem!
    private var thumbItem: UIBarButtonItem!
    private var layoutItem: UIBarButtonItem!
    private var searchItem: UIBarButtonItem!
    private var matchLabelItem: UIBarButtonItem!
    private var prevMatchItem: UIBarButtonItem!
    private var nextMatchItem: UIBarButtonItem!

    init(source: GLPdfSource, title: String, startPage: Int) {
        self.source = source
        self.docTitle = title
        self.startPage = startPage
        super.init(nibName: nil, bundle: nil)
        self.title = title
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

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

        // Loading spinner (centered, subtle).
        spinner.hidesWhenStopped = true
        spinner.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(spinner)
        loadingLabel.text = "Loading…"
        loadingLabel.font = .systemFont(ofSize: 13, weight: .medium)
        loadingLabel.textColor = .secondaryLabel
        loadingLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(loadingLabel)
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            loadingLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            loadingLabel.topAnchor.constraint(equalTo: spinner.bottomAnchor, constant: 10)
        ])

        buildErrorView()

        // Nav bar: Done · title+page (tap page to jump) · Share.
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .done, target: self, action: #selector(closeTapped))
        shareItemNav = UIBarButtonItem(barButtonSystemItem: .action, target: self, action: #selector(shareTapped))
        navigationItem.rightBarButtonItem = shareItemNav

        let titleLbl = UILabel()
        titleLbl.text = docTitle
        titleLbl.font = .systemFont(ofSize: 15, weight: .semibold)
        titleLbl.textAlignment = .center
        titleLbl.lineBreakMode = .byTruncatingMiddle
        pageLabel.font = .systemFont(ofSize: 12, weight: .medium)
        pageLabel.textColor = .secondaryLabel
        pageLabel.textAlignment = .center
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

        setChromeEnabled(false)
        startLoad()
    }

    // ── Loading / error ──
    private func buildErrorView() {
        let icon = UIImageView(image: UIImage(systemName: "exclamationmark.triangle"))
        icon.tintColor = .secondaryLabel
        icon.contentMode = .scaleAspectFit
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.heightAnchor.constraint(equalToConstant: 40).isActive = true

        errorLabel.text = ""
        errorLabel.font = .systemFont(ofSize: 15)
        errorLabel.textColor = .label
        errorLabel.textAlignment = .center
        errorLabel.numberOfLines = 0

        let retry = UIButton(type: .system)
        retry.setTitle("Retry", for: .normal)
        retry.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
        retry.addTarget(self, action: #selector(retryTapped), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [icon, errorLabel, retry])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false

        let container = UIView()
        container.backgroundColor = .systemBackground
        container.isHidden = true
        container.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(stack)
        view.addSubview(container)
        NSLayoutConstraint.activate([
            container.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            container.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            container.topAnchor.constraint(equalTo: view.topAnchor),
            container.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            stack.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: container.leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor, constant: -32)
        ])
        errorView = container
    }

    private func startLoad() {
        errorView.isHidden = true
        spinner.startAnimating()
        loadingLabel.isHidden = false
        switch source {
        case .file(let url):
            if FileManager.default.fileExists(atPath: url.path) {
                finishLoad(url: url, isTemp: false)
            } else {
                showError("This offline file couldn't be found.")
            }
        case .remote(let url):
            let task = URLSession.shared.downloadTask(with: url) { [weak self] tempURL, _, error in
                guard let self = self else { return }
                if let error = error {
                    DispatchQueue.main.async { self.showError("Couldn't load this PDF.\n\(error.localizedDescription)") }
                    return
                }
                guard let tempURL = tempURL else {
                    DispatchQueue.main.async { self.showError("Couldn't load this PDF.") }
                    return
                }
                let dest = FileManager.default.temporaryDirectory
                    .appendingPathComponent("gl-\(UUID().uuidString).pdf")
                do {
                    try? FileManager.default.removeItem(at: dest)
                    try FileManager.default.moveItem(at: tempURL, to: dest)
                } catch {
                    DispatchQueue.main.async { self.showError("Couldn't save this PDF for viewing.") }
                    return
                }
                DispatchQueue.main.async { self.finishLoad(url: dest, isTemp: true) }
            }
            task.resume()
        }
    }

    private func finishLoad(url: URL, isTemp: Bool) {
        guard let doc = PDFDocument(url: url) else {
            if isTemp { try? FileManager.default.removeItem(at: url) }
            showError("This PDF couldn't be opened (it may be corrupt).")
            return
        }
        document = doc
        loadedFileURL = url
        deleteOnClose = isTemp
        pdfView.document = doc
        spinner.stopAnimating()
        loadingLabel.isHidden = true
        errorView.isHidden = true
        setChromeEnabled(true)
        if startPage > 0, startPage < doc.pageCount, let pg = doc.page(at: startPage) {
            pdfView.go(to: pg)
        }
        updatePageLabel()
    }

    private func showError(_ msg: String) {
        spinner.stopAnimating()
        loadingLabel.isHidden = true
        errorLabel.text = msg
        errorView.isHidden = false
        setChromeEnabled(false)
    }

    @objc private func retryTapped() { startLoad() }

    private func setChromeEnabled(_ on: Bool) {
        shareItemNav?.isEnabled = on
        thumbItem?.isEnabled = on
        layoutItem?.isEnabled = on
        searchItem?.isEnabled = on
        pageLabel.isUserInteractionEnabled = on
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
    // Single page uses a page-view-controller for proper swipe-paging (the Books
    // feel). Without it, .singlePage renders one page into a mis-sized scroll view
    // (scrollbar into empty space, blank on swipe) — the iteration-2 bug.
    @objc private func toggleLayout() {
        guard pdfView.document != nil else { return }
        isContinuous.toggle()
        let cur = pdfView.currentPage
        if isContinuous {
            pdfView.usePageViewController(false)
            pdfView.displayMode = .singlePageContinuous
            pdfView.displayDirection = .vertical
        } else {
            pdfView.usePageViewController(true, withViewOptions: nil)
            pdfView.displayMode = .singlePage
        }
        pdfView.autoScales = true
        if let cur = cur { pdfView.go(to: cur) }
        layoutItem.image = UIImage(systemName: isContinuous ? "doc.plaintext" : "doc")
    }

    // ── Jump to page ──
    @objc private func jumpTapped() {
        guard let doc = document, doc.pageCount > 0 else { return }
        let total = doc.pageCount
        let ac = UIAlertController(title: "Go to page", message: "1–\(total)", preferredStyle: .alert)
        ac.addTextField { tf in tf.keyboardType = .numberPad; tf.placeholder = "Page number" }
        ac.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        ac.addAction(UIAlertAction(title: "Go", style: .default) { [weak self] _ in
            guard let self = self,
                  let text = ac.textFields?.first?.text, let n = Int(text),
                  n >= 1, n <= total, let pg = doc.page(at: n - 1) else { return }
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
        guard let doc = document else { return }
        let query = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return }
        let matches = doc.findString(query, withOptions: [.caseInsensitive])
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
        guard let doc = document, let cur = pdfView.currentPage else { return 0 }
        return doc.index(for: cur)
    }

    private func updatePageLabel() {
        guard let doc = document else { pageLabel.text = ""; return }
        let total = doc.pageCount
        let idx = currentPageIndex() + 1
        pageLabel.text = total > 0 ? "\(idx) / \(total)" : ""
    }

    // ── Share / close ──
    @objc private func shareTapped() {
        guard let url = loadedFileURL else { return }
        let av = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        av.popoverPresentationController?.barButtonItem = shareItemNav
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
            guard let self = self, self.deleteOnClose, let url = self.loadedFileURL else { return }
            try? FileManager.default.removeItem(at: url)
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if !didReportClose {
            didReportClose = true
            onClose?(currentPageIndex())
            if deleteOnClose, let url = loadedFileURL { try? FileManager.default.removeItem(at: url) }
        }
    }

    deinit { NotificationCenter.default.removeObserver(self) }
}
