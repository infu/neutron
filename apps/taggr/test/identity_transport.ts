// Exercise the real SDK/private port and Kernel Candid adapter in a separate
// process: unit-test mocks of neutron-tools/app must not mask wire regressions.
// All keys are generated test fixtures. No network or production identity reads.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { IDL } from "@dfinity/candid";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import { extractPublicTypeAliases, motokoTypeToIdl } from "neutron-scripts/src/method_schema.js";
import { disconnectMsgBus, installMessageListener } from "neutron-tools/app";
import { encodeSelfCallResult, materializeSelfCallArguments, normalizeSelfCallResult } from "neutron-kernel/src/self_calls.ts";
import * as identity from "../src/identity.ts";
import * as store from "../src/identity_store.ts";
import { hydrateIdentity, identitySync } from "../src/identity_sync.ts";

const aliases = extractPublicTypeAliases(readFileSync(new URL("../backend/main.mo", import.meta.url), "utf8"));
const methodType = (method: string, direction: "Input" | "Output") =>
  motokoTypeToIdl(aliases[`${method}_${direction}`]!, IDL, aliases);
const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
} });
const parent = {};
const listeners: Array<(event: MessageEvent) => void> = [];
const canisterId = "4caro-hl777-77775-aaaba-cai";
const kernelOrigin = `https://${canisterId}.icp0.io`;
const fakeWindow = {
  parent, origin: "null", location: { href: `https://ataggra--${canisterId}.icp0.io/app/taggr/service.html` },
  addEventListener(type: string, callback: (event: MessageEvent) => void) {
    if (type === "message") listeners.push(callback);
  },
};
Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
installMessageListener(fakeWindow as unknown as Window);
const channel = new MessageChannel();
for (const callback of listeners) callback({
  source: parent, origin: kernelOrigin,
  data: { type: "neutron:msgbus:connect", version: 1, sessionId: "0123456789abcdef0123456789abcdef" },
  ports: [channel.port1],
} as unknown as MessageEvent);

const empty = () => ({
  secret_key: [] as [] | [Uint8Array], canister_id: [] as [] | [string], domain: [] as [] | [string],
  revision: 0n, created_at: 0n, updated_at: 0n,
});
let state = empty();
let competingKey: Uint8Array | null = null;
const calls: string[] = [];
channel.port2.addEventListener("message", (event) => {
  const request = event.data;
  if (request.type !== "neutron:self-call:exec") return;
  calls.push(request.method);
  try {
    const bound = materializeSelfCallArguments(request.args, request.blobs, [methodType(request.method, "Input")]);
    const arg = bound.args[0] as { secret_key: Uint8Array; canister_id: string; domain: string | null };
    let result: unknown;
    switch (request.method) {
      case "taggr_state_read": result = state; break;
      case "taggr_identity_initialize":
        if (competingKey) { state.secret_key = [competingKey]; competingKey = null; }
        if (state.secret_key.length === 0) { state.secret_key = [arg.secret_key]; state.revision++; }
        result = { ok: state };
        break;
      case "taggr_identity_write":
        state.secret_key = [arg.secret_key]; state.revision++;
        result = { ok: state };
        break;
      case "taggr_identity_clear": state.secret_key = []; state.revision++; result = state; break;
      case "taggr_settings_write":
        state.canister_id = [arg.canister_id]; state.domain = arg.domain === null ? [] : [arg.domain];
        state.revision++; result = { ok: state }; break;
      default: throw new Error("Unexpected test method");
    }
    const type = methodType(request.method, "Output");
    const decoded = IDL.decode([type], IDL.encode([type], [result]))[0];
    const output = encodeSelfCallResult(normalizeSelfCallResult(decoded, type));
    channel.port2.postMessage({ type: "neutron:self-call:response", version: 1, id: request.id, ok: output.value, blobs: output.blobs }, output.blobs.map(blob => blob.data));
  } catch (error) {
    channel.port2.postMessage({ type: "neutron:self-call:response", version: 1, id: request.id,
      error: { code: "TEST_BACKEND_ERROR", message: error instanceof Error ? error.message : String(error) } });
  }
});
channel.port2.start();

const clearBrowser = () => { storage.clear(); identity.forgetCachedIdentity(); calls.length = 0; };
const deadline = setTimeout(() => { console.error("Taggr identity transport did not complete"); process.exit(1); }, 15_000);
try {
  // Empty Candid options are omitted from records by the Kernel, not [].
  assert.deepEqual(await store.readStored(), { secretKey: null, canister: null, domain: null, revision: 0 });

  const existing = Ed25519KeyIdentity.generate();
  state = { ...empty(), secret_key: [identity.secretKeyBytes(existing)], revision: 3n };
  clearBrowser();
  assert.equal((await hydrateIdentity()).getPrincipal().toText(), existing.getPrincipal().toText());
  assert.equal((await store.readStored()).revision, 3);
  assert.deepEqual(calls, ["taggr_state_read", "taggr_state_read"]);
  assert.deepEqual(identitySync(), { stored: true, error: null });

  // Import browser-only accounts using conditional initialization, unchanged.
  state = empty(); calls.length = 0;
  assert.equal((await hydrateIdentity()).getPrincipal().toText(), existing.getPrincipal().toText());
  assert.deepEqual(state.secret_key, [identity.secretKeyBytes(existing)]);
  assert.deepEqual(calls, ["taggr_state_read", "taggr_identity_initialize"]);

  state = empty(); clearBrowser();
  const created = await hydrateIdentity();
  assert.deepEqual(state.secret_key, [identity.secretKeyBytes(created)]);
  assert.deepEqual(calls, ["taggr_state_read", "taggr_identity_initialize"]);
  clearBrowser();
  assert.equal((await hydrateIdentity()).getPrincipal().toText(), created.getPrincipal().toText());
  assert.deepEqual(calls, ["taggr_state_read"]);

  // Two cold browsers must adopt the first committed key, not their proposal.
  state = empty(); clearBrowser(); competingKey = identity.secretKeyBytes(existing);
  assert.equal((await hydrateIdentity()).getPrincipal().toText(), existing.getPrincipal().toText());
  assert.deepEqual(calls, ["taggr_state_read", "taggr_identity_initialize"]);

  for (const domain of ["taggr.link", null]) {
    const saved = await store.writeStoredSettings({ canister: identity.TAGGR_MAINNET_CANISTER, domain });
    assert.equal(saved.domain, domain);
    clearBrowser();
    assert.equal((await hydrateIdentity()).getPrincipal().toText(), existing.getPrincipal().toText());
    assert.deepEqual(identity.loadSettings(), { canister: identity.TAGGR_MAINNET_CANISTER, domain });
    assert.deepEqual(calls, ["taggr_state_read"]);
  }

  // A present invalid key remains an error, never permission to initialize.
  state.secret_key = [new Uint8Array(16)]; clearBrowser();
  await assert.rejects(hydrateIdentity(), /unexpected length/);
  assert.deepEqual(calls, ["taggr_state_read"]);
  assert.equal(identity.peekIdentity(), null);
  assert.equal(identitySync().error?.includes("could not be reached"), false);
  assert.equal(state.secret_key[0]?.length, 16);

  assert.deepEqual((await store.writeStoredIdentity(identity.secretKeyBytes(existing))).secretKey, identity.secretKeyBytes(existing));
  clearBrowser();
  assert.equal((await hydrateIdentity()).getPrincipal().toText(), existing.getPrincipal().toText());
  assert.deepEqual(calls, ["taggr_state_read"]);
  assert.equal((await store.clearStoredIdentity()).secretKey, null);
  console.log("Taggr identity transport passed: Candid → Kernel → private MessagePort → SDK; restore, first initialization, browser-only account, concurrent initialization, settings, replacement and malformed-key preservation.");
} finally {
  clearTimeout(deadline);
  disconnectMsgBus(); channel.port1.close(); channel.port2.close();
}
