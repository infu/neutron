import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { cx, nt } from "neutron-design-system";
import {
  approveVetKeyDerivation,
  deriveVetKey,
  getVetKeyPublicKey,
  isVetKeysError,
  listVetKeys,
  requestVetKeys,
  type VetKeyPublicInfo,
  type VetKeySlotSummary,
} from "neutron-tools/app";
import {
  FIXTURE_SLOT,
  compactPrincipal,
  createSafePublicEvidence,
  fixtureSlot,
  installedFixtureAppId,
  samePublicBinding,
  type SafePublicEvidence,
} from "./evidence";
import { EphemeralDerivationSession } from "./derivation_session";
import { installLocalOriginProbe } from "./adversarial_probe";
import { installLocalRedactionProbe } from "./redaction_probe";
import "./style.scss";

type Operation =
  | "refresh"
  | "reserve"
  | "public"
  | "derive"
  | "confirm"
  | null;

const session = new EphemeralDerivationSession();
const fixtureAppId = installedFixtureAppId(window.location.href);
installLocalOriginProbe(fixtureAppId);
installLocalRedactionProbe(fixtureAppId);

export function App() {
  const [slot, setSlot] = useState<VetKeySlotSummary | null>(null);
  const [publicInfo, setPublicInfo] = useState<VetKeyPublicInfo | null>(null);
  const [evidence, setEvidence] = useState<SafePublicEvidence | null>(null);
  const [operation, setOperation] = useState<Operation>("refresh");
  const [verified, setVerified] = useState(false);
  const [message, setMessage] = useState("Reading this app's source-bound slot…");
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const deriveAttempt = useRef<Promise<void> | null>(null);

  const applyPublicInfo = useCallback((next: VetKeyPublicInfo) => {
    const safe = createSafePublicEvidence(next, fixtureAppId);
    if (!mounted.current) return;
    setPublicInfo(next);
    setEvidence(safe);
    setMessage("Public binding evidence is ready.");
  }, []);

  const fetchPublicInfo = useCallback(
    async (current: VetKeySlotSummary): Promise<void> => {
      const next = await getVetKeyPublicKey({
        slot: FIXTURE_SLOT,
        generation: current.currentGeneration,
      });
      applyPublicInfo(next);
    },
    [applyPublicInfo],
  );

  const refresh = useCallback(async () => {
    setOperation("refresh");
    setError(null);
    try {
      const result = await listVetKeys();
      const current = fixtureSlot(result.slots);
      if (!mounted.current) return;
      setSlot(current);
      if (current === null) {
        session.clear();
        setVerified(false);
        setPublicInfo(null);
        setEvidence(null);
        setMessage("The fixture slot has not been reserved.");
      } else {
        setMessage("Reserved slot found. Fetching its public proof…");
        await fetchPublicInfo(current);
      }
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason));
    } finally {
      if (mounted.current) setOperation(null);
    }
  }, [fetchPublicInfo]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const clear = () => session.clear();
    window.addEventListener("pagehide", clear);
    return () => {
      mounted.current = false;
      session.clear();
      window.removeEventListener("pagehide", clear);
    };
  }, [refresh]);

  const reserve = () => {
    if (operation !== null) return;
    setOperation("reserve");
    setError(null);
    setMessage("Waiting for Neutron's reservation decision…");
    // Lifecycle remains a focused, kernel-consented manager action. App
    // identity is intentionally absent and comes from this registered tile.
    const request = requestVetKeys({ action: "reserve", slot: FIXTURE_SLOT });
    void request.then(async (result) => {
      if (result.retired || result.slot === null) {
        throw new Error("Neutron did not reserve the fixture slot");
      }
      if (!mounted.current) return;
      setSlot(result.slot);
      setMessage("Slot reserved. Fetching its public proof…");
      await fetchPublicInfo(result.slot);
    }).catch((reason) => {
      if (mounted.current) setError(errorMessage(reason));
    }).finally(() => {
      if (mounted.current) setOperation(null);
    });
  };

  const reloadPublicInfo = () => {
    if (operation !== null || slot === null) return;
    setOperation("public");
    setError(null);
    void fetchPublicInfo(slot).catch((reason) => {
      if (mounted.current) setError(errorMessage(reason));
    }).finally(() => {
      if (mounted.current) setOperation(null);
    });
  };

  const verifyDerivation = () => {
    if (
      operation !== null ||
      slot === null ||
      slot.status !== "enabled" ||
      publicInfo === null ||
      evidence === null ||
      deriveAttempt.current !== null
    ) {
      return;
    }
    setError(null);
    setVerified(false);
    setOperation("derive");
    setMessage("Preparing a one-use encrypted derivation…");
    let transport;
    try {
      transport = session.begin();
    } catch (reason) {
      setOperation(null);
      setError(errorMessage(reason));
      return;
    }

    const expected = publicInfo;
    const attempt = deriveVetKey(
      {
        slot: FIXTURE_SLOT,
        generation: expected.generation,
        transportPublicKey: transport.transportPublicKey,
        requestNonce: transport.requestNonce,
      },
      {
        timeout: 90,
        onChallenge(next) {
          if (!mounted.current) return;
          setOperation("confirm");
          setMessage("Confirming the source-bound request…");
          // This is automatic protocol plumbing from the exact originating
          // endpoint, not a focused click or another user-consent step.
          void approveVetKeyDerivation({ challengeId: next.challengeId }).catch(
            (reason) => {
              if (mounted.current) setError(errorMessage(reason));
            },
          );
        },
      },
    ).then((result) => {
      if (!samePublicBinding(result.publicInfo, expected)) {
        throw new Error("The fixture key binding changed during derivation");
      }
      session.complete(result.encryptedKey, result.publicInfo);
      // The fixture proves successful verification but has no product data to
      // decrypt, so it immediately discards the opaque private handle.
      session.clear();
      if (!mounted.current) return;
      setVerified(true);
      setMessage("Encrypted derivation verified. The volatile key handle was discarded.");
    }).catch((reason) => {
      session.cancel();
      if (!mounted.current) return;
      setVerified(false);
      setError(errorMessage(reason));
    }).finally(() => {
      if (deriveAttempt.current === attempt) deriveAttempt.current = null;
      if (mounted.current) setOperation(null);
    });
    deriveAttempt.current = attempt;
  };

  const reserved = slot !== null;
  const enabled = slot?.status === "enabled";

  return (
    <main className={cx(nt.appFill, "vk-fixture-app")}>
      <div className="nt-page vk-fixture-shell">
        <header className="nt-page-header vk-fixture-header">
          <div>
            <p className="nt-eyebrow">Isolation fixture</p>
            <h1 className="nt-title">Same name. Separate key.</h1>
            <p className="nt-text">
              Both fixture apps declare <code>mailbox</code>. Neutron binds this
              exact installed app before any key work begins.
            </p>
          </div>
          <span className={cx("nt-tag", verified ? "nt-tag--success" : "")}
            data-tid="vetkeys-fixture-derivation-state">
            {verified ? "Derivation verified" : reserved ? "Ready" : "Not active"}
          </span>
        </header>

        <div className="nt-page-main vk-fixture-main">
          <section className="nt-panel vk-fixture-actions" aria-labelledby="fixture-actions-title">
            <div>
              <h2 id="fixture-actions-title">Key slot</h2>
              <p className="nt-text">
                Reserve once, inspect public evidence, then verify one encrypted derivation.
              </p>
            </div>
            <div className="vk-fixture-button-row">
              {!reserved ? (
                <button className="nt-button" data-tid="vetkeys-fixture-reserve"
                  disabled={operation !== null} onClick={reserve} type="button">
                  Reserve slot
                </button>
              ) : null}
              {reserved ? (
                <button className="nt-button nt-button--secondary"
                  data-tid="vetkeys-fixture-public" disabled={operation !== null}
                  onClick={reloadPublicInfo} type="button">
                  Refresh public proof
                </button>
              ) : null}
              {reserved ? (
                <button className="nt-button" data-tid="vetkeys-fixture-derive"
                  disabled={operation !== null || !enabled || evidence === null}
                  onClick={verifyDerivation} type="button">
                  Verify encrypted derivation
                </button>
              ) : null}
              <button className="nt-button nt-button--ghost" data-tid="vetkeys-fixture-refresh"
                disabled={operation !== null} onClick={() => void refresh()} type="button">
                Refresh status
              </button>
            </div>
            <div aria-live="polite" className={cx("nt-alert", error ? "nt-alert--danger" : "nt-alert--info")}
              data-tid="vetkeys-fixture-status" role="status">
              {error ?? (operation ? operationLabel(operation) : message)}
            </div>
          </section>

          <section className="nt-panel" aria-labelledby="fixture-proof-title">
            <div className="vk-fixture-section-heading">
              <div>
                <p className="nt-eyebrow">Public-only evidence</p>
                <h2 id="fixture-proof-title">Installed binding</h2>
              </div>
              <span className="nt-tag">No private bytes</span>
            </div>
            {evidence ? (
              <dl className="nt-kv vk-fixture-evidence" data-tid="vetkeys-fixture-evidence">
                <Evidence label="Source app"><code>{evidence.appId}</code></Evidence>
                <Evidence label="Declared slot"><code>{evidence.slot}</code></Evidence>
                <Evidence label="Neutron canister">
                  <code title={evidence.canisterPrincipal}>{compactPrincipal(evidence.canisterPrincipal)}</code>
                </Evidence>
                <Evidence label="Generation"><span>{evidence.generation}</span></Evidence>
                <Evidence label="Environment key"><code>{evidence.environmentKey}</code></Evidence>
                <Evidence label="Suite"><code>{evidence.suite}</code></Evidence>
                <Evidence label="Public fingerprint">
                  <code className="vk-fixture-long" title={evidence.publicFingerprint}>{evidence.publicFingerprint}</code>
                </Evidence>
                <Evidence label="Namespace evidence">
                  <code data-tid="vetkeys-fixture-namespace">{evidence.namespaceEvidence}</code>
                </Evidence>
              </dl>
            ) : (
              <p className="nt-empty" data-tid="vetkeys-fixture-empty-proof">
                Reserve the slot to fetch source-bound public information.
              </p>
            )}
          </section>

          <aside className="vk-fixture-note">
            <strong>What this proves</strong>
            <span>
              The SDK request contains no app id. The kernel derives <code>{fixtureAppId}</code>
              from this live tile and combines it with <code>{FIXTURE_SLOT}</code> in a never-reused binding.
            </span>
          </aside>
        </div>
      </div>
    </main>
  );
}

function Evidence({ label, children }: { label: string; children: React.ReactNode }) {
  return <><dt>{label}</dt><dd>{children}</dd></>;
}

function operationLabel(operation: Exclude<Operation, null>): string {
  switch (operation) {
    case "refresh": return "Reading this app's source-bound slot…";
    case "reserve": return "Waiting for Neutron's reservation decision…";
    case "public": return "Fetching public binding evidence…";
    case "derive": return "Preparing encrypted derivation…";
    case "confirm": return "Confirming and verifying the encrypted key…";
  }
}

function errorMessage(reason: unknown): string {
  if (isVetKeysError(reason)) {
    switch (reason.code) {
      case "not_declared": return "This installed app no longer declares the fixture slot.";
      case "not_reserved": return "Reserve the fixture slot before deriving.";
      case "manifest_suspended": return "The fixture declaration is suspended in Neutron Settings.";
      case "disabled": return "The fixture slot is disabled in Neutron Settings.";
      case "generation_unavailable": return "This fixture key generation is unavailable.";
      case "challenge_expired": return "The source confirmation expired. Start again.";
      case "challenge_consumed": return "That source confirmation was already used. Start again.";
      case "busy": return "Another key operation is running. Try again shortly.";
      case "low_cycles": return "Neutron needs more cycles before deriving this key.";
      case "source_gone": return "This tile or installed binding changed. Refresh and retry.";
      case "owner_required": return "Neutron authorization or lifecycle-manager authority changed. Refresh and retry.";
      case "invalid_request":
      case "key_unavailable":
      case "management_failure":
        return "The fixture key is unavailable right now.";
    }
  }
  return reason instanceof Error ? reason.message : "The fixture key operation failed.";
}

const container = document.getElementById("root");
if (!container) throw new Error("Root element not found");
createRoot(container).render(<App />);
