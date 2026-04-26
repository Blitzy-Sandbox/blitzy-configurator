import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite configuration for the StrikeForge 3D sports ball configurator frontend.
 *
 * Authority: AAP §0.3.4 (file inventory), §0.4.2 (frontend dependencies),
 * §0.4.6 (no barrel files in hot paths — tree-shaking is critical),
 * and §0.6.2 (Phase A scaffolding).
 *
 * Operational responsibilities of this config:
 *
 * 1. Dev server (`npm run dev`) — binds to `127.0.0.1:5173` so Playwright's
 *    `webServer.url: 'http://localhost:5173'` resolves through the loopback
 *    interface without exposing the dev server on other network interfaces.
 *    `strictPort: true` ensures we fail loudly if 5173 is already taken
 *    rather than silently rolling forward to 5174 (which would break the
 *    Playwright `baseURL` assumption and any AAP-documented gate command).
 *
 * 2. Production build (`npm run build`) — emits to `frontend/dist/`. The
 *    multi-stage Dockerfile copies this directory into the nginx production
 *    stage (`COPY --from=builder /app/dist /usr/share/nginx/html`).
 *
 * 3. JSX transform — `@vitejs/plugin-react` enables the React 18
 *    `react-jsx` automatic transform (matching `frontend/tsconfig.json`'s
 *    `"jsx": "react-jsx"`) and React Fast Refresh during development.
 *
 * 4. Vendor chunk splitting — Three.js + R3F, Fabric.js, Firebase, and
 *    React/Zustand are split into their own cacheable bundles via
 *    `rollupOptions.output.manualChunks`. This keeps initial parse small
 *    and lets browsers cache the heavy 3D/canvas bundles independently
 *    of the application code.
 *
 * 5. Dependency pre-bundling — `optimizeDeps.include` lists every heavy
 *    dependency by explicit package name so Vite's pre-bundler does not
 *    walk barrel files (forbidden in hot paths per AAP §0.4.6).
 *
 * Security and explicitness notes:
 *
 * - No `define` block exposing process.env values. Vite's `VITE_`-prefix
 *   convention (read via `import.meta.env`) is the only safe channel
 *   for client-visible environment values.
 *
 * - No `proxy` config for `/api`. The frontend uses absolute URLs
 *   sourced from `import.meta.env.VITE_API_BASE_URL` so that local CORS
 *   behavior matches production (where the frontend and backend are
 *   served from different origins).
 *
 * - No `resolve.alias` block. Per AAP §0.4.6 the frontend uses explicit
 *   relative imports across `frontend/src/configurator/**` and
 *   `frontend/src/features/**`; aliases are not introduced here.
 *
 * - Source maps are emitted in production for triaging customer-reported
 *   issues against the deployed bundle.
 */
export default defineConfig({
  plugins: [react()],

  server: {
    // Pin the dev port so Playwright's baseURL assumption holds across
    // every CI run. `strictPort` makes a port collision a hard failure.
    port: 5173,
    strictPort: true,
    // Bind to loopback only — prevents accidental network exposure of the
    // dev server. `localhost` resolves to 127.0.0.1 in the OS resolver,
    // so Playwright's `http://localhost:5173` baseURL still works.
    host: '127.0.0.1',
    // Developers may run multiple Vite instances; do not auto-open a tab.
    open: false,
  },

  preview: {
    // `vite preview` serves the production build for local smoke testing.
    port: 4173,
    strictPort: true,
    host: '127.0.0.1',
  },

  build: {
    // Matches the Dockerfile's `COPY --from=builder /app/dist` instruction.
    outDir: 'dist',
    // Emit dist alongside the build artifacts for production triage.
    sourcemap: true,
    // ES2020 enables `??`, `?.`, `BigInt`, etc. — required by Three.js
    // and R3F internals; targeting `modules` (ES2017) is too conservative.
    target: 'es2020',
    // Three.js + R3F minified is ~600 KB; the default 500 KB warning
    // would fire on every build. Raise the limit so warnings remain
    // signal rather than noise. Anything above this threshold is a
    // real regression worth investigating.
    chunkSizeWarningLimit: 1024,
    // Fail-closed posture per Rule R8: if a build error occurs we want
    // a non-zero exit — Vite's default behavior already does this, but
    // we keep `emptyOutDir: true` so stale chunks from a previous build
    // never leak into a new dist tree.
    emptyOutDir: true,
    rollupOptions: {
      output: {
        /**
         * Manual chunk strategy: split heavy vendor bundles so the
         * application code chunk stays small and individual vendor
         * bundles (Three.js, Fabric.js, Firebase, React) can be cached
         * independently across deploys.
         *
         * The function intentionally returns `undefined` for non-
         * `node_modules` modules so Rollup applies its default chunking
         * (one chunk per dynamic import boundary) for application code.
         * Returning `undefined` is allowed by Rollup's `GetManualChunk`
         * type signature: `string | null | undefined | void`.
         *
         * Order matters: more specific patterns first so a package like
         * `react-three-fiber` (containing both `react` and `three`) is
         * captured by the `three-vendor` rule rather than the
         * `react-vendor` rule.
         */
        manualChunks: (id: string): string | undefined => {
          // Application code is left to Rollup's default chunking.
          if (!id.includes('node_modules')) {
            return undefined;
          }

          // Three.js core + the React Three Fiber binding + drei helpers.
          if (id.includes('three') || id.includes('@react-three')) {
            return 'three-vendor';
          }

          // Fabric.js canvas library used for the texture pipeline.
          if (id.includes('fabric')) {
            return 'fabric-vendor';
          }

          // Firebase client SDK (auth + app modules used in the browser).
          if (id.includes('firebase')) {
            return 'firebase-vendor';
          }

          // React, ReactDOM, and the Zustand state store — small but
          // shared across virtually every code path; isolating them
          // makes the application chunk's hash more stable across
          // releases that touch only feature code.
          if (id.includes('react') || id.includes('zustand')) {
            return 'react-vendor';
          }

          // Everything else from node_modules lands in a generic vendor
          // chunk so it is still cacheable and never leaks into the
          // application chunk.
          return 'vendor';
        },
      },
    },
  },

  optimizeDeps: {
    /**
     * Pre-bundle the heavy dependencies during the dev server's first
     * launch so subsequent reloads are near-instantaneous.
     *
     * Listing packages by explicit name avoids triggering Vite's
     * automatic dependency discovery on barrel files, which AAP §0.4.6
     * forbids in hot paths because they break tree-shaking.
     */
    include: [
      'react',
      'react-dom',
      'three',
      '@react-three/fiber',
      '@react-three/drei',
      'fabric',
      'firebase/app',
      'firebase/auth',
      'zustand',
    ],
  },
});
