import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite config — armada-dashboard.
 *
 * THE PROXY BLOCK IS NOT A CONVENIENCE. Neither armada-daemon (`node:http`, hand-rolled)
 * nor armada-forge (FastAPI) emits a single CORS header, and neither handles an `OPTIONS`
 * preflight — a preflight to the daemon falls through its dispatch chain and 404s. The
 * dashboard is therefore required to be same-origin with both services. In production
 * nginx does that (services/dashboard/nginx.conf); in `vite dev` this does, and the two
 * MUST declare the same three prefixes or a surface that works in dev 404s in the image.
 *
 * Adding CORS to the daemon was the alternative and is worse: it would put an
 * origin-allowlist decision into a service whose whole security posture is "trusted
 * network, one host, no auth", to solve a problem that only exists because of how the
 * dev server is served.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      // The daemon owns /api/* and /ws.
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8080', ws: true },
      // The forge is reached under a /forge prefix that is stripped on the way through,
      // because its routes are declared at the root (`/corpora`, `/models/bindings`) and
      // would otherwise collide with the SPA's own paths.
      '/forge': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/forge/, ''),
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
