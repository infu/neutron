import { NetworkTransfers } from "./network";
import { errorReply } from "./protocol";
const transfers = new NetworkTransfers();

globalThis.addEventListener("message", (event: MessageEvent) => {
  const { id, op, key, request, chunkBase64 } = event.data;
  void (async () => {
    try {
      let result: unknown;
      if (op === "fetch") result = await transfers.start(key, request);
      else if (op === "read") result = await transfers.read(key);
      else if (op === "upload") result = transfers.upload(key, chunkBase64);
      else if (op === "cancel") result = transfers.cancel(key);
      else if (op === "reset") { transfers.cancelAll(); result = {}; }
      else throw new Error("Unknown network-worker operation.");
      globalThis.postMessage({ id, ok: true, result });
    } catch (error) { globalThis.postMessage(errorReply(id, error)); }
  })();
});
