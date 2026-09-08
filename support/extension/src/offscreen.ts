// Network fetches run in a dedicated worker, not in the MV3 service worker.
// This avoids Chrome's service-worker deadline while waiting for HTTP headers.
const worker = new Worker("network-worker.js", { type: "module" });
let port: ChromePort;
let reconnect: ReturnType<typeof setTimeout> | undefined;

function connect() {
  port = chrome.runtime.connect({ name: "neutron-network-worker" });
  port.onMessage.addListener(message => worker.postMessage(message));
  port.onDisconnect.addListener(() => {
    // The client ports cannot survive service-worker termination. Abort rather
    // than replaying requests whose remote effects may already have occurred.
    worker.postMessage({ id: "reset", op: "reset" });
    if (reconnect === undefined) reconnect = setTimeout(() => { reconnect = undefined; connect(); }, 0);
  });
}
worker.addEventListener("message", event => { try { port.postMessage(event.data); } catch { /* Disconnect handler resets transfers. */ } });
connect();
