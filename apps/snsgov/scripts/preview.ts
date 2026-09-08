/**
 * Local design preview.
 *
 * Serves `dist/web` and proxies `/api/*` to an IC boundary node, so the page's
 * own origin behaves exactly as it does in production — where the app is served
 * from `i<nonce>--<canister>.icp0.io`, which *is* a boundary node. That means
 * the data layer needs no dev switch and no mocking: it makes the same
 * anonymous queries it will make when installed.
 *
 * Kernel-mediated calls (querySelf, copyToClipboard) do not work here — there
 * is no Kernel parent frame — so the Setup page is expected to show its error
 * state. Everything read-only renders for real.
 *
 *   bun run scripts/preview.ts [port]
 */
import { file, serve } from "bun";

const port = Number(process.argv[2] ?? 8912);
const root = new URL("../dist/web/", import.meta.url).pathname;
const UPSTREAM = "https://icp-api.io";

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};

serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      const upstream = new Request(`${UPSTREAM}${url.pathname}${url.search}`, {
        method: request.method,
        headers: { "content-type": request.headers.get("content-type") ?? "application/cbor" },
        // `exactOptionalPropertyTypes` rejects an explicit `undefined` body.
        ...(hasBody ? { body: await request.arrayBuffer() } : {}),
      });
      const response = await fetch(upstream);
      return new Response(response.body, { status: response.status, headers: response.headers });
    }

    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const asset = file(root + path.replace(/^\//, ""));
    if (!(await asset.exists())) return new Response("not found", { status: 404 });
    const extension = path.slice(path.lastIndexOf("."));
    return new Response(asset, {
      headers: { "content-type": types[extension] ?? "application/octet-stream" },
    });
  },
});

console.log(`preview on http://127.0.0.1:${port} (proxying /api/* to ${UPSTREAM})`);
