/// <reference types="vitest/config" />
import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';

/**
 * PWA (SPEC §7): injectManifest with our own service worker (src/sw.ts → dist/sw.js). Registration is
 * done by src/pwa/UpdatePrompt.tsx through `virtual:pwa-register` (prompt flow: a new version waits
 * until the user taps "Reload" in the update toast). Disabled in dev and under Vitest.
 */
function pwa(): PluginOption {
  return VitePWA({
    strategies: 'injectManifest',
    srcDir: 'src',
    filename: 'sw.ts',
    registerType: 'prompt',
    injectRegister: false,
    manifest: {
      id: '/',
      name: 'Tasks',
      short_name: 'Tasks',
      description: 'Your tasks on a Notion-style calendar.',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      orientation: 'any',
      background_color: '#191919',
      theme_color: '#191919',
      lang: 'en',
      dir: 'ltr',
      categories: ['productivity'],
      icons: [
        { src: 'pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: 'maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    // Images precached alongside the manifest icons (which are included automatically). iOS launch
    // images (public/splash) are read once, when the app is added to the Home Screen — not precached.
    includeAssets: ['favicon.svg', 'favicon-32.png', 'apple-touch-icon.png', 'badge-96.png'],
    injectManifest: {
      // App shell + every lazy chunk (the Firebase SDK chunks too, so a cold offline launch works).
      globPatterns: ['**/*.{js,css,html,woff2}'],
      maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      // Classic (non-module) worker: widest support, incl. older iOS.
      rollupFormat: 'iife',
    },
    devOptions: { enabled: false },
  });
}

export default defineConfig({
  plugins: [react(), process.env.VITEST ? null : pwa()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  build: {
    // The lazily-loaded Firebase SDK chunk is ~540 kB minified on its own; nothing to split further.
    chunkSizeWarningLimit: 800,
  },
  server: { port: 5173, strictPort: true, host: true },
  preview: { port: 4173, strictPort: true, host: true },
  test: {
    environment: 'node',
    include: ['shared/**/*.test.ts', 'src/**/*.test.{ts,tsx}', 'functions/src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    setupFiles: [],
  },
});
