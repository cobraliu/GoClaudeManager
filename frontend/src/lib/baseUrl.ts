/// <reference types="vite/client" />
/**
 * Sub-path mount support — emit URLs with the build-configured base prefix.
 *
 * `import.meta.env.BASE_URL` is Vite's built-in, derived from the
 * `base` option in vite.config.ts (which itself reads VITE_BASE).
 * Always ends with "/". Examples:
 *   - default build:                    BASE_URL = "/"
 *   - VITE_BASE=/rosaccm/ npm run build BASE_URL = "/rosaccm/"
 *
 * apiPath("/api/foo") returns the path the browser should hit so nginx
 * can route it back to us. WS URLs returned by the backend already include
 * the ROOT_PATH prefix server-side (see app/url_prefix.py), so callers that
 * receive ws_url from API responses don't need to call apiPath on it.
 * Use apiPath only when constructing the path client-side (fetch, or WS
 * URLs the frontend builds itself like fs/watch).
 */

const BASE: string = import.meta.env.BASE_URL || "/";

export function apiPath(path: string): string {
  // Strip the leading slash from `path` so we can concatenate against
  // BASE_URL (which always ends with "/"). Avoids "//" when BASE is "/".
  const trimmed = path.startsWith("/") ? path.slice(1) : path;
  return BASE + trimmed;
}
