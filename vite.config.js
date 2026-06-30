import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { sentryVitePlugin } from '@sentry/vite-plugin'
import { viteStaticCopy } from 'vite-plugin-static-copy'

export default defineConfig({
  base: '/',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    // Conservative source-map posture (locked 2026-05-06): emit maps to dist/,
    // upload to Sentry, leave deployed publicly. Aggressive flip ('hidden' +
    // minify:true + delete-after-upload) is captured in dependency-watch.md
    // Outstanding Items as a focused follow-up session within ~2 weeks.
    sourcemap: true,
  },
  plugins: [
    // PDF.js auxiliary assets (Documents library): copied to dist/pdfjs/ so the
    // viewer can decode JPEG2000/JBIG2 images (wasm), embedded ICC color (iccs),
    // CJK text (cmaps), and non-embedded standard fonts. docs.js points
    // getDocument() at these dirs. Without them pdfjs warns "OpenJPEG failed to
    // initialize" and embedded raster images render blank.
    viteStaticCopy({
      // stripBase:true flattens the matched files into dest (this plugin version
      // otherwise preserves the full node_modules/... path). The pdfjs asset
      // dirs are flat, so flattening is exact.
      targets: [
        { src: 'node_modules/pdfjs-dist/wasm/*',           dest: 'pdfjs/wasm',           rename: { stripBase: true } },
        { src: 'node_modules/pdfjs-dist/iccs/*',           dest: 'pdfjs/iccs',           rename: { stripBase: true } },
        { src: 'node_modules/pdfjs-dist/cmaps/*',          dest: 'pdfjs/cmaps',          rename: { stripBase: true } },
        { src: 'node_modules/pdfjs-dist/standard_fonts/*', dest: 'pdfjs/standard_fonts', rename: { stripBase: true } },
      ],
    }),
    VitePWA({
      registerType: 'prompt',
      injectRegister: null,
      manifest: false,
      workbox: {
        // clientsClaim so that when the waiting SW skip-waits (RELOAD button posts
        // SKIP_WAITING), it immediately CLAIMS the open page → `controllerchange`
        // fires deterministically and the reload sticks. Without this, skipWaiting
        // activates the new SW but doesn't claim the current client, controllerchange
        // never fires, the blind 1.5s fallback reloads before the new SW is in
        // control, and the "App updated" banner re-fires forever (the stuck-banner
        // loop). skipWaiting stays false — the prompt still controls WHEN we update.
        clientsClaim: true,
        // Source maps (.map) deliberately NOT in globPatterns — Workbox precache
        // skips them; browsers fetch on-demand from server when DevTools opens.
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
        // Cap raised 5 MB → 7 MB on 2026-05-06 because Sentry SDK push pre-tipped
        // an already-near-cap unminified bundle (~5,020 → ~5,494 KiB main).
        // Temporary — comes back down once polish phase #5 (bundle splitting:
        // mapbox-gl/docx/exifr lazy-loaded) lands and once minify:true is
        // enabled in the Aggressive source-maps follow-up. Tracked in
        // groundlog/wiki/dependency-watch.md Outstanding Items.
        maximumFileSizeToCacheInBytes: 7 * 1024 * 1024,
        runtimeCaching: [
          {
            // Inline array — closure vars aren't available in the serialized SW context
            urlPattern: ({ url }) => ['gstatic.com','googleapis.com','firebaseapp.com','firebasestorage.app','mapbox.com','cdn.jsdelivr.net','anthropic.com'].some(d => url.hostname.includes(d)),
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
    // Sentry source map upload — runs LAST so it sees all emitted .map files.
    // Without SENTRY_AUTH_TOKEN, the plugin is a no-op (logs a warning, doesn't
    // fail the build) — local builds and forks work without a token.
    sentryVitePlugin({
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      // Tag the release so issues correlate with a specific TestFlight/web build.
      // CI passes GITHUB_RUN_NUMBER (matches Fastlane's CFBundleVersion); local
      // builds fall back to a 'local' tag.
      release: {
        name: process.env.GITHUB_RUN_NUMBER
          ? `groundlog@1.0.0+${process.env.GITHUB_RUN_NUMBER}`
          : 'groundlog@local',
      },
      // Privacy posture — opt out of Sentry's internal usage telemetry.
      telemetry: false,
      // No-op when auth token absent (local dev, fork builds).
      disable: !process.env.SENTRY_AUTH_TOKEN,
    }),
  ],
})
