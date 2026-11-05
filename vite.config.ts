import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  server: {
    port: 3000,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        // Keep the page origin as Host: the Worker's same-origin gate compares
        // Origin/Referer against the request URL, so rewriting Host to :8787
        // would 403 every same-origin POST (and anything sending a Referer).
        changeOrigin: false,
      },
      '/ws-signaling': {
        target: 'ws://127.0.0.1:8787',
        ws: true,
        // Keep the page origin as Host so the Worker's same-origin gate sees a
        // matching Origin (browsers always send Origin on WebSocket upgrades).
        changeOrigin: false,
      },
    },
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    }
  },
  build: {
    target: 'esnext',
    minify: 'oxc',
    cssCodeSplit: true,
    chunkSizeWarningLimit: 1000
  }
});
