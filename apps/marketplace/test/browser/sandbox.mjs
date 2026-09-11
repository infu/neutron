import assert from "node:assert/strict";

/** Match Neutron's iframe permissions: native form submission is unavailable. */
export function sandboxHtml(requestUrl) {
  const url = new URL(requestUrl, "http://127.0.0.1");
  const app = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/main.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/main.js"></script></body></html>';
  if (url.pathname === "/app") return app;
  const source = `/app${url.search}`.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;overflow:hidden"><iframe id="marketplace-app" title="Marketplace" sandbox="allow-scripts allow-same-origin" src="${source}" style="display:block;border:0;width:100vw;height:100vh"></iframe></body></html>`;
}

/** Keep viewport/screenshots on the host, and all UI/read assertions in its app. */
export function sandboxPage(host, errors) {
  const frame = host.frameLocator("#marketplace-app");
  host.on("console", message => {
    if (/blocked.*form|form.*blocked|allow-forms/i.test(message.text())) errors.push(message.text());
  });
  return new Proxy(host, {
    get(target, name) {
      if (name === "assertSandbox") return async () => {
        assert.equal(await host.locator("#marketplace-app").getAttribute("sandbox"), "allow-scripts allow-same-origin");
      };
      if (name === "locator" || String(name).startsWith("getBy")) return frame[name].bind(frame);
      if (name === "evaluate" || name === "waitForFunction") return async (...args) => {
        const app = await host.locator("#marketplace-app").elementHandle().then(element => element.contentFrame());
        return app[name](...args);
      };
      const value = Reflect.get(target, name);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
