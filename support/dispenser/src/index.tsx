import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Actor,
  HttpAgent,
  type ActorMethod,
  type ActorSubclass,
} from "@dfinity/agent";
import { AccountIdentifier } from "@icp-sdk/canisters/ledger/icp";
import {
  REPOSITORY_LIMITS,
  clearPendingRepositorySetup,
  readPendingRepositorySetup,
  type RepositorySetupReference,
  type RepositoryStorage,
} from "neutron-tools/repository";
import {
  DEFAULT_LOCAL_HOST,
  envFlag,
  icHost,
} from "neutron-tools/src/runtime.js";
import {
  activationHash,
  captureProviderSetupHandoff,
  depositAccountIdentifier,
  depositIcrcAccountText,
  dispenserIdl,
  formatError,
  loadOrCreateProvisioningSecrets,
  neutronUrl,
  neutronHandoffUrl,
  principalText,
  provisioningStageName,
  unwrapOpt,
  unwrapResult,
  type DispenserActor,
  type ProvisioningSecrets,
  type ProvisioningStatus,
} from "./provisioning.ts";

import "./style.scss";

const MINIMUM_DEPOSIT_E8S = 200_000_000n;
const POLL_INTERVAL_MS = 10_000;
const DISPENSER_CANISTER_ID = process.env.DISPENSER_CANISTER_ID;
const LOCAL = envFlag(process.env.LOCAL);
const LOCAL_HOST = process.env.ICP_LOCAL_HOST || DEFAULT_LOCAL_HOST;

let dispenserActor: ActorSubclass<DispenserActor> | null = null;
type LedgerActor = {
  account_balance: ActorMethod<[{ account: Uint8Array }], { e8s: bigint }>;
};
type AccountFormat = "icrc" | "legacy";
let ledgerCanister: ActorSubclass<LedgerActor> | null = null;
let sharedAgent: HttpAgent | null = null;

const ledgerIdl: Parameters<typeof Actor.createActor>[0] = ({ IDL }) =>
  IDL.Service({
    account_balance: IDL.Func(
      [IDL.Record({ account: IDL.Vec(IDL.Nat8) })],
      [IDL.Record({ e8s: IDL.Nat64 })],
      ["query"],
    ),
  });

async function getAgent(secrets: ProvisioningSecrets): Promise<HttpAgent> {
  if (sharedAgent) return sharedAgent;
  sharedAgent = await HttpAgent.create({
    host: icHost({ local: LOCAL, localHost: LOCAL_HOST }),
    identity: secrets.identity,
    verifyQuerySignatures: !LOCAL,
  });
  if (LOCAL) await sharedAgent.fetchRootKey();
  return sharedAgent;
}

async function getDispenser(
  secrets: ProvisioningSecrets,
): Promise<ActorSubclass<DispenserActor>> {
  if (dispenserActor) return dispenserActor;
  dispenserActor = Actor.createActor<DispenserActor>(dispenserIdl, {
    agent: await getAgent(secrets),
    canisterId: DISPENSER_CANISTER_ID,
  });
  return dispenserActor;
}

async function getLedger(
  secrets: ProvisioningSecrets,
): Promise<ActorSubclass<LedgerActor>> {
  if (ledgerCanister) return ledgerCanister;
  ledgerCanister = Actor.createActor<LedgerActor>(ledgerIdl, {
    agent: await getAgent(secrets),
    canisterId: "ryjl3-tyaaa-aaaaa-aaaba-cai",
  });
  return ledgerCanister;
}

type AppProps = {
  initialSetup: RepositorySetupReference | null;
  initialSetupExpiresAt: number | null;
  setupError: string | null;
  secrets: ProvisioningSecrets | null;
  secretsError: string | null;
};

const awaitingStatus = (): ProvisioningStatus => ({
  stage: { awaiting_payment: null },
  canister_id: [],
});

const stagePresentation: Record<
  string,
  { kicker: string; title: string; detail: string; progress: number }
> = {
  transferring: {
    kicker: "Payment confirmed",
    title: "Converting ICP into cycles",
    detail:
      "Your payment is moving to the Cycles Minting Canister. The full balance, less the ledger fee, becomes compute for SushiOS.",
    progress: 18,
  },
  notifying_cmc: {
    kicker: "Cycles secured",
    title: "Creating your canister",
    detail:
      "The Internet Computer is allocating a new canister controlled by the dispenser for the few moments needed to install it.",
    progress: 34,
  },
  created: {
    kicker: "Canister created",
    title: "Installing the Neutron Kernel",
    detail: "The Neutron Kernel is being installed into your new canister.",
    progress: 50,
  },
  installed: {
    kicker: "Kernel installed",
    title: "Preparing self-ownership",
    detail:
      "Your canister is becoming its own controller before the dispenser seeds the SushiOS system files.",
    progress: 64,
  },
  controlled: {
    kicker: "Ownership prepared",
    title: "Seeding the operating system",
    detail:
      "SushiOS frontend assets, package metadata, and the network runtime configuration are being written.",
    progress: 78,
  },
  assets_seeded: {
    kicker: "System seeded",
    title: "Arming your activation link",
    detail:
      "The one-time activation hash is being stored so your authenticated principal—not the dispenser—becomes the owner.",
    progress: 90,
  },
  activated: {
    kicker: "Activation armed",
    title: "Removing the dispenser",
    detail:
      "The dispenser is retiring its final controller authority. Your canister will control itself.",
    progress: 97,
  },
};

function SushiMark() {
  return (
    <svg
      className="brand-mark"
      viewBox="0 0 32 32"
      role="img"
      aria-label="SushiOS"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="32" height="32" rx="8" fill="#0c0a12" />
      <circle cx="16" cy="16" r="10.6" fill="#1d3a2b" />
      <circle cx="16" cy="16" r="8.3" fill="#f3eee4" />
      <circle cx="14.3" cy="17.1" r="3.15" fill="#e4795c" />
      <circle cx="18.6" cy="14.2" r="2.15" fill="#7cc07f" />
    </svg>
  );
}

function ProvisioningSteps({
  stage,
  complete,
}: {
  stage: string;
  complete: boolean;
}) {
  const current = complete ? 3 : stage === "awaiting_payment" ? 1 : 2;
  const steps = [
    { number: 1, label: "Fund" },
    { number: 2, label: "Create" },
    { number: 3, label: "Activate" },
  ];
  return (
    <ol className="provisioning-steps" aria-label="Provisioning progress">
      {steps.map(({ number, label }) => {
        const state =
          number < current
            ? "complete"
            : number === current
              ? "current"
              : "upcoming";
        return (
          <li
            key={number}
            className={`provisioning-step ${state}`}
            aria-current={state === "current" ? "step" : undefined}
          >
            <span className="step-marker" aria-hidden="true">
              {state === "complete" ? "✓" : number}
            </span>
            <span className="step-label">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

export const App = ({
  initialSetup,
  initialSetupExpiresAt,
  setupError,
  secrets,
  secretsError,
}: AppProps) => {
  const principal = secrets?.identity.getPrincipal() ?? null;
  const account =
    principal === null
      ? null
      : depositAccountIdentifier({
          dispenserCanisterId: DISPENSER_CANISTER_ID,
          userPrincipal: principal,
        });
  const icrcAccount =
    principal === null
      ? null
      : depositIcrcAccountText({
          dispenserCanisterId: DISPENSER_CANISTER_ID,
          userPrincipal: principal,
        });
  const [balance, setBalance] = useState<bigint | null>(null);
  const [status, setStatus] = useState<ProvisioningStatus>(awaitingStatus);
  const [working, setWorking] = useState<string | false>(false);
  const [error, setError] = useState<string | false>(false);
  const [setup, setSetup] = useState(initialSetup);
  const [accountFormat, setAccountFormat] = useState<AccountFormat>("icrc");
  const [copiedAccount, setCopiedAccount] = useState<AccountFormat | null>(
    null,
  );
  const automaticProvisionStarted = useRef(false);

  const stage = provisioningStageName(status.stage);
  const statusCanister = unwrapOpt(status.canister_id);
  const neutronId =
    stage === "complete" && statusCanister
      ? principalText(statusCanister)
      : null;
  const mayProvision =
    secrets !== null &&
    (stage !== "awaiting_payment" ||
      (balance !== null && balance >= MINIMUM_DEPOSIT_E8S));
  const paymentDetected = balance !== null && balance >= MINIMUM_DEPOSIT_E8S;
  const creation = stagePresentation[stage] ?? {
    kicker: "Provisioning",
    title: working || "Preparing SushiOS",
    detail:
      "This operation is resumable. If a network response is interrupted, the dispenser continues from the last completed stage.",
    progress: 8,
  };
  const displayedAccount = accountFormat === "icrc" ? icrcAccount : account;

  const copyAccount = async (value: string | null, format: AccountFormat) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedAccount(format);
      window.setTimeout(() => setCopiedAccount(null), 2_000);
    } catch {
      setCopiedAccount(null);
    }
  };

  const consumeSetupHandoff = () => {
    if (!setup) return;
    // The activation code deliberately remains in local storage and in the
    // reproducible Neutron link. Only the optional repository handoff is
    // retired after launch.
    window.setTimeout(() => {
      stripFragmentBestEffort();
      setSetup(null);
      consumePendingSetup();
    }, 0);
  };

  const refreshState = async () => {
    if (!secrets || !account) return;
    const dispenser = await getDispenser(secrets);
    const nextStatus = await dispenser.status();
    setStatus(nextStatus);

    const ledger = await getLedger(secrets);
    const nextBalance = await ledger.account_balance({
      account: AccountIdentifier.fromHex(account).toUint8Array(),
    });
    setBalance(nextBalance.e8s);
  };

  const createNeutron = async () => {
    if (!secrets || !mayProvision) return;
    setWorking(stage === "awaiting_payment" ? "Creating SushiOS" : "Resuming");
    setError(false);
    try {
      const dispenser = await getDispenser(secrets);
      const hash = await activationHash(secrets.activationToken);
      unwrapResult(await dispenser.provision(hash));
      await refreshState();
    } catch (caught) {
      setError(formatError(caught));
      try {
        await refreshState();
      } catch {
        // Keep the original provisioning error visible.
      }
    }
    setWorking(false);
  };

  useEffect(() => {
    if (!secrets) return;
    let cancelled = false;
    const refresh = () => {
      void refreshState().catch((caught: unknown) => {
        if (!cancelled) setError(formatError(caught));
      });
    };
    refresh();
    const timer = window.setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (
      secrets &&
      stage !== "complete" &&
      (stage !== "awaiting_payment" ||
        (balance !== null && balance >= MINIMUM_DEPOSIT_E8S)) &&
      !automaticProvisionStarted.current
    ) {
      automaticProvisionStarted.current = true;
      void createNeutron();
    }
  }, [balance, secrets, stage]);

  useEffect(() => {
    const captureSameDocumentSetup = () => {
      // A fragment-only provider navigation does not reload the document.
      // Reload once so module-entry capture runs before handoff work.
      if (window.location.hash) window.location.reload();
    };
    window.addEventListener("hashchange", captureSameDocumentSetup);
    return () =>
      window.removeEventListener("hashchange", captureSameDocumentSetup);
  }, []);

  useEffect(() => {
    if (!setup || initialSetupExpiresAt === null) return;
    const remaining = initialSetupExpiresAt - Date.now();
    const expire = () => {
      stripFragmentBestEffort();
      setSetup(null);
      consumePendingSetup();
    };
    if (remaining <= 0) {
      expire();
      return;
    }
    const timer = window.setTimeout(expire, remaining);
    return () => window.clearTimeout(timer);
  }, [initialSetupExpiresAt, setup]);

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="site-header-inner">
          <a
            className="brand"
            href="https://ntron.net/"
            aria-label="SushiOS, powered by Neutron Kernel"
          >
            <SushiMark />
            <span>SushiOS</span>
          </a>
          <div className="network-label">
            <span className="network-dot" aria-hidden="true" />
            {LOCAL ? "PocketIC test network" : "Internet Computer"}
          </div>
        </div>
      </header>

      <main className="page">
        <div className="ambient-orbit orbit-one" aria-hidden="true" />
        <div className="ambient-orbit orbit-two" aria-hidden="true" />

        <section className="intro" aria-labelledby="page-title">
          <h1 id="page-title">SushiOS</h1>
          <p className="kernel-name">Neutron Kernel</p>
          <p className="eyebrow">Developer preview distribution</p>
          <p className="intro-copy">
            A personal cloud operating system for one owner, running entirely
            inside one self-controlled Internet Computer canister.
          </p>
        </section>

        <div className="flow">
          <ProvisioningSteps stage={stage} complete={neutronId !== null} />

          {secretsError ? (
            <div
              className="alert alert-error"
              role="alert"
              data-tid="dispenser-secrets-error"
            >
              <span className="alert-label">Saved credential error</span>
              {secretsError}
            </div>
          ) : null}

          {setupError ? (
            <div
              className="alert alert-error"
              role="alert"
              data-tid="dispenser-setup-error"
            >
              <span className="alert-label">Setup link error</span>
              {setupError}
            </div>
          ) : null}

          {error ? (
            <div
              className="alert alert-error"
              role="alert"
              data-tid="dispenser-error"
            >
              <span className="alert-label">Provisioning paused</span>
              {error}
            </div>
          ) : null}

          {neutronId && secrets ? (
            <section
              className="provision-card ready-card"
              data-tid="dispenser-neutron"
              aria-labelledby="ready-title"
            >
              <div className="card-legend">Self-controlled canister</div>
              <div className="success-mark" aria-hidden="true">
                <SushiMark />
                <span>✓</span>
              </div>
              <p className="card-kicker">Provisioning complete</p>
              <h2 id="ready-title">SushiOS is ready</h2>
              <p className="card-copy">
                The dispenser has removed itself. Authenticate once to consume
                the private activation link and authorize your principal.
              </p>
              <div className="canister-id">
                <span>Canister ID</span>
                <code>{neutronId}</code>
              </div>
              <a
                className="primary-action"
                rel="noopener noreferrer"
                target="_blank"
                data-tid="dispenser-neutron-link"
                href={neutronHandoffUrl({
                  base: neutronUrl(neutronId, {
                    local: LOCAL,
                    localHost: LOCAL_HOST,
                  }),
                  setup,
                  activationToken: secrets.activationToken,
                })}
                onClick={consumeSetupHandoff}
                onAuxClick={(event) => {
                  if (event.button === 1) consumeSetupHandoff();
                }}
              >
                <span>
                  {setup
                    ? "Open and activate SushiOS setup"
                    : "Open and activate SushiOS"}
                </span>
                <span className="action-arrow" aria-hidden="true">
                  ↗
                </span>
              </a>
              <p className="one-time-note">
                This is a one-time bearer link. The code deletes itself after it
                authorizes your authenticated principal.
              </p>
            </section>
          ) : null}

          {secrets && account && !neutronId && stage === "awaiting_payment" ? (
            <section
              className="provision-card payment-card"
              aria-labelledby="payment-title"
            >
              <div className="card-legend">Personal canister funding</div>
              <div className="payment-heading">
                <div>
                  <p className="card-kicker">ICP payment</p>
                  <h2 id="payment-title">Deploy your SushiOS</h2>
                  <p className="card-copy">
                    Send 2 ICP or more to the account below. We’ll start
                    automatically when it arrives.
                  </p>
                </div>
                <div className="price-stamp" aria-label="Minimum: 2 ICP">
                  <span className="price-value">2+</span>
                  <span className="price-unit">ICP</span>
                  <span className="price-caption">you choose the amount</span>
                </div>
              </div>

              {LOCAL ? (
                <div className="local-warning">
                  <span>Local test only</span>
                  Use PocketIC test ICP here. Never send real ICP to this
                  address.
                </div>
              ) : null}

              <div className="account-block">
                <div className="account-label">
                  <span>Deposit account</span>
                  <span className="account-network">ICP ledger</span>
                </div>
                <div
                  className="account-format-switch"
                  role="group"
                  aria-label="Deposit account format"
                >
                  <button
                    type="button"
                    className={
                      accountFormat === "icrc"
                        ? "account-format active"
                        : "account-format"
                    }
                    aria-pressed={accountFormat === "icrc"}
                    onClick={() => {
                      setAccountFormat("icrc");
                      setCopiedAccount(null);
                    }}
                  >
                    ICRC-1
                  </button>
                  <button
                    type="button"
                    className={
                      accountFormat === "legacy"
                        ? "account-format active"
                        : "account-format"
                    }
                    aria-pressed={accountFormat === "legacy"}
                    onClick={() => {
                      setAccountFormat("legacy");
                      setCopiedAccount(null);
                    }}
                  >
                    Legacy
                  </button>
                </div>
                <div className="account-row">
                  <code className="account" aria-live="polite">
                    {displayedAccount}
                  </code>
                  <button
                    type="button"
                    className="copy-button"
                    onClick={() =>
                      void copyAccount(displayedAccount, accountFormat)
                    }
                    aria-label={`Copy ${
                      accountFormat === "icrc" ? "ICRC-1" : "legacy"
                    } deposit account`}
                  >
                    {copiedAccount === accountFormat ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>

              <div className="balance-row" aria-live="polite">
                <div>
                  <span
                    className={`balance-pulse${
                      paymentDetected ? " detected" : ""
                    }`}
                    aria-hidden="true"
                  />
                  <span className="balance-label">
                    {paymentDetected ? "Payment detected" : "Watching ledger"}
                  </span>
                </div>
                <strong>
                  {balance === null ? "Checking…" : `${formatIcp(balance)} ICP`}
                </strong>
              </div>

              <button
                type="button"
                className="primary-action primary-button"
                data-tid="dispenser-create"
                disabled={!mayProvision || Boolean(working)}
                onClick={() => void createNeutron()}
              >
                {working
                  ? `${working}…`
                  : paymentDetected
                    ? "Create SushiOS"
                    : "Waiting for 2+ ICP"}
              </button>

              <details className="funding-details">
                <summary>Funding details</summary>
                <p>
                  Choose any amount of 2 ICP or more and send it in one
                  transfer. The detected balance, minus the ledger fee, goes to
                  the official Cycles Minting Canister (CMC), which burns the
                  ICP and converts its value into cycles for SushiOS.
                </p>
              </details>

              <div className="security-note">
                <span className="security-icon" aria-hidden="true">
                  ◇
                </span>
                <p>
                  <strong>Your recovery state is saved in this browser.</strong>
                  The provisioning private key and one-time activation code
                  survive a refresh. Keep this browser profile until activation
                  is complete.
                </p>
              </div>
            </section>
          ) : null}

          {secrets && account && !neutronId && stage !== "awaiting_payment" ? (
            <section
              className="provision-card creating-card"
              aria-labelledby="creating-title"
            >
              <div className="card-legend">Resumable provisioning</div>
              <div className="working-mark" aria-hidden="true">
                <SushiMark />
              </div>
              <p className="card-kicker">{creation.kicker}</p>
              <h2 id="creating-title">{creation.title}</h2>
              <p className="card-copy">{creation.detail}</p>

              <div
                className="creation-progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={creation.progress}
                aria-label="SushiOS creation progress"
              >
                <span style={{ width: `${creation.progress}%` }} />
              </div>
              <div className="stage-row" data-tid="dispenser-stage">
                <span>Current stage</span>
                <code>{stage.replaceAll("_", " ")}</code>
              </div>

              {working ? (
                <div className="working-copy" data-tid="dispenser-working">
                  <span className="working-dot" aria-hidden="true" />
                  {working}…
                </div>
              ) : (
                <button
                  type="button"
                  className="primary-action primary-button"
                  data-tid="dispenser-create"
                  onClick={() => void createNeutron()}
                >
                  Resume provisioning
                </button>
              )}
              <p className="one-time-note">
                You can safely refresh this page. Each completed network effect
                is recorded before the next one begins.
              </p>
            </section>
          ) : null}

          {!secretsError && !secrets ? (
            <div className="loading-state" aria-live="polite">
              Preparing a private provisioning identity…
            </div>
          ) : null}
        </div>

        <footer className="page-footer">
          <SushiMark />
          <p>
            SushiOS — Developer Preview
            <span>
              Powered by Neutron Kernel — GPLv3. Your canister controls itself.
            </span>
          </p>
        </footer>
      </main>
    </div>
  );
};

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element not found");
}

const {
  setup: initialSetup,
  expiresAt: initialSetupExpiresAt,
  error: setupError,
} = captureInitialSetup();
const provisioning = captureProvisioningSecrets();

const root = createRoot(container);
root.render(
  <App
    initialSetup={initialSetup}
    initialSetupExpiresAt={initialSetupExpiresAt}
    setupError={setupError}
    secrets={provisioning.secrets}
    secretsError={provisioning.error}
  />,
);

function captureProvisioningSecrets(): {
  secrets: ProvisioningSecrets | null;
  error: string | null;
} {
  try {
    return {
      secrets: loadOrCreateProvisioningSecrets({
        storage: window.localStorage,
        dispenserCanisterId: DISPENSER_CANISTER_ID,
      }),
      error: null,
    };
  } catch (caught) {
    return { secrets: null, error: formatError(caught) };
  }
}

function captureInitialSetup(): {
  setup: RepositorySetupReference | null;
  expiresAt: number | null;
  error: string | null;
} {
  const urlParams = new URLSearchParams(window.location.search);
  const querySetupKey = [...urlParams.keys()].find((key) =>
    ["repo", "manifest", "digest", "activate"].includes(key.toLowerCase()),
  );
  if (querySetupKey) {
    const clean = new URL(window.location.href);
    for (const key of [...clean.searchParams.keys()]) {
      if (
        ["repo", "manifest", "digest", "activate"].includes(key.toLowerCase())
      ) {
        clean.searchParams.delete(key);
      }
    }
    window.history.replaceState(window.history.state, "", clean.href);
    return {
      setup: null,
      expiresAt: null,
      error:
        "Repository setup and activation codes must be supplied in the URL fragment, not the query string.",
    };
  }

  if (window.location.hash) {
    const capturedAt = Date.now();
    const captured = captureProviderSetupHandoff({
      location: window.location,
      storage: sessionStorageAdapter(),
      history: window.history,
      now: capturedAt,
    });
    if (captured.setup !== null || captured.error !== null) return captured;
  }

  try {
    const pending = readPendingRepositorySetup(window.sessionStorage);
    return {
      setup: pending?.reference ?? null,
      expiresAt: pending
        ? pending.capturedAt + REPOSITORY_LIMITS.pendingSetupLifetimeMs
        : null,
      error: null,
    };
  } catch {
    return { setup: null, expiresAt: null, error: null };
  }
}

function formatIcp(e8s: bigint): string {
  const whole = e8s / 100_000_000n;
  const fraction = (e8s % 100_000_000n)
    .toString()
    .padStart(8, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function consumePendingSetup(): void {
  try {
    clearPendingRepositorySetup(window.sessionStorage);
  } catch {
    // An in-memory setup copy is cleared by the calling component.
  }
}

function sessionStorageAdapter(): RepositoryStorage {
  return {
    getItem: (key) => window.sessionStorage.getItem(key),
    setItem: (key, value) => window.sessionStorage.setItem(key, value),
    removeItem: (key) => window.sessionStorage.removeItem(key),
  };
}

function stripFragment(): void {
  if (!window.location.hash) return;
  const clean = new URL(window.location.href);
  clean.hash = "";
  window.history.replaceState(window.history.state, "", clean.href);
}

function stripFragmentBestEffort(): void {
  try {
    stripFragment();
  } catch {
    // The in-memory handoff is still retired; a browser that denies history
    // mutation keeps its original address-bar warning visible.
  }
}
