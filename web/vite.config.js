import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { managerMockPlugin } from './src/mocks/devServer.js'

// Set VITE_MANAGER_MOCK=0 to develop against a real manager daemon running
// on 127.0.0.1:8321 instead of the built-in fake backend.
const useMock = process.env.VITE_MANAGER_MOCK !== '0'

export default defineConfig({
  plugins: [vue(), ...(useMock ? [managerMockPlugin()] : [])],
  base: '/',
  // Stable, unhashed bundle names: dist/ is committed, and content hashes would
  // add a new file plus an index.html rewrite on every build. The manager sends
  // no-cache for /static/, so the browser revalidates instead of cache-busting.
  build: {
    outDir: 'dist',
    assetsDir: 'static',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'static/[name].js',
        chunkFileNames: 'static/[name].js',
        assetFileNames: 'static/[name][extname]',
      },
    },
  },
  server: {
    proxy: useMock
      ? {}
      : // ws: true so the mirror's /api/status/ws upgrade reaches the daemon
        // (which tunnels it on to the bar) instead of hitting Vite's own HMR ws.
        ['/api', '/events'].reduce(
          (a, p) => ((a[p] = { target: 'http://127.0.0.1:8321', ws: p === '/api' }), a),
          {}
        ),
  },
})
