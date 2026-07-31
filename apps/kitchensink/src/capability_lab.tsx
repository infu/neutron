import { useEffect, useMemo, useRef, useState } from "react";
import {
  connectEthereumProvider,
  createMsgBusClient,
  disableAgentMode,
  getAgentModeStatus,
  getVetKeyPublicKey,
  listBackendCallReservations,
  listVetKeys,
  querySelf,
  requestAgentMode,
  requestBackendCallReservations,
  requestVetKeys,
  updateSelf,
  type AgentModeStatus,
  type EthereumProviderConnection,
  type JsonObject,
  type JsonValue,
  type MsgBusEndpointId,
  type MsgBusToolDescriptor,
  type NeutronCanisterClient,
  type VetKeyPublicInfo,
  type VetKeySlotSummary,
} from "neutron-tools/app";
import { kernelParentOriginFromAppUrl } from "neutron-tools/src/runtime.js";
import { isValidAppId } from "neutron-tools/src/app_ids.js";
import { physicalPublicIngressMethodName } from "neutron-tools/src/physical_names.js";
import {
  CapabilityFrame,
  CopyValue,
  EvidenceList,
  OperationResult,
  formatResult,
  useOperation,
} from "./lab_ui.tsx";
import {
  VETKEY_DEMO_MAX_PLAINTEXT_BYTES,
  createVetKeyDemoEnvelope,
  recoverVetKeyDemoEnvelope,
  type VetKeyDemoEnvelope,
} from "./vetkey_demo.ts";

export const CAPABILITY_IDS = [
  "public_ingress",
  "backend_calls",
  "https_outcalls",
  "randomness",
  "chain_key_signing",
  "vetkeys",
  "scheduled_tasks",
  "stable_store",
  "self_calls",
  "agent_entrypoints",
  "background_requests",
  "ethereum",
  "connections",
  "storage",
  "certified_reads",
  "certified_assets",
] as const;

export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export type CapabilityRuntime = {
  client: NeutronCanisterClient | null;
  canisterId: string | null;
};

const BACKGROUND = "app:kitchensink:background" as const;
const ICP_LEDGER = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const ICP_FEE_METHOD = "icrc1_fee";

export function CapabilityPage({
  id,
  runtime,
}: {
  id: CapabilityId;
  runtime: CapabilityRuntime;
}) {
  switch (id) {
    case "public_ingress": return <PublicIngressPage runtime={runtime} />;
    case "backend_calls": return <BackendCallsPage runtime={runtime} />;
    case "https_outcalls": return <HttpsOutcallsPage />;
    case "randomness": return <RandomnessPage />;
    case "chain_key_signing": return <ChainKeySigningPage />;
    case "vetkeys": return <VetKeysPage />;
    case "scheduled_tasks": return <ScheduledTasksPage />;
    case "stable_store": return <StableStorePage />;
    case "self_calls": return <SelfCallsPage runtime={runtime} />;
    case "agent_entrypoints": return <AgentEntrypointsPage />;
    case "background_requests": return <BackgroundRequestsPage />;
    case "ethereum": return <EthereumPage />;
    case "connections": return <ConnectionsPage />;
    case "storage": return <StoragePage />;
    case "certified_reads": return <CertifiedReadsPage runtime={runtime} />;
    case "certified_assets": return <CertifiedAssetsPage runtime={runtime} />;
  }
}

function PublicIngressPage({ runtime }: { runtime: CapabilityRuntime }) {
  const operation = useOperation();
  const physicalMethod = physicalPublicIngressMethodName(
    "kitchensink",
    "demo_v1",
    "query",
  );
  const command = runtime.canisterId
    ? [
        "icp canister call",
        `  ${shellQuote(runtime.canisterId)}`,
        `  ${shellQuote(physicalMethod)}`,
        `  ${shellQuote('(record { method = "status"; payload = blob "\\44\\49\\44\\4c\\00\\00" })')}`,
        "  --query",
      ].join(" \\\n")
    : "Canister context is still loading.";

  return (
    <CapabilityFrame
      status="ready"
      statusLabel="Kernel mediated"
      purpose="Publish a bounded public Candid protocol endpoint without giving the app a raw actor surface."
      boundary="The compiler emits one collision-proof endpoint for this app and protocol. The kernel injects the real caller, selects only declared route ids, enforces caller and byte policy, and checks the route's runtime toggle before dispatch."
      declaration={'"public_ingress": {\n  "api": 1,\n  "routes": [\n    {\n      "protocol": "demo_v1",\n      "id": "status",\n      "handler": "public_status",\n      "mode": "query",\n      "caller": "any",\n      "max_request_bytes": 64,\n      "max_response_bytes": 4096\n    }\n  ]\n}'}
      evidence={<EvidenceList items={[
        { label: "Protocol route", value: <code>demo_v1:status</code> },
        { label: "Physical endpoint", value: <code>{physicalMethod}</code> },
        { label: "Caller policy", value: "Any principal" },
        { label: "Payload contract", value: "Candid () → Text" },
      ]} />}
    >
      <p className="nt-text">
        The external command exercises the real public transport. Its payload is the six-byte Candid encoding of unit; the outer result is a bounded <code>#ok blob</code> or a closed kernel error. The preview calls the same handler through the ordinary signed app route so the decoded value is easy to inspect.
      </p>
      <CopyValue label="External query command" value={command} />
      <div className="nt-command-bar">
        <button
          className="nt-button"
          disabled={Boolean(operation.busy)}
          onClick={() => void operation.run("status handler preview", () => querySelf("public_status", [null], 30))}
          type="button"
        >
          Preview handler
        </button>
      </div>
      <OperationResult {...operation} testId="capability-public-ingress-result" />
    </CapabilityFrame>
  );
}

function BackendCallsPage({ runtime }: { runtime: CapabilityRuntime }) {
  const operation = useOperation();
  const [target, setTarget] = useState(ICP_LEDGER);

  const reserveAndProbe = () => operation.run("reservation and call", () =>
    requestBackendCallReservations({
      actions: [{
        kind: "reserve",
        scope: { kind: "exact", principal: target.trim(), method: ICP_FEE_METHOD },
      }],
      call: { method: "backend_probe", args: [target.trim()] },
    }),
  );

  return (
    <CapabilityFrame
      status="setup"
      statusLabel="Owner approval"
      purpose="Give the backend one exact inter-canister call route without exposing an actor constructor or raw call primitive."
      boundary="The injected handle captures this installed app. Every dispatch rechecks the exact reservation, runtime toggle, target, sizes, and concurrency. The Neutron canister itself and system targets are rejected."
      declaration={'"backend_calls": {\n  "api": 1,\n  "reservation_scopes": ["exact"],\n  "max_concurrency": 1\n}'}
      evidence={<EvidenceList items={[
        { label: "Target", value: <code>{target || "not set"}</code> },
        { label: "Winning scope", value: <code>exact principal + icrc1_fee</code> },
        { label: "Backend handle", value: <code>BackendCallsV1</code> },
        { label: "Caller canister", value: <code>{runtime.canisterId ?? "loading"}</code> },
      ]} />}
    >
      <p className="nt-text">
        The default is the ICP ledger, available on mainnet and Neutron's local NNS bootstrap.
        Approval and the first fee read share one review flow. The reservation remains if the probe itself fails.
      </p>
      <label className="nt-field">
        <span className="nt-label">Ledger canister</span>
        <input
          className="nt-input"
          spellCheck={false}
          value={target}
          onChange={(event) => setTarget(event.currentTarget.value)}
        />
      </label>
      <div className="nt-command-bar">
        <button
          className="nt-button"
          disabled={Boolean(operation.busy) || !target.trim()}
          onClick={() => void reserveAndProbe()}
          type="button"
        >
          Review access and read fee
        </button>
        <button
          className="nt-button nt-button--secondary"
          disabled={Boolean(operation.busy)}
          onClick={() => void operation.run("reservation inventory", () => listBackendCallReservations())}
          type="button"
        >
          Show my reservations
        </button>
        <button
          className="nt-button nt-button--ghost"
          disabled={Boolean(operation.busy) || !target.trim()}
          onClick={() => void operation.run("release", () =>
            requestBackendCallReservations({
              actions: [{
                kind: "release",
                scope: { kind: "exact", principal: target.trim(), method: ICP_FEE_METHOD },
              }],
            }),
          )}
          type="button"
        >
          Release access
        </button>
      </div>
      <OperationResult {...operation} testId="capability-backend-calls-result" />
    </CapabilityFrame>
  );
}

function HttpsOutcallsPage() {
  const operation = useOperation();
  const run = (method: "GET" | "HEAD") => operation.run(
    `${method} example.com`,
    () => updateSelf<string>("https_example", [method], 90),
  );

  return (
    <CapabilityFrame
      status="development"
      statusLabel="Network dependent"
      purpose="Make a paid, replicated request to one exact public HTTPS prefix without exposing the management canister or cycle attachment to app code."
      boundary="The injected handle captures this installation. The broker builds only https://example.com/ plus a canonical relative suffix, admits only declared methods and headers, enforces a per-call quote ceiling and low-cycle reserve, bounds concurrency, and rechecks the endpoint lease before releasing a response. Its fixed transform removes every response header."
      declaration={'"https_outcalls": {\n  "api": 1,\n  "endpoints": [{\n    "id": "example",\n    "url_prefix": "https://example.com/",\n    "methods": ["get", "head"],\n    "request_headers": ["accept"],\n    "max_request_bytes": 4096,\n    "max_response_bytes": 32768,\n    "transform": "strip_headers"\n  }]\n}'}
      evidence={<EvidenceList items={[
        { label: "Endpoint", value: <code>example</code> },
        { label: "Fixed prefix", value: <code>https://example.com/</code> },
        { label: "Methods", value: "GET, HEAD" },
        { label: "Maximum response", value: "32,768 bytes" },
        { label: "Time-window limit", value: "None" },
        { label: "Response headers", value: "Always stripped" },
      ]} />}
    >
      <div className="nt-alert nt-alert--warning" role="note">
        HTTPS outcalls have no confidentiality: subnet replicas can observe the request and response. This fixture sends no credential or private data.
      </div>
      <p className="nt-text">
        <code>example.com</code> is the reserved Example Domain, so this demo avoids a mutable JSON API. A local PocketIC network may not provide an HTTPS adapter, and a live network request may still fail because of cycles, upstream availability, consensus, or runtime revocation. Those failures are shown as real broker results.
      </p>
      <div className="nt-command-bar">
        <button
          className="nt-button"
          disabled={Boolean(operation.busy)}
          onClick={() => void run("GET")}
          type="button"
        >
          GET example.com
        </button>
        <button
          className="nt-button nt-button--secondary"
          disabled={Boolean(operation.busy)}
          onClick={() => void run("HEAD")}
          type="button"
        >
          HEAD example.com
        </button>
      </div>
      <OperationResult
        {...operation}
        idle="Run GET or HEAD to see the real broker response. No success is simulated."
        testId="capability-https-outcalls-result"
      />
    </CapabilityFrame>
  );
}

function RandomnessPage() {
  const operation = useOperation();
  return (
    <CapabilityFrame
      status="ready"
      statusLabel="Ready"
      purpose="Request one 32-byte consensus seed through an app-scoped backend handle."
      boundary="The kernel owns the management-canister call, limits this app to one in-flight request, keeps a low-cycle reserve, and suppresses a result if authority changes while waiting. It has no hourly request window."
      declaration={'"randomness": {\n  "api": 1\n}'}
      evidence={<EvidenceList items={[
        { label: "Bytes per success", value: "32" },
        { label: "Time-window limit", value: "None" },
        { label: "Concurrent requests", value: "1 for this installation" },
        { label: "Private API exposed", value: "No management actor" },
      ]} />}
    >
      <p className="nt-text">
        The demo renders the seed once as hexadecimal evidence. Product code should derive only the values it needs and never log randomness that becomes key material.
      </p>
      <button
        className="nt-button"
        disabled={Boolean(operation.busy)}
        onClick={() => void operation.run("consensus draw", () =>
          updateSelf<string>("random_bytes", [null], 90))}
        type="button"
      >
        Draw one seed
      </button>
      <OperationResult {...operation} testId="capability-randomness-result" />
    </CapabilityFrame>
  );
}

const RECEIPT_ASSERTION = [
  "Kitchen Sink receipt assertion v1",
  "item=capability-lab-demo",
  "amount=0",
  "currency=none",
].join("\n");

type ChainKeyPublicDemo = {
  slot: string;
  algorithm: string;
  publicKeyHex: string;
  keyFingerprintHex: string;
  signingDomainHex: string;
  namespaceVersion: string;
  messageFormat: string;
};

type ChainKeySignatureDemo = {
  assertionText: string;
  slot: string;
  algorithm: string;
  digestHex: string;
  signatureHex: string;
  signingDomainHex: string;
  messageFormat: string;
};

function ChainKeySigningPage() {
  const operation = useOperation();
  const [publicInfo, setPublicInfo] = useState<ChainKeyPublicDemo | null>(null);
  const [signatureInfo, setSignatureInfo] = useState<ChainKeySignatureDemo | null>(null);

  const requestPublicKey = async (): Promise<ChainKeyPublicDemo> => {
    const result = chainKeyRecord(
      await updateSelf<JsonValue>("chain_key_public_key", [null], 90),
      "public-key response",
    );
    if (result.ok !== true) {
      throw new Error(chainKeyText(result.error) || "The threshold public key is unavailable");
    }
    const slot = chainKeyText(result.slot);
    const algorithm = chainKeyText(result.algorithm);
    const messageFormat = chainKeyText(result.message_format);
    const namespaceVersion = String(result.namespace_version ?? "");
    if (
      slot !== "receipt_assertions" ||
      algorithm !== "ecdsa_secp256k1" ||
      messageFormat !== "neutron_app_assertion_v1" ||
      namespaceVersion !== "1"
    ) {
      throw new Error("The threshold public key has an unexpected authority binding");
    }
    const next = {
      slot,
      algorithm,
      publicKeyHex: chainKeyHex(result.public_key_hex, "public key", 33),
      keyFingerprintHex: chainKeyHex(result.key_fingerprint_hex, "key fingerprint", 32),
      signingDomainHex: chainKeyHex(result.signing_domain_hex, "signing domain", 32),
      namespaceVersion,
      messageFormat,
    };
    if (!/^0x0[23]/u.test(next.publicKeyHex)) {
      throw new Error("The ECDSA public key is not compressed SEC1 evidence");
    }
    setPublicInfo(next);
    return next;
  };

  const fetchPublicKey = () => operation.run("public key fetch", async () => {
    setPublicInfo(null);
    const next = await requestPublicKey();
    return {
      slot: next.slot,
      algorithm: next.algorithm,
      keyFingerprint: next.keyFingerprintHex,
      namespaceVersion: next.namespaceVersion,
    };
  });

  const signReceipt = () => operation.run("fixed receipt signing", async () => {
    setSignatureInfo(null);
    const key = publicInfo ?? await requestPublicKey();
    const result = chainKeyRecord(
      await updateSelf<JsonValue>("chain_key_sign_receipt", [null], 120),
      "signature response",
    );
    if (result.ok !== true) {
      throw new Error(chainKeyText(result.error) || "The receipt assertion was not signed");
    }
    const assertionText = chainKeyText(result.assertion_text);
    if (assertionText !== RECEIPT_ASSERTION) {
      throw new Error("The backend returned an unexpected assertion fixture");
    }
    const slot = chainKeyText(result.slot);
    const algorithm = chainKeyText(result.algorithm);
    const messageFormat = chainKeyText(result.message_format);
    if (
      slot !== key.slot ||
      algorithm !== key.algorithm ||
      messageFormat !== key.messageFormat
    ) {
      throw new Error("The signature has an unexpected authority binding");
    }
    const next = {
      assertionText,
      slot,
      algorithm,
      digestHex: chainKeyHex(result.digest_hex, "assertion digest", 32),
      signatureHex: chainKeyHex(result.signature_hex, "signature", 64),
      signingDomainHex: chainKeyHex(result.signing_domain_hex, "signing domain", 32),
      messageFormat,
    };
    if (next.signingDomainHex !== key.signingDomainHex) {
      throw new Error("The signature domain does not match the public key domain");
    }
    setSignatureInfo(next);
    return {
      slot: next.slot,
      algorithm: next.algorithm,
      digest: next.digestHex,
      signature: next.signatureHex,
    };
  });

  return (
    <CapabilityFrame
      status="development"
      statusLabel="Threshold network"
      purpose="Fetch one app-installation key and sign one fixed, harmless receipt assertion through a bounded threshold-signing broker."
      boundary="The backend receives only an assertion-signing handle. Neutron fixes the threshold key, installation namespace, derivation component, domain-separated digest format, per-call cost ceiling, low-cycle reserve, and concurrency. V1 cannot sign a caller-provided digest, transaction, derivation path, master-key name, or BIP341 auxiliary data."
      declaration={'"chain_key_signing": {\n  "api": 1,\n  "slots": [{\n    "id": "receipt_assertions",\n    "algorithm": "ecdsa_secp256k1",\n    "purpose": "Sign Kitchen Sink receipt assertions",\n    "max_assertion_bytes": 4096\n  }]\n}'}
      evidence={<EvidenceList items={[
        { label: "Slot", value: <code>receipt_assertions</code> },
        { label: "Algorithm", value: <code>{signatureInfo?.algorithm ?? publicInfo?.algorithm ?? "ecdsa_secp256k1"}</code> },
        { label: "Message format", value: <code>{signatureInfo?.messageFormat ?? publicInfo?.messageFormat ?? "neutron_app_assertion_v1"}</code> },
        { label: "Assertion ceiling", value: "4,096 bytes" },
        { label: "Time-window limit", value: "None" },
        { label: "Raw or transaction signing", value: "Not exposed" },
      ]} />}
    >
      <div className="nt-alert">
        This is an assertion receipt, not a wallet or transaction-signing API. A verifier can still treat any signed assertion as authority-bearing evidence. Install approval is not one-shot transaction consent, and an ambiguous outcome is never retried automatically.
      </div>
      <div className="nt-field">
        <span className="nt-label">Fixed assertion</span>
        <pre className="nt-pre nt-pre--wrap ks-chain-assertion"><code>{RECEIPT_ASSERTION}</code></pre>
      </div>
      <div className="nt-command-bar">
        <button className="nt-button nt-button--secondary" disabled={Boolean(operation.busy)} onClick={() => void fetchPublicKey()} type="button">
          Fetch public key
        </button>
        <button className="nt-button" disabled={Boolean(operation.busy)} onClick={() => void signReceipt()} type="button">
          Sign fixed receipt
        </button>
      </div>
      {publicInfo ? (
        <div className="ks-chain-evidence" data-tid="capability-chain-key-public-evidence">
          <CopyValue label="Signing domain" value={publicInfo.signingDomainHex} />
          <CopyValue label="Key fingerprint" value={publicInfo.keyFingerprintHex} />
          <CopyValue label="Compressed public key" value={publicInfo.publicKeyHex} />
          <p className="nt-muted">Namespace version {publicInfo.namespaceVersion}</p>
        </div>
      ) : null}
      {signatureInfo ? (
        <div className="ks-chain-evidence" data-tid="capability-chain-key-signature-evidence">
          <CopyValue label="Assertion digest" value={signatureInfo.digestHex} />
          <CopyValue label="Signature" value={signatureInfo.signatureHex} />
        </div>
      ) : null}
      <OperationResult
        {...operation}
        idle="Fetch the real public key or sign the fixed receipt. Unavailable local keys and network failures remain visible errors."
        testId="capability-chain-key-result"
      />
    </CapabilityFrame>
  );
}

function chainKeyRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function chainKeyText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function chainKeyHex(value: unknown, label: string, bytes: number): string {
  const text = chainKeyText(value);
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`, "u").test(text)) {
    throw new Error(`Invalid ${label} evidence`);
  }
  return text;
}

function VetKeysPage() {
  const operation = useOperation();
  const [slot, setSlot] = useState<VetKeySlotSummary | null | undefined>(undefined);
  const [publicInfo, setPublicInfo] = useState<VetKeyPublicInfo | null>(null);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [message, setMessage] = useState("Private Kitchen Sink round-trip");
  const [envelope, setEnvelope] = useState<VetKeyDemoEnvelope | null>(null);
  const messageBytes = new TextEncoder().encode(message).byteLength;

  const refresh = () => operation.run("slot inventory", async () => {
    const result = await listVetKeys();
    const next = result.slots.find((candidate) => candidate.slot === "demo_key") ?? null;
    setSlot(next);
    if (
      !next ||
      (publicInfo && !next.generations.some((generation) =>
        generation.generation === publicInfo.generation))
    ) {
      setPublicInfo(null);
      setFingerprint(null);
    }
    return result;
  });

  const reserve = () => operation.run("slot reservation", async () => {
    const result = await requestVetKeys({ action: "reserve", slot: "demo_key" });
    setSlot(result.slot);
    return result;
  });

  const enable = () => operation.run("slot enable", async () => {
    const result = await requestVetKeys({ action: "enable", slot: "demo_key" });
    setSlot(result.slot);
    return result;
  });

  const disable = () => operation.run("slot disable", async () => {
    const result = await requestVetKeys({ action: "disable", slot: "demo_key" });
    setSlot(result.slot);
    return result;
  });

  const rotate = () => operation.run("slot rotation", async () => {
    const result = await requestVetKeys({ action: "rotate", slot: "demo_key" });
    setSlot(result.slot);
    setPublicInfo(null);
    setFingerprint(null);
    return result;
  });

  const retirePrevious = () => operation.run("previous-generation retirement", async () => {
    const previous = slot?.previousGeneration;
    if (!previous) throw new Error("There is no previous generation to retire");
    const result = await requestVetKeys({
      action: "retireGeneration",
      slot: "demo_key",
      generation: previous,
    });
    setSlot(result.slot);
    if (envelope?.binding.generation === previous) setEnvelope(null);
    return result;
  });

  useEffect(() => {
    void refresh();
  }, []);

  const loadPublicInfo = async (): Promise<VetKeyPublicInfo> => {
    if (!slot) throw new Error("Reserve the demo slot first");
    if (
      publicInfo &&
      publicInfo.generation === slot.currentGeneration
    ) return publicInfo;
    const info = await getVetKeyPublicKey({
      slot: slot.slot,
      generation: slot.currentGeneration,
    });
    const next = bytesHex(info.publicFingerprint);
    setFingerprint(next);
    setPublicInfo(info);
    return info;
  };

  const publicProof = () => operation.run("public binding", async () => {
    const info = await loadPublicInfo();
    return {
      slot: info.slot,
      generation: info.generation,
      suite: info.suite,
      canisterPrincipal: info.canisterPrincipal,
      publicFingerprint: bytesHex(info.publicFingerprint),
    };
  });

  const encrypt = () => operation.run("public encryption", async () => {
    if (messageBytes < 1 || messageBytes > VETKEY_DEMO_MAX_PLAINTEXT_BYTES) {
      throw new Error(`Message must be 1-${VETKEY_DEMO_MAX_PLAINTEXT_BYTES} UTF-8 bytes`);
    }
    const info = await loadPublicInfo();
    const next = createVetKeyDemoEnvelope(info, message);
    setEnvelope(next);
    return {
      generation: next.binding.generation,
      plaintextBytes: next.plaintextBytes,
      ciphertextBytes: next.ciphertext.length,
      privateKeyUsed: false,
    };
  });

  const decrypt = () => operation.run("verified recovery", async () => {
    if (!envelope) throw new Error("Encrypt the demo message first");
    return recoverVetKeyDemoEnvelope(envelope);
  });

  return (
    <CapabilityFrame
      status="setup"
      statusLabel={slot === undefined ? "Checking" : slot === null ? "Needs setup" : slot.status === "enabled" ? "Enabled" : slot.status}
      purpose="Encrypt with public slot material, recover the exact generation through a source-bound challenge, and decrypt only in this browser."
      boundary="The SDK sends no app id. The kernel derives the source installation from this live tile. Public encryption needs no private material; derivation returns an encrypted VetKey to a one-use transport key, and only verified plaintext leaves the local recovery helper. Motoko receives at most public slot metadata when separately selected."
      declaration={'"vetkeys": {\n  "api": 1,\n  "description": "Demonstrate an app-isolated Kitchen Sink key slot",\n  "slots": [{\n    "id": "demo_key",\n    "purpose": "Demonstrate app-isolated public key binding"\n  }]\n}'}
      evidence={<EvidenceList items={[
        { label: "Slot", value: <code>demo_key</code> },
        { label: "State", value: slot === undefined ? "checking" : slot?.status ?? "not reserved" },
        { label: "Generation", value: slot?.currentGeneration ?? "—" },
        { label: "Previous", value: slot?.previousGeneration ?? "none" },
        { label: "Public fingerprint", value: <code>{fingerprint ?? "fetch after reservation"}</code> },
        { label: "Ciphertext", value: envelope ? `${envelope.ciphertext.length} bytes · generation ${envelope.binding.generation}` : "not created" },
      ]} />}
    >
      <p className="nt-text">No private key bytes are rendered, returned by the demo helper, or stored in the backend. Keep a ciphertext across one rotation to prove that its retained previous generation still decrypts.</p>
      <label className="nt-field">
        <span className="nt-label">Short private message</span>
        <input className="nt-input" maxLength={VETKEY_DEMO_MAX_PLAINTEXT_BYTES} value={message} onChange={(event) => { setMessage(event.currentTarget.value); setEnvelope(null); operation.clear(); }} />
        <span className="nt-help">{messageBytes} / {VETKEY_DEMO_MAX_PLAINTEXT_BYTES} UTF-8 bytes</span>
      </label>
      <div className="nt-command-bar">
        {slot === null ? <button className="nt-button" disabled={Boolean(operation.busy)} onClick={() => void reserve()} type="button">Reserve demo slot</button> : null}
        {slot?.status === "disabled" ? <button className="nt-button" disabled={Boolean(operation.busy)} onClick={() => void enable()} type="button">Enable demo slot</button> : null}
        {slot === undefined ? <button className="nt-button" disabled type="button">Checking slot…</button> : null}
        <button className="nt-button" disabled={Boolean(operation.busy) || slot?.status !== "enabled" || messageBytes < 1 || messageBytes > VETKEY_DEMO_MAX_PLAINTEXT_BYTES} onClick={() => void encrypt()} type="button">
          Encrypt with public key
        </button>
        <button className="nt-button" disabled={Boolean(operation.busy) || slot?.status !== "enabled" || !envelope} onClick={() => void decrypt()} type="button">
          Recover key &amp; decrypt
        </button>
        <button className="nt-button nt-button--secondary" disabled={Boolean(operation.busy) || slot?.status !== "enabled"} onClick={() => void publicProof()} type="button">
          Public proof
        </button>
        <button className="nt-button nt-button--secondary" disabled={Boolean(operation.busy)} onClick={() => void refresh()} type="button">
          Refresh
        </button>
      </div>
      {slot ? (
        <details className="ks-boundary">
          <summary>Key lifecycle demo</summary>
          <p>These focused actions use Neutron&apos;s trusted lifecycle review. Rotation retains exactly one previous generation; retire it only after its ciphertext is no longer needed.</p>
          <div className="nt-command-bar">
            {slot.status === "enabled" ? <button className="nt-button nt-button--ghost" disabled={Boolean(operation.busy)} onClick={() => void disable()} type="button">Disable slot</button> : null}
            <button className="nt-button nt-button--secondary" disabled={Boolean(operation.busy) || slot.status !== "enabled" || Boolean(slot.previousGeneration)} onClick={() => void rotate()} type="button">Rotate generation</button>
            <button className="nt-button nt-button--ghost" disabled={Boolean(operation.busy) || !slot.previousGeneration} onClick={() => void retirePrevious()} type="button">Retire previous</button>
          </div>
        </details>
      ) : null}
      <OperationResult {...operation} testId="capability-vetkeys-result" />
    </CapabilityFrame>
  );
}

function ScheduledTasksPage() {
  const [busy, setBusy] = useState<string | null>("initial marker");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(false);

  const readMarker = async (showBusy: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (showBusy) setBusy("scheduled marker");
    try {
      const value = await querySelf("scheduled_status", [null], 30);
      if (!mounted.current) return;
      setResult(formatResult(value));
      setError(null);
    } catch (reason) {
      if (!mounted.current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      inFlight.current = false;
      if (mounted.current && showBusy) setBusy(null);
    }
  };

  useEffect(() => {
    mounted.current = true;
    let timer: number | null = null;
    let stopped = false;
    let first = true;
    const poll = async () => {
      await readMarker(first);
      first = false;
      if (!stopped) timer = window.setTimeout(() => void poll(), 2_000);
    };
    void poll();
    return () => {
      stopped = true;
      mounted.current = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  return (
    <CapabilityFrame
      status="ready"
      statusLabel="Live · daily"
      purpose="Run one non-overlapping backend callback after install and once per day, under its own runtime toggle and lease."
      boundary="The compiler binds the exact internal async* handler. The scheduler waits until deployment commit, never overlaps a task with itself, and closes every invocation-scoped handle when the callback finishes."
      declaration={'"scheduled_tasks": {\n  "api": 1,\n  "tasks": [{\n    "id": "daily_tick",\n    "method": "scheduled_tick",\n    "interval_seconds": 86400,\n    "run_on_start": true,\n    "max_backend_calls": 1\n  }]\n}'}
      evidence={<EvidenceList items={[
        { label: "Task", value: <code>daily_tick</code> },
        { label: "Interval", value: "1 day · 86,400 seconds" },
        { label: "Watcher", value: "2 seconds · page only" },
        { label: "Overlap", value: "Denied" },
        { label: "Manual run", value: "Not part of V1" },
      ]} />}
    >
      <p className="nt-text">
        This page reads the durable marker every two seconds, only while open. The first run is queued after deployment commit; later runs use the real daily timer. Page polling never triggers the task, and there is no fake “run now” action.
      </p>
      <button
        className="nt-button nt-button--secondary"
        disabled={Boolean(busy)}
        onClick={() => void readMarker(true)}
        type="button"
      >
        Refresh now
      </button>
      <OperationResult
        busy={busy}
        error={error}
        result={result}
        idle="Waiting for the first committed scheduled run."
        testId="capability-scheduled-result"
      />
    </CapabilityFrame>
  );
}

type StableNote = {
  key: string;
  value: string;
  revision: string;
  schemaVersion: string;
};

type StableNotesUsage = {
  entries: string;
  bytes: string;
  maxEntries: string;
  maxBytes: string;
  overQuota: boolean;
  schemaVersion: string;
};

type StableNotesCursor = {
  prefix: string;
  namespaceUid: string;
  after: string;
};

function StableStorePage() {
  const operation = useOperation();
  const [key, setKey] = useState("notes/alpha");
  const [value, setValue] = useState("A durable Kitchen Sink note");
  const [prefix, setPrefix] = useState("notes/");
  const [entry, setEntry] = useState<StableNote | null>(null);
  const [usage, setUsage] = useState<StableNotesUsage | null>(null);
  const [pageEntries, setPageEntries] = useState<StableNote[]>([]);
  const [cursor, setCursor] = useState<StableNotesCursor | null>(null);
  const [observedRevision, setObservedRevision] = useState("—");
  const keyBytes = new TextEncoder().encode(key).byteLength;
  const valueBytes = new TextEncoder().encode(value).byteLength;
  const prefixBytes = new TextEncoder().encode(prefix).byteLength;
  const entryMatchesKey = entry?.key === key;

  const runMutation = (
    label: string,
    method: "stable_notes_create" | "stable_notes_update" | "stable_notes_delete",
    args: JsonValue[],
  ) => operation.run(label, async () => {
    const result = parseStableNotesResult(
      await updateSelf<JsonValue>(method, args, 30),
      label,
    );
    setEntry(result.entry);
    if (result.usage) setUsage(result.usage);
    setCursor(null);
    return {
      note: result.entry ?? "deleted",
      usage: result.usage,
    };
  });

  const load = () => operation.run("note load", async () => {
    const result = parseStableNotesResult(
      await querySelf<JsonValue>("stable_notes_load", [key], 30),
      "note load",
    );
    setEntry(result.entry);
    if (result.entry) setValue(result.entry.value);
    return result.entry ?? { found: false, key };
  });

  const refreshUsage = () => operation.run("usage", async () => {
    const result = parseStableNotesResult(
      await querySelf<JsonValue>("stable_notes_usage", [null], 30),
      "usage",
    );
    if (!result.usage) throw new Error("Stable Store returned no usage record");
    setUsage(result.usage);
    return result.usage;
  });

  const listPage = (continuing: boolean) => operation.run(
    continuing ? "next prefix page" : "first prefix page",
    async () => {
      const activeCursor = continuing ? cursor : null;
      if (continuing && (!activeCursor || activeCursor.prefix !== prefix)) {
        throw new Error("The prefix changed; start again from the first page");
      }
      const page = parseStableNotesPage(
        await querySelf<JsonValue>("stable_notes_list", [[
          prefix,
          Boolean(activeCursor),
          activeCursor?.namespaceUid ?? "0",
          activeCursor?.after ?? "",
        ]], 30),
      );
      setPageEntries(page.entries);
      setCursor(page.next ? { prefix, ...page.next } : null);
      setObservedRevision(page.observedRevision);
      return {
        entries: page.entries,
        observedRevision: page.observedRevision,
        nextAfter: page.next?.after ?? null,
      };
    },
  );

  const seed = () => operation.run("sample set", async () => {
    const samples = [
      ["notes/alpha", "Alpha — created only if absent"],
      ["notes/bravo", "Bravo — makes page one full"],
      ["notes/charlie", "Charlie — appears on page two"],
    ] as const;
    let created = 0;
    let alreadyPresent = 0;
    for (const [sampleKey, sampleValue] of samples) {
      const raw = stableStoreRecord(
        await updateSelf<JsonValue>("stable_notes_create", [[sampleKey, sampleValue]], 30),
        "sample create",
      );
      if (raw.ok === true) {
        created += 1;
      } else {
        const error = stableStoreString(raw.error, "sample error");
        if (!error.startsWith("Revision conflict:")) throw new Error(error);
        alreadyPresent += 1;
      }
    }
    const usageResult = parseStableNotesResult(
      await querySelf<JsonValue>("stable_notes_usage", [null], 30),
      "sample usage",
    );
    if (usageResult.usage) setUsage(usageResult.usage);
    setCursor(null);
    return { created, alreadyPresent, pageSize: 2 };
  });

  const clearPage = () => operation.run("bounded clear page", async () => {
    const result = parseStableNotesClearPage(
      await updateSelf<JsonValue>("stable_notes_clear_page", [prefix], 30),
    );
    setUsage(result.usage);
    setEntry(null);
    setCursor(null);
    setPageEntries([]);
    return result;
  });

  return (
    <CapabilityFrame
      status="development"
      statusLabel="Development implementation"
      purpose="Keep bounded, revisioned app records in a kernel-owned namespace without exposing stable-memory pointers or a universal storage authority."
      boundary="The compiler injects only this installation's StableStoreV1 leaf. Neutron fixes the app/install/store namespace, validates declared quotas, owns revisions and live cursors, and erases the namespace on uninstall or reinstall. Values are plaintext to the canister's subnet replicas: this is isolation and accounting, not encryption or certification."
      declaration={'"stable_store": {\n  "api": 1,\n  "stores": [{\n    "id": "notes",\n    "purpose": "Kitchen Sink revisioned UTF-8 notes demo",\n    "schema_version": 1,\n    "max_entries": 24,\n    "max_key_bytes": 96,\n    "max_value_bytes": 4096,\n    "max_bytes": 32768\n  }]\n}'}
      evidence={<EvidenceList items={[
        { label: "Store", value: <code>notes</code> },
        { label: "Text adapter", value: "UTF-8 over binary keys and values" },
        { label: "Schema", value: <code>v{usage?.schemaVersion ?? entry?.schemaVersion ?? "1"}</code> },
        { label: "Current revision", value: <code>{entry?.revision ?? "not loaded"}</code> },
        { label: "Logical usage", value: usage ? `${usage.entries} / ${usage.maxEntries} entries · ${usage.bytes} / ${usage.maxBytes} bytes` : "Read on demand" },
        { label: "Quota state", value: usage?.overQuota ? "Over quota; shrink/delete remains available" : "Within declared ceiling" },
      ]} />}
    >
      <div className="nt-alert">
        <strong>Compare-and-swap (CAS):</strong> if you read revision 7 and another writer creates revision 8, an update that still expects 7 conflicts instead of silently erasing revision 8.
      </div>
      <div className="ks-stable-editor">
        <label className="nt-field">
          <span className="nt-label">Note key</span>
          <input className="nt-input" data-tid="stable-store-key" maxLength={96} value={key} onChange={(event) => setKey(event.currentTarget.value)} />
          <span className="nt-help">{keyBytes} / 96 UTF-8 bytes</span>
        </label>
        <label className="nt-field ks-stable-value">
          <span className="nt-label">Note value</span>
          <textarea className="nt-textarea" data-tid="stable-store-value" maxLength={4096} rows={4} value={value} onChange={(event) => setValue(event.currentTarget.value)} />
          <span className="nt-help">{valueBytes} / 4,096 UTF-8 bytes</span>
        </label>
      </div>
      <div className="nt-command-bar">
        <button className="nt-button" disabled={Boolean(operation.busy) || !key || keyBytes > 96 || valueBytes > 4096} onClick={() => void runMutation("create if absent", "stable_notes_create", [[key, value]])} type="button">Create if absent</button>
        <button className="nt-button nt-button--secondary" disabled={Boolean(operation.busy) || !key || keyBytes > 96} onClick={() => void load()} type="button">Load</button>
        <button className="nt-button nt-button--secondary" disabled={Boolean(operation.busy) || !entryMatchesKey || valueBytes > 4096} onClick={() => void runMutation("revision update", "stable_notes_update", [[key, value, entry!.revision]])} type="button">Update revision {entryMatchesKey ? entry!.revision : "—"}</button>
        <button className="nt-button nt-button--ghost" disabled={Boolean(operation.busy) || !entryMatchesKey} onClick={() => void runMutation("revision delete", "stable_notes_delete", [[key, entry!.revision]])} type="button">Delete at revision</button>
      </div>
      <section className="ks-stable-browser" aria-labelledby="stable-prefix-title">
        <div className="ks-section-heading">
          <div>
            <p className="nt-eyebrow">Bounded scan</p>
            <h2 id="stable-prefix-title">Live prefix pages</h2>
          </div>
          <code>limit 2</code>
        </div>
        <label className="nt-field">
          <span className="nt-label">UTF-8 prefix</span>
          <input className="nt-input" data-tid="stable-store-prefix" maxLength={96} value={prefix} onChange={(event) => setPrefix(event.currentTarget.value)} />
          <span className="nt-help">{prefixBytes} / 96 UTF-8 bytes · observed revision {observedRevision}</span>
        </label>
        <div className="nt-command-bar">
          <button className="nt-button nt-button--secondary" disabled={Boolean(operation.busy) || prefixBytes > 96} onClick={() => void listPage(false)} type="button">First page</button>
          <button className="nt-button nt-button--secondary" disabled={Boolean(operation.busy) || !cursor || cursor.prefix !== prefix} onClick={() => void listPage(true)} type="button">Next page</button>
          <button className="nt-button nt-button--ghost" disabled={Boolean(operation.busy)} onClick={() => void seed()} type="button">Create sample set</button>
          <button className="nt-button nt-button--ghost" disabled={Boolean(operation.busy)} onClick={() => void refreshUsage()} type="button">Read usage</button>
          <button className="nt-button nt-button--ghost" disabled={Boolean(operation.busy) || prefixBytes > 96} onClick={() => void clearPage()} type="button">Clear 2 matching</button>
        </div>
        {pageEntries.length ? (
          <ol className="ks-stable-page" data-tid="stable-store-page">
            {pageEntries.map((note) => (
              <li key={`${note.key}:${note.revision}`}>
                <div><code>{note.key}</code><small>revision {note.revision} · schema {note.schemaVersion}</small></div>
                <p>{note.value}</p>
              </li>
            ))}
          </ol>
        ) : <p className="nt-muted">No page loaded. Create the sample set to exercise a real continuation cursor.</p>}
      </section>
      <OperationResult
        {...operation}
        idle="Create a note, load its revision, then update with compare-and-swap or scan the notes/ prefix two records at a time."
        testId="capability-stable-store-result"
      />
    </CapabilityFrame>
  );
}

function parseStableNotesResult(value: unknown, label: string): {
  entry: StableNote | null;
  usage: StableNotesUsage | null;
} {
  const record = stableStoreRecord(value, `${label} result`);
  if (record.ok !== true) {
    throw new Error(stableStoreString(record.error, `${label} error`) || `${label} failed`);
  }
  return {
    entry: stableStoreOptional(record.entry, parseStableNote),
    usage: stableStoreOptional(record.usage, parseStableNotesUsage),
  };
}

function parseStableNotesPage(value: unknown): {
  entries: StableNote[];
  next: { namespaceUid: string; after: string } | null;
  observedRevision: string;
} {
  const record = stableStoreRecord(value, "stable-store page");
  if (record.ok !== true) {
    throw new Error(stableStoreString(record.error, "page error") || "Prefix page failed");
  }
  if (!Array.isArray(record.entries)) throw new Error("Invalid stable-store entries");
  const hasMore = record.has_more === true;
  return {
    entries: record.entries.map(parseStableNote),
    next: hasMore ? {
      namespaceUid: stableStoreString(record.next_namespace_uid, "cursor namespace"),
      after: stableStoreString(record.next_after, "cursor key"),
    } : null,
    observedRevision: stableStoreNat(record.observed_revision, "observed revision"),
  };
}

function parseStableNotesClearPage(value: unknown): {
  removedEntries: string;
  removedBytes: string;
  more: boolean;
  usage: StableNotesUsage;
} {
  const record = stableStoreRecord(value, "stable-store clear page");
  if (record.ok !== true) {
    throw new Error(stableStoreString(record.error, "clear error") || "Clear page failed");
  }
  const usage = stableStoreOptional(record.usage, parseStableNotesUsage);
  if (!usage) throw new Error("Stable Store returned no usage after clearing");
  return {
    removedEntries: stableStoreNat(record.removed_entries, "removed entries"),
    removedBytes: stableStoreNat(record.removed_bytes, "removed bytes"),
    more: record.more === true,
    usage,
  };
}

function parseStableNote(value: unknown): StableNote {
  const record = stableStoreRecord(value, "stable note");
  return {
    key: stableStoreString(record.key, "note key"),
    value: stableStoreString(record.value, "note value"),
    revision: stableStoreString(record.revision, "note revision"),
    schemaVersion: stableStoreNat(record.schema_version, "note schema"),
  };
}

function parseStableNotesUsage(value: unknown): StableNotesUsage {
  const record = stableStoreRecord(value, "stable-store usage");
  if (typeof record.over_quota !== "boolean") throw new Error("Invalid quota state");
  return {
    entries: stableStoreNat(record.entries, "usage entries"),
    bytes: stableStoreNat(record.bytes, "usage bytes"),
    maxEntries: stableStoreNat(record.max_entries, "usage entry ceiling"),
    maxBytes: stableStoreNat(record.max_bytes, "usage byte ceiling"),
    overQuota: record.over_quota,
    schemaVersion: stableStoreNat(record.schema_version, "usage schema"),
  };
}

function stableStoreRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function stableStoreString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${label}`);
  return value;
}

function stableStoreNat(value: unknown, label: string): string {
  if (typeof value === "string" && /^\d+$/u.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw new Error(`Invalid ${label}`);
}

function stableStoreOptional<T>(value: unknown, parse: (entry: unknown) => T): T | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (value.length !== 1) throw new Error("Invalid stable-store option");
    return parse(value[0]);
  }
  return parse(value);
}

function SelfCallsPage({ runtime }: { runtime: CapabilityRuntime }) {
  const operation = useOperation();
  const [message, setMessage] = useState("Reviewed Kitchen Sink message");
  return (
    <CapabilityFrame
      status="ready"
      statusLabel="Ready"
      purpose="Compare exact install-time preapproval with an ordinary signed call that still opens kernel review."
      boundary="Preapproval covers only the listed logical method names and this same installed app. It does not authorize another canister, another app, or an undeclared method."
      declaration={'"preapproved_self_calls": {\n  "api": 1,\n  "methods": [\n    "read_profile",\n    "bump_counter",\n    "read_counter",\n    "random_bytes",\n    "chain_key_public_key",\n    "chain_key_sign_receipt",\n    "https_example",\n    "scheduled_status",\n    "dependency_status",\n    "function_resource_snapshot",\n    "asset_status",\n    "certified_assets_usage",\n    "stable_notes_create",\n    "stable_notes_load",\n    "stable_notes_update",\n    "stable_notes_list",\n    "stable_notes_usage",\n    "stable_notes_delete",\n    "stable_notes_clear_page"\n  ]\n}'}
      evidence={<EvidenceList items={[
        { label: "Fast query", value: <code>read_counter</code> },
        { label: "Fast update", value: <code>bump_counter</code> },
        { label: "Reviewed method", value: <code>echo</code> },
        { label: "Canister", value: <code>{runtime.canisterId ?? "loading"}</code> },
      ]} />}
    >
      <div className="ks-two-column">
        <div className="ks-action-group">
          <h2>Preapproved route</h2>
          <div className="nt-command-bar">
            <button className="nt-button nt-button--secondary" disabled={Boolean(operation.busy)} onClick={() => void operation.run("counter read", () => querySelf("read_counter", [null], 20))} type="button">
              Read counter
            </button>
            <button className="nt-button" disabled={Boolean(operation.busy)} onClick={() => void operation.run("counter update", () => updateSelf("bump_counter", ["1"], 20))} type="button">
              Increment
            </button>
          </div>
        </div>
        <div className="ks-action-group">
          <h2>Normal reviewed route</h2>
          <label className="nt-field">
            <span className="nt-label">Echo message</span>
            <input className="nt-input" maxLength={256} value={message} onChange={(event) => setMessage(event.currentTarget.value)} />
          </label>
          <button className="nt-button" disabled={Boolean(operation.busy) || !runtime.client || !message.trim()} onClick={() => void operation.run("kernel review", () => runtime.client!.callDialog("echo", [message.trim()], 60))} type="button">
            Review echo call
          </button>
        </div>
      </div>
      <OperationResult {...operation} testId="capability-self-calls-result" />
    </CapabilityFrame>
  );
}

function AgentEntrypointsPage() {
  const operation = useOperation();
  const bus = useMemo(() => createMsgBusClient(), []);
  const [goal, setGoal] = useState("Inspect this tile's source-bound snapshot");
  const [status, setStatus] = useState<AgentModeStatus | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  const statusAction = (
    label: string,
    action: () => Promise<AgentModeStatus>,
  ) => operation.run(label, async () => {
    const next = await action();
    setStatus(next);
    return next;
  });

  useEffect(() => {
    void statusAction("agent status", () => getAgentModeStatus());
  }, []);

  const runTurn = () => operation.run("delegated turn", async () => {
    setProgress(null);
    return bus.callTool(
      {
        target: BACKGROUND,
        name: "capability_agent_demo",
        arguments: { goal: goal.trim() },
      },
      {
        timeout: 60,
        onProgress: (value) => setProgress(formatResult(value)),
      },
    );
  });

  return (
    <CapabilityFrame
      status="setup"
      statusLabel={status === null ? "Checking" : status.enabled ? "Agent Mode enabled" : "Owner opt-in"}
      purpose="Grant one exact resident entrypoint temporary delegated tool authority, then run a deterministic capability turn."
      boundary="The grant is tied to app installation uid, version, owner, and entrypoint. Each turn gets an attenuated invocation context and bounded calls; it does not broaden the app's backend authority."
      declaration={'"agent_entrypoints": {\n  "api": 1,\n  "entrypoints": ["capability_agent_demo"]\n}'}
      evidence={<EvidenceList items={[
        { label: "Entrypoint", value: <code>capability_agent_demo</code> },
        { label: "Resident target", value: <code>{BACKGROUND}</code> },
        { label: "Model", value: "None — deterministic broker demo" },
        { label: "Current grant", value: status === null ? "checking" : status.enabled ? "enabled" : "disabled" },
        { label: "Grant lifetime", value: "Current app version + owner" },
      ]} />}
    >
      <label className="nt-field">
        <span className="nt-label">Delegated goal</span>
        <input className="nt-input" maxLength={160} value={goal} onChange={(event) => setGoal(event.currentTarget.value)} />
      </label>
      <div className="nt-command-bar">
        <button className="nt-button nt-button--warning" disabled={Boolean(operation.busy) || Boolean(status?.enabled)} onClick={() => void statusAction("Agent Mode grant", () => requestAgentMode("capability_agent_demo"))} type="button">
          Enable Agent Mode
        </button>
        <button className="nt-button" disabled={Boolean(operation.busy) || !goal.trim() || !status?.enabled} onClick={() => void runTurn()} type="button">
          Run delegated turn
        </button>
        <button className="nt-button nt-button--secondary" disabled={Boolean(operation.busy)} onClick={() => void statusAction("status", () => getAgentModeStatus())} type="button">
          Status
        </button>
        <button className="nt-button nt-button--ghost" disabled={Boolean(operation.busy) || !status?.enabled} onClick={() => void statusAction("disable", () => disableAgentMode())} type="button">
          Disable
        </button>
      </div>
      {progress ? <pre className="nt-pre nt-pre--wrap ks-agent-progress" aria-live="polite">{progress}</pre> : null}
      <OperationResult {...operation} testId="capability-agent-result" />
    </CapabilityFrame>
  );
}

function BackgroundRequestsPage() {
  const operation = useOperation();
  const bus = useMemo(() => createMsgBusClient(), []);
  const [candidate, setCandidate] = useState<BackgroundCandidate | null>(null);

  const discover = () => operation.run("peer discovery", async () => {
    const inventory = await bus.listEndpoints(20);
    const endpoints = foreignToolEndpoints(inventory).slice(0, 8);
    for (const endpoint of endpoints) {
      try {
        const tools = await bus.listTools(endpoint, 10);
        const tool = tools.find(isEmptyReadTool);
        if (tool) {
          const next = {
            endpoint,
            tool: tool.name,
            title: tool.title ?? tool.name,
          } satisfies BackgroundCandidate;
          setCandidate(next);
          return next;
        }
      } catch {
        // A disconnected or undiscoverable endpoint is skipped.
      }
    }
    setCandidate(null);
    return {
      candidate: null,
      guidance: "Open another installed app with a resident tool, then refresh.",
    };
  });

  useEffect(() => {
    void discover();
  }, []);

  return (
    <CapabilityFrame
      status="setup"
      statusLabel={candidate ? "Two categories ready" : "Connection ready"}
      purpose="Let the resident ask for either a foreign tool call or its declared provider connection through normal kernel-owned UI."
      boundary="Same-app routes are intentionally prompt-free, so the frontend-tool demo selects a connected foreign endpoint. Both declared categories permit only asking; the nested operation still uses its ordinary target, schema, cancellation, and owner-consent checks."
      declaration={'"background_ui_requests": {\n  "api": 1,\n  "categories": ["frontend_tool", "connection"]\n}'}
      evidence={<EvidenceList items={[
        { label: "Requester", value: <code>kitchensink background</code> },
        { label: "Foreign target", value: <code>{candidate?.endpoint ?? "none discovered"}</code> },
        { label: "Read tool", value: <code>{candidate?.tool ?? "none discovered"}</code> },
        { label: "Frontend tool", value: candidate ? "ready" : "needs a peer app" },
        { label: "Connection", value: <code>openrouter · resident background</code> },
        { label: "Blanket approval", value: "Never" },
      ]} />}
    >
      <p className="nt-text">The first action selects only a foreign, zero-input, read-only tool. The second reuses the resident connection demo: a missing connection opens trusted kernel/provider UI, while an active connection is reused without another review.</p>
      <div className="nt-command-bar">
        <button className="nt-button" disabled={Boolean(operation.busy) || !candidate} onClick={() => void operation.run("background request", () => bus.callTool({ target: BACKGROUND, name: "capability_background_ui", arguments: { target: candidate!.endpoint, tool: candidate!.tool } }, 60))} type="button">
          Request peer tool
        </button>
        <button className="nt-button" disabled={Boolean(operation.busy)} onClick={() => void operation.run("background connection request", () => bus.callTool({ target: BACKGROUND, name: "capability_connection_connect", arguments: {} }, 15 * 60))} type="button">
          Request connection
        </button>
        <button className="nt-button nt-button--secondary" disabled={Boolean(operation.busy)} onClick={() => void discover()} type="button">
          Refresh peer tools
        </button>
      </div>
      <OperationResult {...operation} testId="capability-background-result" />
    </CapabilityFrame>
  );
}

function EthereumPage() {
  const operation = useOperation();
  const connection = useRef<EthereumProviderConnection | null>(null);
  const mounted = useRef(true);
  const accountAttempted = useRef(false);
  const [providerName, setProviderName] = useState<string | null>(null);
  const [chainId, setChainId] = useState<string | null>(null);
  const [accountRequestUsed, setAccountRequestUsed] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const current = connection.current;
      connection.current = null;
      if (current) void current.close().catch(() => undefined);
    };
  }, []);

  const connect = () => operation.run("wallet connection", async () => {
    const current = await connectEthereumProvider();
    if (!mounted.current) {
      await current.close().catch(() => undefined);
      throw new Error("Wallet connection finished after this page closed");
    }
    connection.current = current;
    setProviderName(current.info.name);
    try {
      const currentChain = await current.provider.request({ method: "eth_chainId" });
      if (typeof currentChain !== "string") {
        throw new Error("Wallet returned an invalid chain id");
      }
      setChainId(currentChain);
      accountAttempted.current = false;
      setAccountRequestUsed(false);
      return { provider: current.info, chainId: currentChain };
    } catch (error) {
      connection.current = null;
      setProviderName(null);
      setChainId(null);
      await current.close().catch(() => undefined);
      throw error;
    }
  });

  const accounts = () => operation.run("account request", async () => {
    if (!connection.current) throw new Error("Connect a wallet first");
    if (chainId !== "0x1") throw new Error("Switch the wallet to Ethereum mainnet first");
    if (accountAttempted.current) throw new Error("Account access was already requested for this session");
    accountAttempted.current = true;
    setAccountRequestUsed(true);
    return connection.current.provider.request({ method: "eth_requestAccounts" });
  });

  const close = () => operation.run("session close", async () => {
    if (!connection.current) return { closed: true };
    const current = connection.current;
    connection.current = null;
    setProviderName(null);
    setChainId(null);
    accountAttempted.current = false;
    setAccountRequestUsed(false);
    await current.close();
    return { closed: true };
  });

  return (
    <CapabilityFrame
      status="setup"
      statusLabel={providerName ? "Connected" : "Needs wallet"}
      purpose="Use a kernel-mediated EIP-1193 session with the declared method subset, then verify mainnet before one account request."
      boundary="The kernel source-binds the provider session and checks every method against the installed declaration. This demo separately requires eth_chainId 0x1 before account access; no signing or transaction method is declared."
      declaration={'"ethereum_provider": {\n  "api": 1,\n  "chains": [1],\n  "methods": ["eth_chainId", "eth_requestAccounts"]\n}'}
      evidence={<EvidenceList items={[
        { label: "Declared chain", value: "Ethereum mainnet (1)" },
        { label: "Wallet chain", value: <code>{chainId ?? "not read"}</code> },
        { label: "Provider", value: providerName ?? "not connected" },
        { label: "Transactions", value: "Not declared" },
        { label: "Session owner", value: "This live tile" },
      ]} />}
    >
      <p className="nt-text">A missing browser wallet is a valid setup state and is reported below without changing app data.</p>
      {providerName && chainId !== "0x1" ? <div className="nt-alert nt-alert--warning" role="status">Switch the connected wallet to Ethereum mainnet, close this session, then reconnect before requesting accounts.</div> : null}
      <div className="nt-command-bar">
        <button className="nt-button" disabled={Boolean(operation.busy) || Boolean(connection.current)} onClick={() => void connect()} type="button">Connect and read chain</button>
        <button className="nt-button nt-button--secondary" disabled={Boolean(operation.busy) || !connection.current || chainId !== "0x1" || accountRequestUsed} onClick={() => void accounts()} type="button">{accountRequestUsed ? "Accounts requested" : "Request accounts"}</button>
        <button className="nt-button nt-button--ghost" disabled={Boolean(operation.busy) || !connection.current} onClick={() => void close()} type="button">Close session</button>
      </div>
      <OperationResult {...operation} testId="capability-ethereum-result" />
    </CapabilityFrame>
  );
}

function ConnectionsPage() {
  const operation = useOperation();
  const bus = useMemo(() => createMsgBusClient(), []);
  const [connection, setConnection] = useState<ConnectionDemoState | null>(null);
  const call = (name: string, timeout: number) =>
    operation.run(name.replaceAll("_", " "), async () => {
      const raw = await bus.callTool({ target: BACKGROUND, name, arguments: {} }, timeout);
      const next = parseConnectionDemoState(raw);
      setConnection(next);
      return next;
    });

  useEffect(() => {
    void call("capability_connection_status", 30);
  }, []);

  const statusLabel = connection === null
    ? "Checking"
    : connection.connected
      ? "Connected"
      : "Disconnected";
  return (
    <CapabilityFrame
      status="partial"
      statusLabel={statusLabel}
      purpose="Complete a kernel-owned provider flow and deliver its resident credential only to this app's isolated background."
      boundary="The tile never receives the credential. Begin, completion, acquisition, disconnect, upgrade, and uninstall all recheck the exact app scope and provider declaration."
      declaration={'"connections": {\n  "api": 1,\n  "providers": [{\n    "provider": "openrouter",\n    "scopes": []\n  }]\n}'}
      evidence={<EvidenceList items={[
        { label: "Provider", value: <code>openrouter</code> },
        { label: "Delivery", value: "Resident background only" },
        { label: "Connection", value: connection?.connected ? "connected" : "not connected" },
        { label: "Credential rendered", value: "Never" },
      ]} />}
    >
      <p className="nt-text">Connect may open the provider flow. The resident proves credential delivery with a boolean and immediately discards the returned string.</p>
      <div className="nt-command-bar">
        <button className="nt-button" disabled={Boolean(operation.busy) || Boolean(connection?.connected)} onClick={() => void call("capability_connection_connect", 15 * 60)} type="button">Connect OpenRouter</button>
        <button className="nt-button nt-button--secondary" disabled={Boolean(operation.busy)} onClick={() => void call("capability_connection_status", 30)} type="button">Refresh status</button>
        <button className="nt-button nt-button--ghost" disabled={Boolean(operation.busy) || !connection?.connected} onClick={() => void call("capability_connection_disconnect", 60)} type="button">Disconnect</button>
      </div>
      <OperationResult {...operation} testId="capability-connections-result" />
    </CapabilityFrame>
  );
}

function StoragePage() {
  const operation = useOperation();
  const bus = useMemo(() => createMsgBusClient(), []);
  const [value, setValue] = useState("Survives resident reload");
  const call = (name: string, args: Record<string, JsonValue> = {}) =>
    operation.run(name.replaceAll("_", " "), () =>
      bus.callTool({ target: BACKGROUND, name, arguments: args }, 30));
  return (
    <CapabilityFrame
      status="partial"
      statusLabel="Origin isolated"
      purpose="Keep browser data on a stable, installation-specific resident origin while ordinary tiles remain opaque."
      boundary="Only the current nonce-prefixed background Host receives same-origin treatment. Reinstall changes the origin; disabling the capability makes future document loads opaque. Explicit quota and orphan cleanup policy remain open."
      declaration={'"persistent_browser_storage": {\n  "api": 1,\n  "surface": "background"\n}'}
      evidence={<EvidenceList items={[
        { label: "Storage surface", value: "Resident background" },
        { label: "Tile storage", value: "Opaque and ephemeral" },
        { label: "Reinstall isolation", value: "Fresh nonce + origin" },
        { label: "Demo key", value: <code>neutron.kitchensink.capabilities.storage.v1</code> },
      ]} />}
    >
      <label className="nt-field">
        <span className="nt-label">Resident value</span>
        <input className="nt-input" maxLength={240} value={value} onChange={(event) => setValue(event.currentTarget.value)} />
      </label>
      <div className="nt-command-bar">
        <button className="nt-button" disabled={Boolean(operation.busy) || !value} onClick={() => void call("capability_storage_write", { value })} type="button">Store in resident</button>
        <button className="nt-button nt-button--secondary" disabled={Boolean(operation.busy)} onClick={() => void call("capability_storage_status")} type="button">Read resident value</button>
        <button className="nt-button nt-button--ghost" disabled={Boolean(operation.busy)} onClick={() => void call("capability_storage_clear")} type="button">Clear</button>
      </div>
      <OperationResult {...operation} testId="capability-storage-result" />
    </CapabilityFrame>
  );
}

function CertifiedReadsPage({ runtime }: { runtime: CapabilityRuntime }) {
  const operation = useOperation();
  const publicationBase = publicationDemoBaseUrl();
  const immutableBase = immutableBlobBasePath();
  const mutablePath = mutableBlobPath();

  return (
    <CapabilityFrame
      status="ready"
      statusLabel="Synthesized by collection kind"
      purpose="Inspect the read routes that Neutron derives from three closed Certified Assets collection kinds."
      boundary="A publication always receives Host-bound GET/HEAD delivery. Immutable and mutable blobs always receive portable GET delivery. The app supplies only collection and mount ids plus the kind-specific prefix; it cannot author methods, authority mode, headers, cache policy, CORS, or certificate expressions."
      declaration={'"collections": [\n  {\n    "id": "publication_demo",\n    "mount": "publication_demo",\n    "kind": "publication"\n  },\n  {\n    "id": "immutable_blob_demo",\n    "mount": "blob_demo",\n    "kind": "immutable_blob",\n    "path_prefix": "/v1/immutable/"\n  },\n  {\n    "id": "mutable_blob_demo",\n    "mount": "blob_demo",\n    "kind": "mutable_blob",\n    "path_prefix": "/v1/mutable/"\n  }\n]'}
      evidence={<EvidenceList items={[
        { label: "Publication base", value: <code>{publicationBase}</code> },
        { label: "Publication delivery", value: "Host-bound GET / HEAD" },
        { label: "Immutable prefix", value: <code>{immutableBase}</code> },
        { label: "Mutable target", value: <code>{mutablePath}</code> },
        { label: "Portable proof target", value: runtime.canisterId ? <code>{runtime.canisterId}</code> : "Canister context loading" },
      ]} />}
    >
      <p className="nt-text">The publication path gains a kernel-allocated opaque segment and safe filename. Blob proofs are portable between supported gateway authorities, but a verifier must still pin and validate this Neutron canister principal.</p>
      <CopyValue label="Fixed mutable blob path" value={mutablePath} />
      <div className="nt-command-bar">
        <button className="nt-button nt-button--secondary" disabled={Boolean(operation.busy)} onClick={() => void operation.run("scope status", () => querySelf("asset_status", [null], 30))} type="button">Read scope generations</button>
      </div>
      <OperationResult {...operation} testId="capability-http-result" />
    </CapabilityFrame>
  );
}

function CertifiedAssetsPage({ runtime }: { runtime: CapabilityRuntime }) {
  const operation = useOperation();
  const [message, setMessage] = useState("Certified staged hello from Kitchen Sink");
  const [publicationToken, setPublicationToken] = useState(newCapabilityToken);
  const [immutableMessage, setImmutableMessage] = useState("Kitchen Sink immutable blob");
  const [immutableToken, setImmutableToken] = useState(newCapabilityToken);
  const [mutableMessage, setMutableMessage] = useState("Kitchen Sink inline/CAS blob");
  const [mutableToken, setMutableToken] = useState(newCapabilityToken);
  const publicationBase = publicationDemoBaseUrl();
  const mutablePath = mutableBlobPath();
  const messageBytes = new TextEncoder().encode(message).byteLength;
  const immutableBytes = new TextEncoder().encode(immutableMessage).byteLength;
  const mutableBytes = new TextEncoder().encode(mutableMessage).byteLength;

  const publish = () => operation.run("publish", async () => {
    if (!runtime.client) throw new Error("Canister client is not ready");
    return runtime.client.callDialog("publish_publication", [message, publicationToken], 60);
  });

  return (
    <CapabilityFrame
      status="ready"
      statusLabel="Three closed collection kinds"
      purpose="Exercise one staged publication, one staged content-addressed immutable blob, and one inline revision/tag-CAS mutable blob."
      boundary="The synchronous handle captures this app installation and its exact collections. Each kind fixes its locator, mutation, staging, delivery, cache, and CORS behavior. None can select a raw route, MIME policy, certificate tree, or another app's scope."
      declaration={'"certified_assets": {\n  "api": 2,\n  "max_entries": 8,\n  "max_committed_bytes": 16384,\n  "max_object_bytes": 4096,\n  "max_pending_stages": 1,\n  "max_staged_bytes": 4096,\n  "max_batch_operations": 2,\n  "max_batch_bytes": 4096,\n  "max_idempotency_receipts": 32,\n  "collections": [\n    {\n      "id": "publication_demo",\n      "mount": "publication_demo",\n      "kind": "publication",\n      "max_object_bytes": 2048\n    },\n    {\n      "id": "immutable_blob_demo",\n      "mount": "blob_demo",\n      "kind": "immutable_blob",\n      "path_prefix": "/v1/immutable/",\n      "max_object_bytes": 2048\n    },\n    {\n      "id": "mutable_blob_demo",\n      "mount": "blob_demo",\n      "kind": "mutable_blob",\n      "path_prefix": "/v1/mutable/",\n      "max_object_bytes": 2048\n    }\n  ]\n}'}
      evidence={<EvidenceList items={[
        { label: "Publication", value: <code>publication_demo · staged create-once</code> },
        { label: "Publication base", value: <code>{publicationBase}</code> },
        { label: "Immutable blob", value: <code>immutable_blob_demo · SHA-256 target</code> },
        { label: "Mutable blob", value: <code>mutable_blob_demo · inline CAS</code> },
        { label: "Mutable target", value: <code>{mutablePath}</code> },
        { label: "Committed quota", value: "8 entries / 16 KiB" },
      ]} />}
    >
      <label className="nt-field">
        <span className="nt-label">Staged publication text</span>
        <textarea className="nt-textarea" maxLength={2048} rows={4} value={message} onChange={(event) => setMessage(event.currentTarget.value)} />
        <span className="nt-help">{messageBytes} / 2,048 UTF-8 body bytes · token {publicationToken}</span>
      </label>
      <div className="nt-command-bar">
        <button className="nt-button" disabled={Boolean(operation.busy) || !runtime.client || !message || messageBytes > 2048} onClick={() => void publish()} type="button">Review publish</button>
        <button className="nt-button nt-button--secondary" disabled={Boolean(operation.busy)} onClick={() => { setPublicationToken(newCapabilityToken()); operation.clear(); }} type="button">New publication token</button>
        <button className="nt-button nt-button--ghost" disabled={Boolean(operation.busy) || !runtime.client || !message || messageBytes > 2048} onClick={() => void operation.run("delete", () => runtime.client!.callDialog("delete_publication", [message, publicationToken], 60))} type="button">Review conditional delete</button>
      </div>
      <p className="nt-text">Publish returns the exact generated URL path. Keep this page's body and token unchanged for a structurally identical retry or conditional delete.</p>
      <label className="nt-field">
        <span className="nt-label">Staged immutable blob</span>
        <textarea className="nt-textarea" maxLength={2048} rows={3} value={immutableMessage} onChange={(event) => setImmutableMessage(event.currentTarget.value)} />
        <span className="nt-help">{immutableBytes} / 2,048 UTF-8 body bytes · nonce {immutableToken}</span>
      </label>
      <div className="nt-command-bar">
        <button className="nt-button" disabled={Boolean(operation.busy) || !runtime.client || !immutableMessage || immutableBytes > 2048} onClick={() => void operation.run("immutable blob", () => runtime.client!.callDialog("publish_immutable_blob", [immutableMessage, immutableToken], 60))} type="button">Review immutable publish</button>
        <button className="nt-button nt-button--secondary" disabled={Boolean(operation.busy)} onClick={() => { setImmutableToken(newCapabilityToken()); operation.clear(); }} type="button">New immutable nonce</button>
      </div>
      <label className="nt-field">
        <span className="nt-label">Inline/CAS mutable blob</span>
        <textarea className="nt-textarea" maxLength={1800} rows={3} value={mutableMessage} onChange={(event) => setMutableMessage(event.currentTarget.value)} />
        <span className="nt-help">{mutableBytes} UTF-8 bytes before Candid encoding · nonce {mutableToken}</span>
      </label>
      <div className="nt-command-bar">
        <button className="nt-button" disabled={Boolean(operation.busy) || !runtime.client || mutableBytes > 1800} onClick={() => void operation.run("mutable blob CAS", () => runtime.client!.callDialog("put_mutable_blob", [mutableMessage, mutableToken], 60))} type="button">Review inline/CAS put</button>
        <button className="nt-button nt-button--secondary" disabled={Boolean(operation.busy)} onClick={() => { setMutableToken(newCapabilityToken()); operation.clear(); }} type="button">New CAS nonce</button>
        <button className="nt-button nt-button--secondary" disabled={Boolean(operation.busy)} onClick={() => void operation.run("usage", () => querySelf("certified_assets_usage", [null], 30))} type="button">Read scoped usage</button>
      </div>
      <CopyValue label="Fixed mutable blob path" value={mutablePath} />
      <OperationResult {...operation} testId="capability-assets-result" />
    </CapabilityFrame>
  );
}

type BackgroundCandidate = {
  endpoint: MsgBusEndpointId;
  tool: string;
  title: string;
};

type ConnectionDemoState = {
  connected: boolean;
  credentialDelivered: boolean;
};

function parseConnectionDemoState(value: JsonValue): ConnectionDemoState {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.connected !== "boolean" ||
    typeof value.credentialDelivered !== "boolean"
  ) {
    throw new Error("Resident returned invalid connection status");
  }
  return {
    connected: value.connected,
    credentialDelivered: value.credentialDelivered,
  };
}

function foreignToolEndpoints(value: JsonValue): MsgBusEndpointId[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const endpoints = (value as JsonObject).endpoints;
  if (!Array.isArray(endpoints)) return [];
  return endpoints.flatMap((entry) => {
    const endpointMatch = entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        typeof entry.endpoint === "string"
      ? /^app:([^:]+):(?:background|tile:[^:]{1,64}:instance:[^:]{1,192})$/.exec(
        entry.endpoint,
      )
      : null;
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      entry.connected !== true ||
      typeof entry.endpoint !== "string" ||
      typeof entry.appId !== "string" ||
      entry.appId === "kitchensink" ||
      endpointMatch === null ||
      !isValidAppId(endpointMatch[1])
    ) {
      return [];
    }
    return [entry.endpoint as MsgBusEndpointId];
  });
}

function isEmptyReadTool(tool: MsgBusToolDescriptor): boolean {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name)) return false;
  const required = tool.inputSchema.required;
  if (Array.isArray(required) && required.length > 0) return false;
  const effects = tool.annotations?.["neutron:effects"];
  return (
    Array.isArray(effects) &&
    effects.includes("read") &&
    !effects.some((effect) =>
      ["write", "signature_request", "user_visible_ui"].includes(String(effect)))
  );
}

function bytesHex(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function publicationDemoBaseUrl(): string {
  const parent = kernelParentOriginFromAppUrl(window.location.href);
  const base = parent ?? window.location.origin;
  return new URL("/app/kitchensink/_route/publication_demo/", base).href;
}

function immutableBlobBasePath(): string {
  return "/app/kitchensink/_route/blob_demo/v1/immutable/";
}

function mutableBlobPath(): string {
  return "/app/kitchensink/_route/blob_demo/v1/mutable/" +
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function newCapabilityToken(): string {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure browser randomness is unavailable");
  }
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const random = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(random, (byte) => alphabet[byte & 63]).join("");
}
