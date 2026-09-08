import { BRIDGE_PORT, CHANNEL } from "./protocol";

// Apps run in frames. Only messages from this top-level page are forwarded.
if (window === window.top) {
  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== CHANNEL || event.data?.type !== "connect") return;
    const pagePort = event.ports[0];
    if (!pagePort) return;
    let runtimePort: ChromePort;
    try { runtimePort = chrome.runtime.connect({ name: BRIDGE_PORT }); }
    catch {
      pagePort.postMessage({ type: "disconnected", error: { code: "EXTENSION_DISCONNECTED", message: "Reload this Neutron page to connect the updated extension." } });
      pagePort.close();
      return;
    }
    let live = true;
    const disconnect = () => {
      if (!live) return;
      live = false;
      pagePort.postMessage({ type: "disconnected", error: { code: "EXTENSION_DISCONNECTED", message: chrome.runtime.lastError?.message ?? "The browser extension disconnected. Reconnect before starting another request." } });
      pagePort.close();
      window.removeEventListener("pagehide", unload);
    };
    const unload = () => { runtimePort.disconnect(); disconnect(); };
    runtimePort.onMessage.addListener(message => { if (live) pagePort.postMessage(message); });
    runtimePort.onDisconnect.addListener(disconnect);
    pagePort.onmessage = message => {
      if (!live) return;
      if (message.data?.type === "disconnect") { unload(); return; }
      try { runtimePort.postMessage(message.data); } catch { disconnect(); }
    };
    pagePort.onmessageerror = unload;
    pagePort.start();
    window.addEventListener("pagehide", unload, { once: true });
  });
}
