import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const EXTERNAL_DOMAINS = [
  'gstatic.com',
  'googleapis.com',
  'firebaseapp.com',
  'firebasestorage.app',
  'mapbox.com',
  'cdn.jsdelivr.net',
  'anthropic.com',
]

export default defineConfig({
  base: '/',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
  },
  plugins: [
    VitePWA({
      registerType: 'prompt',
      injectRegister: null,
      manifest: false,
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => EXTERNAL_DOMAINS.some(d => url.hostname.includes(d)),
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
})
