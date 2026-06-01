import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Public base path. Defaults to "/" (root mount: subdomain or direct port).
// Set VITE_BASE=/rosaccm/ at build time when deploying behind a sub-path
// reverse proxy. Must match the backend's ROOT_PATH env var and the nginx
// `location /rosaccm/` prefix. Trailing slash required for Vite.
const BASE = process.env.VITE_BASE || "/";

export default defineConfig({
  base: BASE,
  plugins: [react()],
  build: {
    // Split heavy vendor libs into separate chunks so they can be cached
    // independently of app code and downloaded in parallel.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("highlight.js")) return "vendor-hljs";
          if (id.includes("@xterm")) return "vendor-xterm";
          if (id.includes("/marked/") || id.includes("/dompurify/") || id.includes("/markdown-it/")) return "vendor-md";
          // Note: do NOT group mermaid/cytoscape/d3 into a single chunk —
          // Vite splits them per-diagram so they stay lazy. Forcing them into
          // one chunk makes the whole group eagerly loaded.
          if (id.includes("/react") || id.includes("/scheduler/")) return "vendor-react";
        },
      },
    },
  },
  server: {
    // Proxy entries are matched on the URL the browser actually sends. With
    // BASE="/rosaccm/", `apiPath("/api/foo")` emits `/rosaccm/api/foo`; we
    // need a proxy key for that prefixed path AND a rewrite that strips the
    // base back to bare `/api/foo` (the backend is unaware of the prefix).
    // When BASE="/" the prefixed entries collapse to plain `/api` and `/ws`.
    proxy: {
      [`${BASE}api`]: {
        target: "http://localhost:19099",
        rewrite: (p: string) =>
          BASE === "/" ? p : p.replace(new RegExp(`^${BASE}`), "/"),
      },
      [`${BASE}ws`]: {
        target: "ws://localhost:19099",
        ws: true,
        rewrite: (p: string) =>
          BASE === "/" ? p : p.replace(new RegExp(`^${BASE}`), "/"),
      },
    },
  },
});
