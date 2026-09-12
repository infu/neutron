/** Mirrors the production tile's iframe capabilities, including no native forms. */
export function sandboxHtml(requestUrl) {
  const url = new URL(requestUrl, "http://127.0.0.1");
  if (url.pathname === "/app") return '<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{margin:0;height:100%;background:#06080b}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>';
  const source = `/app${url.search}`.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;overflow:hidden"><iframe id="feedback-app" title="Feedback" sandbox="allow-scripts allow-same-origin" src="${source}" style="display:block;border:0;width:100vw;height:100vh"></iframe></body></html>`;
}

export function sandboxPage(host, errors) {
  const frame = host.frameLocator("#feedback-app");
  host.on("console", message => {
    if (/blocked.*form|form.*blocked|allow-forms/i.test(message.text())) errors.push(message.text());
  });
  return new Proxy(host, {
    get(target, name) {
      if (name === "locator" || String(name).startsWith("getBy")) return frame[name].bind(frame);
      if (name === "evaluate" || name === "waitForFunction") return async (...args) => {
        const app = await host.locator("#feedback-app").elementHandle().then(element => element.contentFrame());
        return app[name](...args);
      };
      const value = Reflect.get(target, name);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
