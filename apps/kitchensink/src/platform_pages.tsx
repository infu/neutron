import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  createMsgBusClient,
  onAppStateChange,
  openAppTile,
  querySelf,
  type JsonValue,
  type MethodSchemaJson,
  type MsgBusEndpointId,
  type NeutronCanisterClient,
  type TileContext,
} from "neutron-tools/app";
import { IoAdd, IoCubeOutline, IoRefreshOutline } from "react-icons/io5";
import {
  TRAY_DEMO_TOPIC,
  TrayDemoClient,
  type TrayDemoSnapshot,
} from "./tray_demo.ts";
import {
  CapabilityFrame,
  CopyValue,
  EvidenceList,
  OperationResult,
  formatError,
  useOperation,
} from "./lab_ui.tsx";
import {
  ICP_LEDGER,
  ICP_SWAP_AMOUNT_ATOMS,
  ICP_SWAP_AMOUNT_DISPLAY,
  NEUTRINITE_GOVERNANCE,
  WALLET_FUNDING_TARGET,
  WALLET_FUNDING_TOOL,
  callWalletFundingDemo,
  walletFundingDemoRequestExpired,
  walletFundingDemoResultIsTerminal,
  type WalletFundingDemoKind,
  type WalletFundingDemoRequest,
} from "./wallet_funding_demo.ts";
import {
  WALLET_FUNDING_UNREADABLE_ERROR,
  callWalletFundingIntent,
} from "./wallet_funding_intent_storage.ts";
import {
  WALLET_TOKEN_INFO_TOOL,
  callWalletTokenInfoDemo,
} from "./wallet_token_info_demo.ts";

export const PLATFORM_IDS = [
  "overview",
  "memory",
  "bus",
  "wallet_funding",
  "tray",
  "schemas",
  "data",
  "design",
] as const;

export type PlatformId = (typeof PLATFORM_IDS)[number];

export type PlatformRuntime = {
  client: NeutronCanisterClient | null;
  canisterId: string | null;
  schemas: Readonly<Record<string, MethodSchemaJson>>;
  schemaErrors: Readonly<Record<string, string>>;
  loading: boolean;
  error: string | null;
  schemasRequested: boolean;
  loadSchemas: () => void;
};

export function PlatformPage({
  id,
  runtime,
  context,
  navigate,
  methods,
}: {
  id: PlatformId;
  runtime: PlatformRuntime;
  context: TileContext;
  navigate: (id: string) => void;
  methods: readonly string[];
}) {
  switch (id) {
    case "overview": return <OverviewPage runtime={runtime} context={context} navigate={navigate} />;
    case "memory": return <MemoryPage runtime={runtime} />;
    case "bus": return <MessageBusPage />;
    case "wallet_funding": return <WalletFundingPage />;
    case "tray": return <TrayPage />;
    case "schemas": return <SchemasPage runtime={runtime} methods={methods} />;
    case "data": return <DataPage context={context} runtime={runtime} />;
    case "design": return <DesignPage />;
  }
}

function WalletFundingPage() {
  const bus = useMemo(() => createMsgBusClient(), []);
  const operation = useOperation();
  const direct = useWalletFundingIntent(bus, "direct");
  const allowance = useWalletFundingIntent(bus, "allowance");
  const intents = { direct, allowance } as const;

  const fund = (kind: WalletFundingDemoKind) => {
    const intent = intents[kind];
    const request = intent.request;
    if (!request) return;
    void operation.run(
      kind === "direct" ? "ICP transfer" : "ICP allowance",
      async () => {
        const result = await callWalletFundingDemo(bus, request);
        if (!walletFundingDemoResultIsTerminal(kind, request, result)) return result;
        try {
          const next = await callWalletFundingIntent(bus, {
            action: "complete",
            kind,
            requestId: request.requestId,
          });
          intent.setRequest(next);
          intent.setError(null);
          intent.setResetAllowed(false);
        } catch (reason) {
          intent.setRequest(null);
          intent.setResetAllowed(false);
          intent.setError(
            `Wallet returned a terminal result, but Kitchen Sink could not prepare its next saved intent: ${formatError(reason)}`,
          );
        }
        return result;
      },
    );
  };

  const discard = (kind: WalletFundingDemoKind) => {
    const intent = intents[kind];
    const request = intent.request;
    if (!request) return;
    void operation.run(
      kind === "direct"
        ? "discard direct funding intent"
        : "discard allowance funding intent",
      async () => {
        try {
          const stored = await callWalletFundingIntent(bus, {
            action: "discard",
            kind,
            requestId: request.requestId,
          });
          intent.setRequest(stored);
          intent.setError(null);
          intent.setResetAllowed(false);
          return {
            status: stored.requestId === request.requestId
              ? "unchanged"
              : "replaced",
            requestId: stored.requestId,
          };
        } catch (reason) {
          failClosedIntentMutation(intent, reason);
          throw reason;
        }
      },
    );
  };

  const resetUnreadable = (kind: WalletFundingDemoKind) => {
    const intent = intents[kind];
    void operation.run(`reset unreadable ${kind} funding intent`, async () => {
      try {
        const stored = await callWalletFundingIntent(bus, {
          action: "reset",
          kind,
        });
        intent.setRequest(stored);
        intent.setError(null);
        intent.setResetAllowed(false);
        return { status: "reset", requestId: stored.requestId };
      } catch (reason) {
        failClosedIntentMutation(intent, reason);
        throw reason;
      }
    });
  };

  const hasIntentError = Boolean(direct.error || allowance.error);

  return (
    <CapabilityFrame
      status="ready"
      statusLabel="Wallet provider"
      purpose="Exercise the two funding rails a swap app needs. Wallet—not Kitchen Sink or the Kernel—reads ICP metadata, calculates fees, shows the human-readable approval, and executes the ledger mutation."
      boundary="Each funding button sends one exact intent to Wallet. The separate metadata button reads through Wallet without opening its tile. For funding, the Kernel authenticates and routes the request and opens or focuses Wallet, but renders no token approval UI and does not interpret token details. One decision in Wallet authorizes only the frozen transfer or allowance. Kitchen Sink cannot alter the ledger, amount, or governance account, and it cannot consume an allowance owned by Neutrinite governance."
      declaration={`target = ${WALLET_FUNDING_TARGET}\ntools = ${WALLET_TOKEN_INFO_TOOL}, ${WALLET_FUNDING_TOOL}\nledger = ${ICP_LEDGER}\namount_atoms = ${ICP_SWAP_AMOUNT_ATOMS}\ngovernance = ${NEUTRINITE_GOVERNANCE}`}
      evidence={<EvidenceList items={[
        { label: "Ledger", value: <code>{ICP_LEDGER}</code> },
        { label: "Requested value", value: `${ICP_SWAP_AMOUNT_DISPLAY} (${ICP_SWAP_AMOUNT_ATOMS} e8s)` },
        { label: "Destination / spender", value: <code>{NEUTRINITE_GOVERNANCE}</code> },
        { label: "Provider", value: <code>{WALLET_FUNDING_TARGET} / {WALLET_FUNDING_TOOL}</code> },
        { label: "Funding consent", value: "One Wallet approval; no Kernel funding dialog or session grant" },
      ]} />}
    >
      <div className="nt-command-bar">
        <button
          className="nt-button nt-button--secondary"
          disabled={Boolean(operation.busy)}
          onClick={() => void operation.run(
            "live ICP Wallet token information",
            () => callWalletTokenInfoDemo(bus),
          )}
          type="button"
        >
          Read live ICP fee and Wallet balance
        </button>
      </div>
      <div className="ks-two-column">
        <section className="ks-action-group" aria-labelledby="wallet-direct-title">
          <h2 id="wallet-direct-title">Direct funding</h2>
          <p className="nt-text">Send exactly {ICP_SWAP_AMOUNT_DISPLAY} to the Neutrinite governance account. Wallet adds the live ICP transfer fee to the source debit.</p>
          <button className="nt-button" disabled={Boolean(operation.busy) || !direct.request} onClick={() => fund("direct")} type="button">Transfer {ICP_SWAP_AMOUNT_DISPLAY}</button>
        </section>
        <section className="ks-action-group" aria-labelledby="wallet-allowance-title">
          <h2 id="wallet-allowance-title">Transfer-from funding</h2>
          <p className="nt-text">Grant Neutrinite governance an allowance for a {ICP_SWAP_AMOUNT_DISPLAY} pull that expires five minutes after this intent was prepared. Wallet includes the live transfer fee; approval alone moves no ICP.</p>
          <button className="nt-button" disabled={Boolean(operation.busy) || !allowance.request} onClick={() => fund("allowance")} type="button">Approve {ICP_SWAP_AMOUNT_DISPLAY} swap funding</button>
        </section>
      </div>
      <aside className="ks-note" data-tid="wallet-funding-intents" role={hasIntentError ? "alert" : "note"}>
        <strong>{hasIntentError ? "Some saved intents are unavailable" : "Saved retry protection"}</strong>
        <span>Timeouts, errors, navigation, and reload keep each exact request ID until Wallet returns a matching terminal result.</span>
        <span>Warning: discarding or resetting an unresolved intent can duplicate an earlier action whose outcome is still unknown.</span>
        {(["direct", "allowance"] as const).map((kind) => {
          const intent = intents[kind];
          return (
            <div className="nt-command-bar" data-tid={`wallet-funding-intent-${kind}`} key={kind}>
              <span><strong>{kind === "direct" ? "Direct" : "Allowance"}:</strong> {intent.error ?? (intent.request
                ? walletFundingDemoRequestExpired(intent.request)
                  ? "deadline passed; retry still reconciles the saved ID"
                  : "saved and within its preparation deadline"
                : "preparing a durable request ID…")}</span>
              {intent.error ? (
                <>
                  <button className="nt-button nt-button--secondary" disabled={Boolean(operation.busy)} onClick={intent.retry} type="button">Retry {kind} storage</button>
                  {intent.resetAllowed ? (
                    <button className="nt-button nt-button--ghost" data-tid={`wallet-funding-reset-${kind}`} disabled={Boolean(operation.busy)} onClick={() => resetUnreadable(kind)} type="button">Discard unreadable {kind} record and prepare new</button>
                  ) : null}
                </>
              ) : intent.request ? (
                <button className="nt-button nt-button--ghost" data-tid={`wallet-funding-discard-${kind}`} disabled={Boolean(operation.busy)} onClick={() => discard(kind)} type="button">Discard {kind} intent and prepare new</button>
              ) : null}
            </div>
          );
        })}
      </aside>
      <OperationResult
        {...operation}
        idle="Wallet receipts appear here. Pending or ambiguous attempts reuse the same request ID instead of risking a duplicate transfer."
        testId="wallet-funding-result"
      />
      <aside className="ks-note"><strong>External spender boundary</strong><span>Only <code>{NEUTRINITE_GOVERNANCE}</code> can call <code>icrc2_transfer_from</code> against its allowance. This fixture stops after Wallet returns <code>approved</code> and does not perform the pull; a real swap backend named as spender would do that without a second user decision.</span></aside>
      <button className="nt-button nt-button--secondary" disabled={Boolean(operation.busy)} onClick={() => void operation.run("Wallet approvals", () => openAppTile({ appId: "wallet", tileId: "wallet", reuseExisting: true, view: "approvals" }))} type="button">Open Wallet approvals</button>
    </CapabilityFrame>
  );
}

function useWalletFundingIntent(
  bus: ReturnType<typeof createMsgBusClient>,
  kind: WalletFundingDemoKind,
) {
  const [request, setRequest] = useState<WalletFundingDemoRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resetAllowed, setResetAllowed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setError(null);
    setResetAllowed(false);
    void callWalletFundingIntent(bus, { action: "prepare", kind })
      .then((stored) => {
        if (active) setRequest(stored);
      })
      .catch((reason) => {
        if (!active) return;
        const message = formatError(reason);
        setRequest(null);
        setError(message);
        setResetAllowed(message.includes(WALLET_FUNDING_UNREADABLE_ERROR));
      });
    return () => {
      active = false;
    };
  }, [attempt, bus, kind]);

  return {
    request,
    error,
    resetAllowed,
    setRequest,
    setError,
    setResetAllowed,
    retry: () => setAttempt((value) => value + 1),
  };
}

function failClosedIntentMutation(
  intent: ReturnType<typeof useWalletFundingIntent>,
  reason: unknown,
): void {
  intent.setRequest(null);
  intent.setResetAllowed(false);
  intent.setError(
    `Saved intent change has an unknown outcome. Retry this rail before funding: ${formatError(reason)}`,
  );
}

function OverviewPage({
  runtime,
  context,
  navigate,
}: {
  runtime: PlatformRuntime;
  context: TileContext;
  navigate: (id: string) => void;
}) {
  const capabilities = [
    ["public_ingress", "Public ingress", "Public Candid endpoints with explicit caller policies"],
    ["backend_calls", "Backend calls", "Exact remote method access"],
    ["https_outcalls", "HTTPS outcalls", "Exact metered public HTTPS prefix"],
    ["randomness", "Randomness", "Metered consensus seed"],
    ["chain_key_signing", "Chain-key assertions", "Domain-separated threshold receipt"],
    ["vetkeys", "Private key slots", "Installation-isolated key namespace"],
    ["scheduled_tasks", "Scheduled tasks", "Leased daily callback"],
    ["stable_store", "Stable Store", "Bounded revisioned app records"],
    ["self_calls", "Preapproved calls", "Exact same-app fast paths"],
    ["agent_entrypoints", "Agent entrypoints", "Temporary delegated context"],
    ["background_requests", "Background prompts", "Resident may ask, not approve"],
    ["ethereum", "Ethereum provider", "Declared EIP-1193 subset"],
    ["connections", "Provider connections", "Resident credential delivery"],
    ["storage", "Browser storage", "Stable resident origin"],
    ["certified_reads", "Certified reads", "Routes derived from collection kinds"],
    ["certified_assets", "Certified assets", "Bounded public store"],
  ] as const;

  return (
    <section className="ks-overview-page">
      <section className="ks-metrics" aria-label="Capability lab summary">
        <Metric label="Labs" value="16 capability views" detail="Synthesized reads included" />
        <Metric label="Surfaces" value="2 tiles + tray" detail="Resident background included" />
        <Metric label="Backend" value="Scoped handles" detail="No universal authority object" />
        <Metric label="Development" value="Routes gated" detail="Gateway verification remains open" />
      </section>
      <section className="ks-overview-context">
        <div>
          <p className="nt-eyebrow">Installed context</p>
          <h2>Source-bound runtime</h2>
        </div>
        <dl className="ks-evidence-list">
          <div><dt>Canister</dt><dd><code>{runtime.canisterId ?? "loading"}</code></dd></div>
          <div><dt>Workspace</dt><dd>{context.workspace ?? "unknown"}</dd></div>
          <div><dt>Tile instance</dt><dd><code>{context.instance ?? "unknown"}</code></dd></div>
          <div><dt>Schemas</dt><dd>{runtime.loading ? "loading" : runtime.schemasRequested ? `${Object.keys(runtime.schemas).length} ready` : "load on demand"}</dd></div>
        </dl>
      </section>
      <section aria-labelledby="capability-index-title">
        <div className="ks-section-heading">
          <div>
            <p className="nt-eyebrow">Capability catalogue</p>
            <h2 id="capability-index-title">Runnable, scoped examples</h2>
          </div>
          <span className="nt-badge nt-badge--info">development app</span>
        </div>
        <div className="ks-capability-index">
          {capabilities.map(([id, title, description]) => (
            <button key={id} onClick={() => navigate(id)} type="button">
              <span aria-hidden="true"><IoCubeOutline /></span>
              <strong>{title}</strong>
              <small>{description}</small>
            </button>
          ))}
        </div>
      </section>
    </section>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <article className="nt-metric">
      <span className="nt-metric-label">{label}</span>
      <strong className="nt-metric-value">{value}</strong>
      <span className="nt-metric-detail">{detail}</span>
    </article>
  );
}

function MemoryPage({ runtime }: { runtime: PlatformRuntime }) {
  const operation = useOperation();
  const nameErrorId = useId();
  const emailErrorId = useId();
  const [name, setName] = useState("Ada Lovelace");
  const [email, setEmail] = useState("ada@example.test");
  const [notes, setNotes] = useState("Stored in Kitchen Sink's managed memory root.");
  const [subscribed, setSubscribed] = useState(true);
  const nameError = name.trim() ? null : "Name is required.";
  const emailError = /^[^@\s]+@[^@\s]+$/u.test(email) ? null : "Enter an email-like value.";

  return (
    <section className="ks-platform-page">
      <header className="ks-section-heading">
        <div><p className="nt-eyebrow">Managed backend memory</p><h2>Durable profile form</h2></div>
        <span className="nt-tag nt-tag--success">memory v1</span>
      </header>
      <form className="nt-form ks-form-surface" onSubmit={(event) => {
        event.preventDefault();
        if (!runtime.client || nameError || emailError) return;
        void operation.run("reviewed save", () => runtime.client!.callDialog(
          "save_profile",
          [[name.trim(), email.trim(), notes, subscribed]],
          60,
        ));
      }}>
        <div className="nt-form-grid nt-form-grid--two">
          <label className="nt-field">
            <span className="nt-label">Name</span>
            <input aria-describedby={nameError ? nameErrorId : undefined} aria-invalid={Boolean(nameError)} className="nt-input" maxLength={80} value={name} onChange={(event) => setName(event.currentTarget.value)} />
            {nameError ? <span className="nt-error" id={nameErrorId}>{nameError}</span> : null}
          </label>
          <label className="nt-field">
            <span className="nt-label">Email</span>
            <input aria-describedby={emailError ? emailErrorId : undefined} aria-invalid={Boolean(emailError)} className="nt-input" maxLength={160} type="email" value={email} onChange={(event) => setEmail(event.currentTarget.value)} />
            {emailError ? <span className="nt-error" id={emailErrorId}>{emailError}</span> : null}
          </label>
        </div>
        <label className="nt-field"><span className="nt-label">Notes</span><textarea className="nt-textarea" maxLength={2000} rows={5} value={notes} onChange={(event) => setNotes(event.currentTarget.value)} /></label>
        <label className="ks-check-row"><input checked={subscribed} className="nt-checkbox" onChange={(event) => setSubscribed(event.currentTarget.checked)} type="checkbox" /><span>Subscribed to release notes</span></label>
        <div className="nt-command-bar">
          <button className="nt-button" disabled={Boolean(operation.busy) || !runtime.client || Boolean(nameError || emailError)} type="submit">Review save in kernel</button>
          <button className="nt-button nt-button--secondary" disabled={Boolean(operation.busy)} onClick={() => void operation.run("profile read", async () => {
            const result = await querySelf<string>("read_profile", [null], 20);
            const profile = parseProfile(result);
            setName(profile.name);
            setEmail(profile.email);
            setNotes(profile.notes);
            setSubscribed(profile.subscribed);
            return result;
          })} type="button">Read into form</button>
        </div>
      </form>
      <OperationResult {...operation} />
      <aside className="ks-note"><strong>Lifecycle boundary</strong><span>The schema is compiler-owned and app-namespaced. A tile cannot safely upgrade or uninstall its containing actor, so the real lifecycle proof runs outside the sandbox.</span></aside>
      <CopyValue label="Compiler lifecycle invariants" value="npm --workspace neutron-compiler test" />
    </section>
  );
}

type LiveEndpoint = {
  endpoint: MsgBusEndpointId;
  appId?: string;
  role: string;
  tileId?: string;
  connected: boolean;
};

function MessageBusPage() {
  const bus = useMemo(() => createMsgBusClient(), []);
  const operation = useOperation();
  const [endpoints, setEndpoints] = useState<LiveEndpoint[]>([]);
  const companion = endpoints.find((endpoint) => endpoint.appId === "kitchensink" && endpoint.tileId === "companion" && endpoint.connected);

  const discover = async () => {
    const raw = await bus.listEndpoints(20);
    const parsed = parseEndpoints(raw);
    setEndpoints(parsed);
    return { endpoints: parsed };
  };

  const refresh = () => operation.run("endpoint discovery", discover);

  const openAndDiscover = () => operation.run("open companion", async () => {
    const opened = await openAppTile({
      appId: "kitchensink",
      tileId: "companion",
      reuseExisting: true,
    });
    for (const delay of [0, 120, 320, 700]) {
      if (delay) await wait(delay);
      const inventory = await discover();
      if (inventory.endpoints.some((endpoint) =>
        endpoint.appId === "kitchensink" &&
        endpoint.tileId === "companion" &&
        endpoint.connected)) {
        return { opened, ...inventory };
      }
    }
    return { opened, endpoints: [], guidance: "Companion is opening; refresh once it appears." };
  });

  useEffect(() => { void refresh(); }, []);

  return (
    <section className="ks-platform-page">
      <header className="ks-section-heading"><div><p className="nt-eyebrow">Ambient frontend broker</p><h2>Live endpoint and tool routing</h2></div><span className="nt-tag">same-app route</span></header>
      <p className="nt-text">Open the companion tile, discover its exact live endpoint, then call the exposed snapshot tool. Cross-app targets would use the kernel permission dialog.</p>
      <div className="nt-command-bar">
        <button className="nt-button" disabled={Boolean(operation.busy)} onClick={() => void openAndDiscover()} type="button">Open companion</button>
        <button className="nt-button nt-button--secondary" disabled={Boolean(operation.busy)} onClick={() => void refresh()} type="button"><IoRefreshOutline aria-hidden="true" />Refresh endpoints</button>
        <button className="nt-button nt-button--secondary" disabled={Boolean(operation.busy) || !companion} onClick={() => void operation.run("snapshot tool", () => bus.callTool({ target: companion!.endpoint, name: "tile_snapshot", arguments: {} }, 30))} type="button">Call snapshot</button>
      </div>
      <div className="ks-endpoint-list">
        {endpoints.map((endpoint) => <div key={endpoint.endpoint}><span className={`nt-status-dot ${endpoint.connected ? "nt-status-dot--success" : "nt-status-dot--danger"}`} /><code>{endpoint.endpoint}</code><span>{endpoint.role}</span></div>)}
        {endpoints.length === 0 ? <p className="nt-empty">No endpoint inventory yet.</p> : null}
      </div>
      <OperationResult {...operation} />
    </section>
  );
}

function TrayPage() {
  const client = useMemo(() => new TrayDemoClient(), []);
  const [snapshot, setSnapshot] = useState<TrayDemoSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const operation = useOperation();
  const requestSequence = useRef(0);

  const acceptSnapshot = (next: TrayDemoSnapshot) => {
    setSnapshot((current) =>
      !current || BigInt(next.revision) >= BigInt(current.revision) ? next : current,
    );
  };

  const refresh = async () => {
    const sequence = ++requestSequence.current;
    try {
      const next = await client.snapshot();
      acceptSnapshot(next);
      if (sequence === requestSequence.current) setError(null);
      return next;
    } catch (reason) {
      if (sequence === requestSequence.current) setError(formatError(reason));
      throw reason;
    }
  };

  useEffect(() => {
    void refresh().catch(() => undefined);
    return onAppStateChange(TRAY_DEMO_TOPIC, () => { void refresh().catch(() => undefined); });
  }, [client]);

  const mutate = (label: string, action: () => Promise<TrayDemoSnapshot>) =>
    operation.run(label, async () => {
      const sequence = ++requestSequence.current;
      try {
        const next = await action();
        acceptSnapshot(next);
        if (sequence === requestSequence.current) setError(null);
        return next;
      } catch (reason) {
        if (sequence === requestSequence.current) setError(formatError(reason));
        throw reason;
      }
    });

  const health = error
    ? { label: "Resident unavailable", className: "nt-status-dot--danger" }
    : snapshot
      ? { label: "Resident ready", className: "nt-status-dot--success" }
      : { label: "Loading resident", className: "nt-status-dot--warning" };

  return (
    <section className="ks-platform-page">
      <header className="ks-section-heading"><div><p className="nt-eyebrow">Resident + tray</p><h2>Tray popout demo</h2></div><span className="ks-inline-health"><span aria-hidden="true" className={`nt-status-dot ${health.className}`} /><span>{health.label}</span><span className="nt-badge nt-badge--info">{snapshot ? `${snapshot.unread} badge item${snapshot.unread === 1 ? "" : "s"}` : "—"}</span></span></header>
      <p className="nt-text">The resident owns a bounded popout snapshot and starts without a badge. Add a demo item to see the tray update; revision ordering prevents older in-flight replies from replacing newer state.</p>
      <div className="nt-command-bar">
        <button className="nt-button" disabled={Boolean(operation.busy)} onClick={() => void mutate("add demo item", () => client.add())} type="button"><IoAdd aria-hidden="true" />Add demo item</button>
        <button className="nt-button nt-button--secondary" disabled={Boolean(operation.busy) || !snapshot?.unread} onClick={() => void mutate("clear badge", () => client.markAllRead())} type="button">Clear badge</button>
        <button className="nt-button nt-button--ghost" disabled={Boolean(operation.busy)} onClick={() => void operation.run("refresh", refresh)} type="button">Refresh</button>
      </div>
      <div aria-busy={!snapshot && !error} className="ks-notification-list">
        {snapshot?.notifications.map((notification) => (
          <article key={notification.id} className={notification.read ? "is-read" : ""}>
            <span className={`nt-status-dot ${notification.read ? "nt-status-dot--info" : "nt-status-dot--success"}`} />
            <div><span className="nt-sr-only">{notification.read ? "Cleared" : "Active"}: </span><strong>{notification.title}</strong><small>{notification.detail}</small></div><code>{notification.time}</code>
          </article>
        ))}
        {!snapshot && !error ? (
          <div
            aria-label="Loading tray demo"
            className="nt-state nt-state--loading"
            role="status"
          >
            <span aria-hidden="true" className="nt-spinner" />
          </div>
        ) : null}
        {snapshot?.notifications.length === 0 ? <div className="nt-state nt-state--empty"><strong>No demo items yet</strong><span>The tray starts quiet. Add one to demonstrate its live badge.</span></div> : null}
      </div>
      {error ? <div className="nt-alert nt-alert--danger" role="alert"><strong>Resident unavailable</strong><span>{error}</span><button className="nt-button nt-button--secondary nt-button--sm" disabled={Boolean(operation.busy)} onClick={() => void operation.run("retry", refresh)} type="button">Retry</button></div> : null}
      <OperationResult {...operation} />
    </section>
  );
}

function SchemasPage({ runtime, methods }: { runtime: PlatformRuntime; methods: readonly string[] }) {
  const [selected, setSelected] = useState(methods.includes("read_profile") ? "read_profile" : methods[0] ?? "");
  const schema = runtime.schemas[selected];
  useEffect(() => runtime.loadSchemas(), [runtime.loadSchemas]);
  return (
    <section className="ks-schema-layout">
      <section className="ks-schema-methods" aria-labelledby="schema-methods-title">
        <h2 id="schema-methods-title">Installed methods</h2>
        <ul>
          {methods.map((method) => (
            <li key={method}>
              <button aria-current={selected === method ? "true" : undefined} onClick={() => setSelected(method)} type="button">
                <code>{method}</code>
                <span>{runtime.schemaErrors[method] ? "error" : schemaKind(runtime.schemas[method])}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className="ks-schema-viewer" aria-labelledby="schema-viewer-title">
        <div className="ks-section-heading"><div><p className="nt-eyebrow">Live metadata</p><h2 id="schema-viewer-title">{selected}</h2></div><span className="nt-tag">{schemaKind(schema)}</span></div>
        <pre className="nt-pre nt-pre--wrap" data-tid={`kitchen-schema-${selected}`}>
          {schema ? JSON.stringify(schema, null, 2) : runtime.schemaErrors[selected] ?? (runtime.loading ? "Loading…" : "Unavailable")}
        </pre>
      </section>
    </section>
  );
}

function DataPage({ context, runtime }: { context: TileContext; runtime: PlatformRuntime }) {
  const principal = "2muv7-iopdh-zcmmn-yb3ls-ane4w-ei7h2-gketm-rnyra-cxzmm-y6qy2-wqe";
  const hash = "4e39c4c2bfcb371ede19469edc83a5424687d7e598f50c27700d309d7b035309";
  const nested = { context, canister: runtime.canisterId, capability: "backend_calls", scope: { kind: "exact", principal, method: "very_long_method_name_that_must_wrap" }, hash };
  return (
    <section className="ks-platform-page">
      <header className="ks-section-heading"><div><p className="nt-eyebrow">Dense data</p><h2>Copy, wrapping, and JSON containment</h2></div></header>
      <p className="nt-text">These are inert layout fixtures, not verified runtime identity or authority. The live Neutron canister is shown separately.</p>
      <div className="ks-two-column"><CopyValue label="Fixture principal" value={principal} /><CopyValue label="Live Neutron canister" value={runtime.canisterId ?? "unavailable"} /><CopyValue label="Fixture module hash" value={hash} /></div>
      <pre className="nt-json" data-tid="kitchen-json-fixture">{JSON.stringify(nested, null, 2)}</pre>
    </section>
  );
}

function DesignPage() {
  const tabs = ["Controls", "Inputs", "States", "Settings"] as const;
  const [active, setActive] = useState<(typeof tabs)[number]>("Controls");
  const [runtimeOpen, setRuntimeOpen] = useState(false);

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    const name = tabs[next];
    if (!name) return;
    setActive(name);
    document.getElementById(`design-tab-${name.toLowerCase()}`)?.focus();
  };

  return (
    <section className="ks-platform-page">
      <div className="nt-alert"><strong>Visual component examples</strong><span>Controls on this page are local, inert fixtures. They do not call the kernel or change backend data.</span></div>
      <div className="nt-tabs">
        <div className="nt-tab-list" role="tablist" aria-label="Design sections">
          {tabs.map((tab, index) => <button aria-controls={`design-panel-${tab.toLowerCase()}`} aria-selected={active === tab} className="nt-tab" id={`design-tab-${tab.toLowerCase()}`} key={tab} onClick={() => setActive(tab)} onKeyDown={(event) => onTabKey(event, index)} role="tab" tabIndex={active === tab ? 0 : -1} type="button">{tab}</button>)}
        </div>
        <section id="design-panel-controls" role="tabpanel" aria-labelledby="design-tab-controls" className="ks-design-panel" hidden={active !== "Controls"} tabIndex={0}>
          <div className="nt-command-bar"><button className="nt-button" type="button">Primary</button><button className="nt-button nt-button--secondary" type="button">Secondary</button><button className="nt-button nt-button--warning" type="button">Warning</button><button className="nt-button nt-button--danger" type="button">Danger</button><button aria-label="Add tile" className="nt-icon-button" type="button"><IoAdd /></button></div>
          <div className="nt-dialog" role="group" aria-label="Replace durable profile cache"><div className="nt-dialog-body"><h2>Replace durable profile cache</h2><p className="nt-text">Critical app actions explain consequences before opening kernel review.</p></div><div className="nt-dialog-actions"><button className="nt-button nt-button--secondary" type="button">Cancel</button><button className="nt-button nt-button--critical" type="button">Replace cache</button></div></div>
        </section>
        <section id="design-panel-inputs" role="tabpanel" aria-labelledby="design-tab-inputs" className="nt-form ks-design-panel" hidden={active !== "Inputs"} tabIndex={0}><label className="nt-field"><span className="nt-label">Search</span><input className="nt-input" defaultValue="capability" type="search" /></label><label className="nt-field"><span className="nt-label">Mode</span><select className="nt-select" defaultValue="safe"><option value="safe">Safe</option><option value="audit">Audit</option></select></label><label className="nt-field"><span className="nt-label">Description</span><textarea className="nt-textarea" defaultValue="Bounded app-owned value" rows={3} /></label></section>
        <section
          aria-labelledby="design-tab-states"
          className="ks-design-panel nt-grid"
          hidden={active !== "States"}
          id="design-panel-states"
          role="tabpanel"
          tabIndex={0}
        >
          <div
            aria-busy="true"
            aria-label="Loading example"
            className="nt-state nt-state--loading"
            data-tid="kitchen-loading-state"
            role="status"
          >
            <span aria-hidden="true" className="nt-spinner" />
          </div>
          <div className="nt-alert">Informational state</div>
          <div className="nt-alert nt-alert--success">Successful operation</div>
          <div className="nt-alert nt-alert--warning">Owner attention needed</div>
          <div className="nt-alert nt-alert--danger">Operation failed</div>
        </section>
        <section id="design-panel-settings" role="tabpanel" aria-labelledby="design-tab-settings" className="ks-design-panel" hidden={active !== "Settings"} tabIndex={0}>
          <section className="nt-section"><header className="nt-section-header"><h2 className="nt-section-heading">Example settings row</h2><span className="nt-section-count">1</span></header><div className="nt-settings-list"><div className="nt-settings-row"><span className="nt-settings-icon"><IoCubeOutline /></span><span className="nt-settings-main"><strong className="nt-settings-title">Kitchen Sink</strong><span className="nt-settings-description">Capability development lab</span></span><span className="nt-settings-meta"><span>0.1.0</span><span>resident</span></span></div></div></section>
          <section className="nt-disclosure"><button aria-controls="design-runtime-content" aria-expanded={runtimeOpen} className="nt-disclosure-trigger" data-tid="kitchen-disclosure-toggle" onClick={() => setRuntimeOpen((value) => !value)} type="button"><span className="nt-disclosure-copy"><strong className="nt-disclosure-title">Runtime</strong><span className="nt-disclosure-description">Compiler, memory, and capability details</span></span></button><div className="nt-disclosure-content" hidden={!runtimeOpen} id="design-runtime-content"><p className="nt-text">16 declared capabilities · one managed memory root · two tiles</p></div></section>
        </section>
      </div>
    </section>
  );
}

function parseEndpoints(value: JsonValue): LiveEndpoint[] {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.endpoints)) return [];
  return value.endpoints.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.endpoint !== "string" || typeof entry.role !== "string" || typeof entry.connected !== "boolean") return [];
    return [{ endpoint: entry.endpoint as MsgBusEndpointId, role: entry.role, connected: entry.connected, ...(typeof entry.appId === "string" ? { appId: entry.appId } : {}), ...(typeof entry.tileId === "string" ? { tileId: entry.tileId } : {}) }];
  });
}

function parseProfile(value: string): {
  name: string;
  email: string;
  notes: string;
  subscribed: boolean;
} {
  const match = /^Name: ([^\n]*)\nEmail: ([^\n]*)\nSubscribed: (true|false)\nNotes: ([\s\S]*)$/u.exec(value);
  if (!match) throw new Error("Backend returned an invalid profile");
  return {
    name: match[1] ?? "",
    email: match[2] ?? "",
    subscribed: match[3] === "true",
    notes: match[4] ?? "",
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function schemaKind(schema: MethodSchemaJson | undefined): string {
  return typeof schema?.type === "string" ? schema.type : "unknown";
}
