import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IconType } from "react-icons";
import {
  IoAppsOutline,
  IoBrowsersOutline,
  IoCloudOutline,
  IoCodeSlashOutline,
  IoColorPaletteOutline,
  IoCubeOutline,
  IoDiceOutline,
  IoEarthOutline,
  IoFingerPrintOutline,
  IoFlashOutline,
  IoGlobeOutline,
  IoGridOutline,
  IoHardwareChipOutline,
  IoHomeOutline,
  IoKeyOutline,
  IoLinkOutline,
  IoLockClosedOutline,
  IoNotificationsOutline,
  IoPulseOutline,
  IoRefreshOutline,
  IoServerOutline,
  IoStopwatchOutline,
  IoSwapHorizontalOutline,
} from "react-icons/io5";
import {
  createCanisterClient,
  exposeTool,
  loadNeutronCanisterId,
  loadTileContext,
  onAppStateChange,
  publishAppStateChange,
  querySelf,
  removeExposedTool,
  updateSelf,
  type JsonObject,
  type JsonValue,
  type MethodSchemaJson,
  type MsgBusToolContext,
  type NeutronCanisterClient,
  type TileContext,
} from "neutron-tools/app";
import {
  CAPABILITY_IDS,
  CapabilityPage,
  type CapabilityId,
} from "./capability_lab.tsx";
import {
  DERIVED_CAPABILITY_IDS,
  DerivedCapabilityPage,
  type DerivedCapabilityId,
} from "./derived_capabilities.tsx";
import { formatError } from "./lab_ui.tsx";
import { PageGuide } from "./page_guides.tsx";
import {
  PLATFORM_IDS,
  PlatformPage,
  type PlatformId,
  type PlatformRuntime,
} from "./platform_pages.tsx";
import { counterIncrementInputSchema } from "./tile_tools.ts";
import "./style.scss";

const METHODS = [
  "public_status",
  "read_profile",
  "save_profile",
  "echo",
  "add",
  "bump_counter",
  "read_counter",
  "random_bytes",
  "chain_key_public_key",
  "chain_key_sign_receipt",
  "https_example",
  "backend_probe",
  "scheduled_status",
  "dependency_status",
  "function_resource_snapshot",
  "stable_notes_create",
  "stable_notes_load",
  "stable_notes_update",
  "stable_notes_list",
  "stable_notes_usage",
  "stable_notes_delete",
  "stable_notes_clear_page",
  "publish_publication",
  "delete_publication",
  "publish_immutable_blob",
  "put_mutable_blob",
  "asset_status",
  "certified_assets_usage",
] as const;

const TILE_IDS = ["main", "companion"] as const;
const COUNTER_TOPIC = "counter";

type TileId = (typeof TILE_IDS)[number];
type DemoId = CapabilityId | DerivedCapabilityId | PlatformId;
type DemoGroup = "Start" | "Backend" | "Identity" | "Runtime" | "Public web" | "Platform";

type DemoDefinition = {
  id: DemoId;
  group: DemoGroup;
  label: string;
  summary: string;
  icon: IconType;
};

const DEMOS: readonly DemoDefinition[] = [
  { id: "overview", group: "Start", label: "Overview", summary: "All implemented app-facing capability surfaces.", icon: IoHomeOutline },
  { id: "public_ingress", group: "Backend", label: "Public ingress", summary: "Public Candid endpoints with explicit caller policies.", icon: IoGlobeOutline },
  { id: "backend_calls", group: "Backend", label: "Backend calls", summary: "Exact owner-reserved inter-canister methods.", icon: IoServerOutline },
  { id: "https_outcalls", group: "Backend", label: "HTTPS outcalls", summary: "Metered requests to exact public HTTPS prefixes.", icon: IoCloudOutline },
  { id: "randomness", group: "Backend", label: "Randomness", summary: "Metered consensus entropy.", icon: IoDiceOutline },
  { id: "scheduled_tasks", group: "Backend", label: "Scheduled tasks", summary: "Leased, non-overlapping callbacks.", icon: IoStopwatchOutline },
  { id: "stable_store", group: "Backend", label: "Stable Store", summary: "Bounded revisioned app records.", icon: IoCubeOutline },
  { id: "self_calls", group: "Backend", label: "Preapproved calls", summary: "Exact same-app query and update paths.", icon: IoFlashOutline },
  { id: "chain_key_signing", group: "Identity", label: "Chain-key assertions", summary: "Domain-separated threshold signatures.", icon: IoFingerPrintOutline },
  { id: "vetkeys", group: "Identity", label: "Private key slots", summary: "Installation-isolated vetKey namespaces.", icon: IoKeyOutline },
  { id: "ethereum", group: "Identity", label: "Ethereum", summary: "Declared EIP-1193 provider subset.", icon: IoEarthOutline },
  { id: "connections", group: "Identity", label: "Connections", summary: "Kernel-owned provider credentials.", icon: IoLinkOutline },
  { id: "agent_entrypoints", group: "Runtime", label: "Agent entrypoint", summary: "Temporary delegated invocation context.", icon: IoHardwareChipOutline },
  { id: "background_requests", group: "Runtime", label: "Background prompts", summary: "Residents may ask; kernel still approves.", icon: IoNotificationsOutline },
  { id: "storage", group: "Runtime", label: "Browser storage", summary: "Stable installation-specific resident origin.", icon: IoLockClosedOutline },
  { id: "certified_reads", group: "Public web", label: "Certified reads", summary: "Read routes synthesized from closed collection kinds.", icon: IoGlobeOutline },
  { id: "certified_assets", group: "Public web", label: "Certified assets", summary: "Bounded app-scoped certified content.", icon: IoCloudOutline },
  { id: "composition", group: "Platform", label: "Composition", summary: "Typed app calls and ordered function resources.", icon: IoLinkOutline },
  { id: "memory", group: "Platform", label: "Memory", summary: "Managed stable memory and reviewed writes.", icon: IoAppsOutline },
  { id: "bus", group: "Platform", label: "Message bus", summary: "Live endpoint discovery and app tools.", icon: IoSwapHorizontalOutline },
  { id: "tray", group: "Platform", label: "Tray", summary: "Resident popout with optional live badge state.", icon: IoBrowsersOutline },
  { id: "schemas", group: "Platform", label: "Schemas", summary: "Installed Candid-derived method metadata.", icon: IoCodeSlashOutline },
  { id: "data", group: "Platform", label: "Dense data", summary: "Copy, wrapping, and JSON containment.", icon: IoGridOutline },
  { id: "design", group: "Platform", label: "Design system", summary: "Accessible controls, states, and settings.", icon: IoColorPaletteOutline },
] as const;

const GROUPS: readonly DemoGroup[] = ["Start", "Backend", "Identity", "Runtime", "Public web", "Platform"];
const DEMO_IDS = new Set<string>(DEMOS.map((demo) => demo.id));

type KitchenRuntime = PlatformRuntime;

function normalizeTile(value: string | null): TileId {
  return TILE_IDS.includes(value as TileId) ? value as TileId : "main";
}

function initialDemo(): DemoId {
  const candidate = window.location.hash.replace(/^#\/?/u, "");
  return DEMO_IDS.has(candidate) ? candidate as DemoId : "overview";
}

function useKitchenRuntime(): KitchenRuntime {
  const [runtime, setRuntime] = useState<KitchenRuntime>({
    client: null,
    canisterId: null,
    schemas: {},
    schemaErrors: {},
    loading: true,
    error: null,
    schemasRequested: false,
    loadSchemas: () => undefined,
  });
  const schemaLoadStarted = useRef(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const canisterId = await loadNeutronCanisterId();
        const client = createCanisterClient(canisterId);
        if (active) {
          setRuntime((current) => ({
            ...current,
            client,
            canisterId,
            loading: false,
            error: null,
          }));
        }
      } catch (reason) {
        if (!active) return;
        setRuntime((current) => ({ ...current, loading: false, error: formatError(reason) }));
      }
    })();
    return () => { active = false; };
  }, []);

  const loadSchemas = useCallback(() => {
    if (!runtime.client || schemaLoadStarted.current) return;
    schemaLoadStarted.current = true;
    const client = runtime.client;
    setRuntime((current) => ({
      ...current,
      loading: true,
      schemasRequested: true,
    }));
    void Promise.allSettled(
      METHODS.map((method) => client.methodSchema(method, 6)),
    ).then((results) => {
      const schemas: Record<string, MethodSchemaJson> = {};
      const schemaErrors: Record<string, string> = {};
      results.forEach((result, index) => {
        const method = METHODS[index];
        if (!method) return;
        if (result.status === "fulfilled") schemas[method] = result.value;
        else schemaErrors[method] = formatError(result.reason);
      });
      setRuntime((current) => ({
        ...current,
        schemas,
        schemaErrors,
        loading: false,
      }));
    });
  }, [runtime.client]);

  return { ...runtime, loadSchemas };
}

export function App() {
  const context = useMemo(() => loadTileContext(), []);
  const runtime = useKitchenRuntime();
  const tile = normalizeTile(context.tile);
  useKitchenTools(context, tile);
  return tile === "companion"
    ? <CompanionTile context={context} runtime={runtime} />
    : <KitchenWorkbench context={context} runtime={runtime} />;
}

function useKitchenTools(context: TileContext, tile: TileId): void {
  useEffect(() => {
    const outputSchema: JsonObject = {
      type: "object",
      required: ["appId", "tileId", "instanceId", "workspace", "counter"],
      properties: {
        appId: { type: "string" },
        tileId: { type: "string" },
        instanceId: { type: "string" },
        workspace: { type: "string" },
        counter: { type: "string", pattern: "^[0-9]+$" },
      },
      additionalProperties: false,
    };

    const tileIdentity = (counter: string): JsonValue => ({
      appId: context.app ?? "kitchensink",
      tileId: tile,
      instanceId: context.instance ?? "unknown",
      workspace: String(context.workspace ?? "unknown"),
      counter,
    });

    const snapshot = async (
      _args: JsonObject,
      toolContext: MsgBusToolContext,
    ): Promise<JsonValue> => tileIdentity(
      await toolContext.kernel.querySelf<string>(
        "read_counter",
        [null],
        20,
      ),
    );

    exposeTool("tile_snapshot", {
      title: "Inspect Kitchen Sink Tile",
      description: "Return this live tile's source-bound identity and shared counter.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema,
      annotations: { "neutron:effects": ["read", "network"] },
    }, snapshot);

    exposeTool("counter_increment", {
      title: "Increment Shared Counter",
      description: "Increment Kitchen Sink's managed counter from this exact tile.",
      inputSchema: counterIncrementInputSchema,
      outputSchema,
      annotations: { "neutron:effects": ["write", "network"] },
    }, async (args, toolContext) => {
      const step = typeof args.step === "string" ? args.step : "1";
      const counter = await toolContext.kernel.updateSelf<string>(
        "bump_counter",
        [step],
        20,
      );
      try {
        await publishAppStateChange(COUNTER_TOPIC, Number(counter));
      } catch {
        // The counter commit succeeded; focus refresh is the fallback invalidation.
      }
      return tileIdentity(counter);
    });

    return () => {
      removeExposedTool("tile_snapshot");
      removeExposedTool("counter_increment");
    };
  }, [context.app, context.instance, context.workspace, tile]);
}

function KitchenWorkbench({ context, runtime }: { context: TileContext; runtime: KitchenRuntime }) {
  const [active, setActive] = useState<DemoId>(initialDemo);
  const stageBodyRef = useRef<HTMLElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const focusOnNavigation = useRef(false);
  const selected = DEMOS.find((demo) => demo.id === active) ?? DEMOS[0]!;

  useEffect(() => {
    const onHashChange = () => {
      focusOnNavigation.current = true;
      setActive(initialDemo());
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    stageBodyRef.current?.scrollTo({ top: 0 });
    document
      .querySelector<HTMLElement>(`[data-tid="kitchen-nav-${active}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (focusOnNavigation.current) {
      titleRef.current?.focus({ preventScroll: true });
      focusOnNavigation.current = false;
    }
  }, [active]);

  const navigate = (id: string) => {
    if (!DEMO_IDS.has(id)) return;
    const next = id as DemoId;
    focusOnNavigation.current = true;
    if (window.location.hash !== `#${next}`) {
      window.location.hash = next;
    } else {
      setActive(next);
    }
  };

  const schemaFailureCount = Object.keys(runtime.schemaErrors).length;
  const runtimeLabel = runtime.error
    ? "Runtime unavailable"
    : runtime.loading
      ? "Loading schemas"
      : schemaFailureCount
        ? `${schemaFailureCount} schema${schemaFailureCount === 1 ? "" : "s"} unavailable`
        : "Runtime ready";

  return (
    <main className="nt-app nt-app--fill ks-app">
      <div className="ks-workbench" data-tid="kitchen-tile-main">
        <aside className="ks-sidebar">
          <div className="ks-brand"><span aria-hidden="true"><IoCubeOutline /></span><div><strong>Kitchen Sink</strong><small>Capability lab</small></div></div>
          <nav className="ks-nav" aria-label="Kitchen Sink pages">
            {GROUPS.map((group) => (
              <section className="ks-nav-group" key={group} aria-labelledby={`nav-group-${group.replaceAll(" ", "-").toLowerCase()}`}>
                <h2 id={`nav-group-${group.replaceAll(" ", "-").toLowerCase()}`}>{group}</h2>
                {DEMOS.filter((demo) => demo.group === group).map((demo) => {
                  const Icon = demo.icon;
                  return <button aria-current={active === demo.id ? "page" : undefined} className="ks-nav-item" data-tid={`kitchen-nav-${demo.id}`} key={demo.id} onClick={() => navigate(demo.id)} title={`${demo.label}: ${demo.summary}`} type="button"><Icon aria-hidden="true" /><span>{demo.label}</span></button>;
                })}
              </section>
            ))}
          </nav>
          <div className="ks-sidebar-footer"><span className={`nt-status-dot ${runtime.error ? "nt-status-dot--danger" : runtime.loading || schemaFailureCount ? "nt-status-dot--warning" : "nt-status-dot--success"}`} /><span>{context.workspace ?? "workspace"}</span></div>
        </aside>
        <section className="ks-stage" aria-labelledby="kitchen-title">
          <header className="ks-stage-header">
            <div><p className="nt-eyebrow">{selected.group}</p><h1 className="nt-title" data-tid="kitchen-title" id="kitchen-title" ref={titleRef} tabIndex={-1}>{selected.label}</h1><p>{selected.summary}</p></div>
            <div className="ks-stage-meta" title={runtime.canisterId ?? undefined}><IoPulseOutline aria-hidden="true" /><span>{runtimeLabel}</span></div>
          </header>
          <section className="ks-stage-body" data-tid={`kitchen-demo-${active}`} ref={stageBodyRef}>
            {runtime.error ? <div className="nt-alert nt-alert--danger" role="alert"><strong>Runtime error</strong><span>{runtime.error}</span></div> : null}
            <div className="ks-page-shell">
              <PageGuide id={active} />
              {isCapabilityId(active)
                ? <CapabilityPage id={active} runtime={runtime} />
                : isDerivedCapabilityId(active)
                  ? <DerivedCapabilityPage id={active} />
                  : <PlatformPage id={active} runtime={runtime} context={context} navigate={navigate} methods={METHODS} />}
            </div>
          </section>
        </section>
      </div>
    </main>
  );
}

function CompanionTile({ context, runtime }: { context: TileContext; runtime: KitchenRuntime }) {
  const [counter, setCounter] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const mutationInFlight = useRef(false);

  const refresh = async () => {
    const sequence = ++requestSequence.current;
    try {
      const next = await querySelf<string>("read_counter", [null], 20);
      if (sequence === requestSequence.current) { setCounter(next); setError(null); }
    } catch (reason) {
      if (sequence === requestSequence.current) setError(formatError(reason));
    }
  };

  useEffect(() => {
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    const removeStateListener = onAppStateChange(COUNTER_TOPIC, () => { void refresh(); });
    return () => { window.removeEventListener("focus", onFocus); removeStateListener(); };
  }, []);

  const increment = async (step: string) => {
    if (mutationInFlight.current) return;
    mutationInFlight.current = true;
    const sequence = ++requestSequence.current;
    setBusy(true);
    try {
      const next = await updateSelf<string>("bump_counter", [step], 20);
      if (sequence === requestSequence.current) {
        setCounter(next);
        setError(null);
      }
      try {
        await publishAppStateChange(COUNTER_TOPIC, Number(next));
      } catch {
        // The update already committed; focus refresh remains available.
      }
    } catch (reason) {
      if (sequence === requestSequence.current) setError(formatError(reason));
    } finally {
      mutationInFlight.current = false;
      setBusy(false);
    }
  };

  const health = runtime.error || error
    ? { label: "Unavailable", className: "nt-status-dot--danger" }
    : counter === null
      ? { label: "Loading", className: "nt-status-dot--warning" }
      : { label: "Ready", className: "nt-status-dot--success" };

  return (
    <main className="nt-app nt-app--fill ks-app ks-companion-app">
      <section className="ks-companion" data-tid="kitchen-tile-companion" aria-labelledby="companion-title">
        <header><span aria-hidden="true"><IoLinkOutline /></span><div><h1 id="companion-title">Shared counter</h1><p>Event-driven Kitchen Sink companion</p></div><span className="ks-companion-health"><span aria-hidden="true" className={`nt-status-dot ${health.className}`} /><span>{health.label}</span></span></header>
        <div className="ks-counter-display" aria-live="polite"><span>Canister value</span><strong data-tid="kitchen-companion-counter">{counter ?? "—"}</strong><small>{counter === null && !error ? "Loading current value…" : "No polling · refreshes on app state and focus"}</small></div>
        <div className="nt-command-bar ks-counter-actions"><button aria-label="Increment counter by one" className="nt-icon-button" disabled={busy} onClick={() => void increment("1")} type="button">+</button><button className="nt-button nt-button--secondary" disabled={busy} onClick={() => void increment("5")} type="button">+5</button><button aria-label="Refresh shared counter" className="nt-icon-button" disabled={busy} onClick={() => void refresh()} type="button"><IoRefreshOutline /></button></div>
        <dl className="ks-evidence-list"><div><dt>Tile</dt><dd>companion</dd></div><div><dt>Workspace</dt><dd>{context.workspace ?? "unknown"}</dd></div><div><dt>Schemas</dt><dd>{runtime.schemasRequested ? `${Object.keys(runtime.schemas).length} ready` : "load on demand"}</dd></div></dl>
        {runtime.error || error ? <div className="nt-alert nt-alert--danger" role="alert">{runtime.error ?? error}</div> : null}
      </section>
    </main>
  );
}

function isCapabilityId(value: DemoId): value is CapabilityId {
  return (CAPABILITY_IDS as readonly string[]).includes(value);
}

function isDerivedCapabilityId(value: DemoId): value is DerivedCapabilityId {
  return (DERIVED_CAPABILITY_IDS as readonly string[]).includes(value);
}

if (!(PLATFORM_IDS as readonly string[]).includes("overview")) {
  throw new Error("Kitchen Sink platform registry is invalid");
}

const container = document.getElementById("root");
if (!container) throw new Error("Root element not found");
createRoot(container).render(<App />);
