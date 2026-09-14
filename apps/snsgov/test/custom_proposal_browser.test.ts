import { expect, test } from "bun:test";
import { serve } from "bun";
import { chromium, type Browser } from "@playwright/test";
import esbuild from "esbuild";
import { access, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";

async function browserOptions() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE };
  const store = await readdir("/nix/store").catch(() => []);
  const candidates = [
    ...store.filter(name => name.endsWith("-playwright-chromium")).sort().map(name => join("/nix/store", name, "chrome-linux64", "chrome")),
    "/run/current-system/sw/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium",
  ];
  for (const executablePath of candidates) {
    try { await access(executablePath, constants.X_OK); return { executablePath }; } catch { /* Next available browser. */ }
  }
  return {};
}

test("custom proposals load the browser compiler from app assets in tile and resident contexts", async () => {
  // Exercise the browser export of icblast and its real Wasm. Node codec tests
  // load the compiler from node_modules and cannot detect a missing web asset.
  const built = await esbuild.build({
    absWorkingDir: fileURLToPath(new URL("../", import.meta.url)),
    stdin: {
      contents: `
        import { buildAndValidate, inspectCustomMethod } from "./src/data/custom_proposal";
        const candidInterface = "service : { execute : (nat64, text, opt principal) -> (); zero : () -> (); }";
        globalThis.buildCustomProposal = async () => {
          const schema = await inspectCustomMethod(candidInterface, "execute");
          const draft = { functionId: 1000n, targetCanisterId: "aaaaa-aa", targetMethodName: "execute", candidInterface };
          const { payload } = await buildAndValidate(draft, ["18446744073709551615", "Custom proposal", "aaaaa-aa"]);
          const zero = await buildAndValidate({ ...draft, targetMethodName: "zero" }, []);
          return { schema, payload: Array.from(payload), zero: Array.from(zero.payload) };
        };
      `,
      resolveDir: fileURLToPath(new URL("../", import.meta.url)),
      sourcefile: "custom-proposal-fixture.ts",
      loader: "ts",
    },
    bundle: true, platform: "browser", format: "esm", minify: true,
    outdir: "browser-test-dist", write: false, loader: { ".bin": "file" },
  });
  const js = built.outputFiles!.find(file => file.path.endsWith(".js"))!.text;
  const assets = new Map(built.outputFiles!.filter(file => file.path.endsWith(".bin")).map(file => [basename(file.path), file.contents]));
  const wasmRequests: { path: string; status: number }[] = [];
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    const headers = { "access-control-allow-origin": "*" };
    if (path.endsWith(".bin")) {
      const bytes = path.startsWith("/app/snsgov/") ? assets.get(path.slice("/app/snsgov/".length)) : undefined;
      const status = bytes ? 200 : 404;
      wasmRequests.push({ path, status });
      // Neutron serves .bin as octet-stream. The real loader must handle it.
      return new Response(bytes ? new Uint8Array(bytes) : "Missing asset", { status, headers: { ...headers, "content-type": "application/octet-stream" } });
    }
    if (["/app/snsgov/main.js", "/app/snsgov/service.js"].includes(path)) {
      return new Response(js, { headers: { ...headers, "content-type": "text/javascript" } });
    }
    if (["/app/snsgov/index.html", "/app/snsgov/service.html"].includes(path)) {
      const script = path.endsWith("service.html") ? "service.js" : "main.js";
      // A different document base also catches URLs resolved against the page
      // instead of the module that owns the emitted asset.
      return new Response(`<base href="/different-base/"><script type="module" src="/app/snsgov/${script}"></script>`, { headers: { "content-type": "text/html" } });
    }
    if (path === "/") {
      const resident = new URL(request.url).searchParams.has("resident");
      return new Response(`<iframe sandbox="allow-scripts${resident ? " allow-same-origin" : ""}" src="/app/snsgov/${resident ? "service" : "index"}.html"></iframe>`, { headers: { "content-type": "text/html" } });
    }
    return new Response("Missing asset", { status: 404 });
  } });
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true, timeout: 15_000, ...await browserOptions() });
    const page = await browser.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const expected = Array.from(new Uint8Array(IDL.encode(
      [IDL.Nat64, IDL.Text, IDL.Opt(IDL.Principal)],
      [18446744073709551615n, "Custom proposal", [Principal.fromText("aaaaa-aa")]],
    )));
    for (const query of ["", "?resident=1"]) {
      await page.goto(`http://127.0.0.1:${server.port}/${query}`);
      const frame = page.frames().find(candidate => candidate.url().includes("/app/snsgov/"))!;
      await frame.waitForFunction(() => typeof (globalThis as any).buildCustomProposal === "function");
      const before = wasmRequests.length;
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await frame.evaluate(() => (globalThis as any).buildCustomProposal());
        expect(result.schema.mode).toBe("update");
        expect(result.schema.argumentSchemas).toHaveLength(3);
        expect(result.payload).toEqual(expected);
        expect(result.zero).toEqual(Array.from(new Uint8Array(IDL.encode([], []))));
      }
      expect(wasmRequests.slice(before)).toEqual([{ path: `/app/snsgov/${[...assets.keys()][0]}`, status: 200 }]);
    }
    expect(errors).toEqual([]);
  } finally {
    server.stop(true);
    await browser?.close();
  }
}, 60_000);
