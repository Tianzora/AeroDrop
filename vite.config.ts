import path from 'path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const CF_WEB_ANALYTICS_SNIPPET =
  '<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon=\'{"token":"e981fda9d57846adb2ddf5216658c889"}\'></script>';

/**
 * 只在生产构建注入 Cloudflare Web Analytics（无 cookie，页面浏览量统计）。
 * dev 与 mode=e2e 的构建不注入，避免本地和 E2E 往真实站点报数。
 */
const cloudflareWebAnalytics = (): Plugin => ({
  name: 'aerodrop:cf-web-analytics',
  apply: 'build',
  transformIndexHtml: {
    order: 'post',
    handler: (html) => html.replace('</head>', `  ${CF_WEB_ANALYTICS_SNIPPET}\n  </head>`),
  },
});

export default defineConfig(({ mode }) => ({
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
  plugins: [react(), tailwindcss(), ...(mode === 'production' ? [cloudflareWebAnalytics()] : [])],
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
}));
