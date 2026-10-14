import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Ask before activating a new version: never reload under someone playing along.
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'BarreFree',
        short_name: 'BarreFree',
        description: 'Turn any song into barre-free acoustic guitar chords.',
        lang: 'en',
        theme_color: '#111214',
        background_color: '#111214',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The app shell (incl. the chord library inside the JS bundle) is precached, so text
        // mode works offline.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // The tab renderer (alphaTab, about 1.1 MB, and its 0.3 MB music font) is not part of
        // the shell: it is cached the first time a tab is shown, then works offline too.
        globIgnores: ['**/assets/alphaTab-*.js', '**/assets/Bravura-*.woff2'],
        runtimeCaching: [
          {
            urlPattern: /\/assets\/(alphaTab-[^/]*\.js|Bravura-[^/]*\.woff2)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'tab-renderer',
              expiration: { maxEntries: 4 },
            },
          },
        ],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        navigateFallback: '/index.html',
        // API calls must always go to the network.
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  build: {
    // The licenses of every bundled package, served next to the app (linked in its footer),
    // and the license comments of the bundled code kept in it (alphaTab's MPL-2.0 notice and
    // the MIT/BSD notices of the libraries it integrates).
    license: { fileName: 'third-party/licenses.md' },
    rolldownOptions: { output: { comments: { legal: true } } },
  },
  server: {
    // During development the FastAPI analyzer runs on :8000.
    proxy: { '/api': 'http://localhost:8000' },
  },
  preview: {
    proxy: { '/api': 'http://localhost:8000' },
  },
})
