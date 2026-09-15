import { defineConfig } from "vite";

// Mirror of the Cloudflare `_headers` rules for vite preview so a
// freshly-built sw.js bypasses the browser's 24-hour update rule.
const noCacheForServiceWorker = {
  name: "no-cache-for-sw",
  configurePreviewServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = req.url ?? "";
      if (url === "/sw.js" || url === "/index.html" || url === "/") {
        res.setHeader("Cache-Control", "no-cache");
      }
      next();
    });
  },
};

export default defineConfig({
  build: {
    chunkSizeWarningLimit: 1000,
  },
  worker: {
    format: "es",
  },
  server: {
    headers: {
      // `credentialless` keeps SharedArrayBuffer + OPFS available while still
      // allowing cross-origin resources (tile servers, preset preview tiles)
      // that don't send CORP/CORS — they're loaded without credentials.
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
  },
  optimizeDeps: {
    exclude: ["mbtiles-reader", "@sqlite.org/sqlite-wasm"],
    // mbtiles-reader is excluded (so sqlite-wasm keeps its real import.meta.url
    // for locating sqlite3.wasm + the OPFS proxy), which also leaves its
    // CommonJS sub-dep @mapbox/tiletype unconverted. Force it through dep
    // optimization so the worker can load it as ESM in dev.
    include: ["@mapbox/tiletype"],
  },
  plugins: [noCacheForServiceWorker],
});
