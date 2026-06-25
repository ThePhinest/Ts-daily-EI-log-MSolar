// swift-tools-version: 5.9
import PackageDescription

// Mirrors the structure of the official @capacitor/* SPM plugins (see
// node_modules/@capacitor/share/Package.swift). `npx cap sync ios` discovers
// this package from the app's package.json `capacitor.ios.src` and adds it to
// ios/App/CapApp-SPM/Package.swift automatically — do not wire it by hand.
// NOTE: the package + product name MUST be "GroundlogPdf" (lowercase "l").
// `npx cap sync ios` derives the SPM name from the npm package name
// "groundlog-pdf" → "Groundlog" + "Pdf" = "GroundlogPdf", and references that
// exact product in ios/App/CapApp-SPM/Package.swift. A mismatch ("GroundLogPdf")
// fails the build with "product 'GroundlogPdf' not found". The JS-facing name is
// separate — it's `jsName = "GroundLogPdf"` in the Swift plugin class.
let package = Package(
    name: "GroundlogPdf",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "GroundlogPdf",
            targets: ["GroundLogPdfPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "GroundLogPdfPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/GroundLogPdfPlugin")
    ]
)
