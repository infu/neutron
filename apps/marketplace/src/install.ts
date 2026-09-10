import type { JsonObject, MsgBusToolContext } from "neutron-tools/app";
import { protocolClient, randomId, cycleView } from "./client.ts";
import { authorize, scope, assertScope, type Scope } from "./actions.ts";
import { listIntents, loadIntent, saveIntent, reviseIntent } from "./store.ts";
import type { Fee } from "./protocol.ts";
import type { InstallationQuote, OperationResult } from "./view-types.ts";

// Optional fields extend an existing JSON draft; the managed-memory root stays
// at schema 1. Old drafts without an offered marker remain recoverable.
type SavedInstall = { version: 1; scope: Scope; quote: InstallationQuote; setupUrl: string | null; offered?: boolean; createdAt?: number };
const active = new Set<string>();
const feeKeys = ["feeVersion", "processingCycles", "storageCycles", "totalCycles", "processingBytes", "newStorageBytes"] as const;
function quoteId(id: string): string { if (!/^[0-9a-f]{32}$/.test(id)) throw new Error("Keep the installation's original 32-character request ID."); return id; }
function selection(appIds: string[]): string[] {
  if (!Array.isArray(appIds) || !appIds.length || appIds.some(id => typeof id !== "string" || !id)) throw new Error("Select the apps to install.");
  return [...appIds];
}
function feeView(fee: Fee): InstallationQuote["fee"] { return Object.fromEntries(feeKeys.map(key => [key, String(fee[key])])) as InstallationQuote["fee"]; }
function ownTile(context: MsgBusToolContext): boolean { return context.caller?.appId === "marketplace" && context.caller.role === "tile" && !context.agentMode; }
function sameScope(saved: Scope, current: Scope): boolean { return JSON.stringify(saved) === JSON.stringify(current); }
function readyQuote(saved: SavedInstall): InstallationQuote {
  if (!saved.setupUrl) return saved.quote;
  return {
    ...saved.quote, setupUrl: saved.setupUrl,
    cycles: { ...saved.quote.cycles, total: "0", processing: "0", storage: "0" },
    fee: { ...saved.quote.fee, processingCycles: "0", storageCycles: "0", totalCycles: "0", processingBytes: "0", newStorageBytes: "0" },
  };
}
function view(saved: SavedInstall, current: Scope): OperationResult {
  const permitted = sameScope(saved.scope, current), ready = !!saved.setupUrl;
  return {
    operationId: saved.quote.operationId, appIds: saved.quote.appIds,
    state: saved.offered ? "complete" : ready ? "pending" : "review_required",
    nextAction: saved.offered || !permitted ? "none" : ready ? "resume" : "review",
    ...(permitted ? { installation: readyQuote(saved) } : {}),
    message: saved.offered
      ? "The saved selection was handed to the Neutron installer. Check My Apps or the installer for its installation outcome."
      : !permitted
        ? `This saved installation belongs to the original ${saved.scope.callerApp} ${saved.scope.root ? "agent invocation" : "application"}. Resume it there to preserve the reviewed request.`
        : ready
          ? "Your selection is prepared. Open the Neutron installer; preparation will not be charged again. Any repository grant and installation costs are reviewed there separately."
          : "The original installation request is saved. Refresh and review its preparation cost before continuing with the same request ID.",
  };
}
export async function quoteInstallation(context: MsgBusToolContext, appIds: string[], operationId?: string): Promise<InstallationQuote> {
  const client = await protocolClient(context), appSelection = selection(appIds);
  const current = scope(context, client.state.canisterId!, client.state.owner);
  let saved: SavedInstall | null = null;
  if (operationId) {
    saved = await loadIntent<SavedInstall>(context.kernel, `installation:${quoteId(operationId)}`);
    if (saved) {
      assertScope(saved.scope, current);
      assertIdentity(saved.quote, { ...saved.quote, appIds: appSelection, owner: current.owner, canisterId: current.canister });
    }
  } else {
    const rows = await listIntents<SavedInstall>(context.kernel);
    saved = rows.filter(row => row.id.startsWith("installation:") && !row.value.offered && sameScope(row.value.scope, current) && JSON.stringify(row.value.quote.appIds) === JSON.stringify(appSelection))
      .map(row => row.value).sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))[0] ?? null;
  }
  if (saved?.setupUrl) return readyQuote(saved);
  const request = { requestId: quoteId(saved?.quote.operationId ?? operationId ?? randomId()), appIds: appSelection };
  const fee = await client.estimateUpdate("install_prepare", request);
  return { operationId: request.requestId, appIds: request.appIds, canisterId: current.canister, owner: current.owner, cycles: cycleView(fee), fee: feeView(fee) };
}
function assertIdentity(proposed: InstallationQuote, exact: InstallationQuote) {
  if (!proposed || proposed.operationId !== exact.operationId || proposed.owner !== exact.owner || proposed.canisterId !== exact.canisterId || JSON.stringify(proposed.appIds) !== JSON.stringify(exact.appIds)) throw new Error("The selected apps or marketplace changed. Review the installation preparation cost again.");
}
function assertQuote(proposed: InstallationQuote, exact: InstallationQuote) {
  assertIdentity(proposed, exact);
  if (proposed.setupUrl !== exact.setupUrl || !proposed.fee || feeKeys.some(key => proposed.fee[key] !== exact.fee[key]) || proposed.cycles.total !== exact.cycles.total || proposed.cycles.processing !== exact.cycles.processing || proposed.cycles.storage !== exact.cycles.storage || proposed.cycles.schedule !== exact.cycles.schedule) throw new Error("The installation preparation fee or saved offer changed. Refresh its displayed cost before installing; nothing was charged.");
}
export async function installationStatus(context: MsgBusToolContext, operationId: string): Promise<OperationResult | null> {
  const saved = await loadIntent<SavedInstall>(context.kernel, `installation:${quoteId(operationId)}`);
  if (!saved) return null;
  const client = await protocolClient(context);
  if (saved.scope.canister !== client.state.canisterId || saved.scope.owner !== client.state.owner) return null;
  return view(saved, scope(context, client.state.canisterId!, client.state.owner));
}
export async function recentInstallations(context: MsgBusToolContext): Promise<OperationResult[]> {
  const client = await protocolClient(context), current = scope(context, client.state.canisterId!, client.state.owner);
  return (await listIntents<SavedInstall>(context.kernel))
    .filter(row => row.id.startsWith("installation:") && row.value.scope.canister === current.canister && row.value.scope.owner === current.owner)
    .map(row => view(row.value, current));
}
export async function markInstallationOpened(context: MsgBusToolContext, supplied: InstallationQuote): Promise<OperationResult> {
  const client = await protocolClient(context), current = scope(context, client.state.canisterId!, client.state.owner);
  const key = `installation:${quoteId(supplied.operationId)}`, saved = await loadIntent<SavedInstall>(context.kernel, key);
  if (!saved?.setupUrl) throw new Error("The saved installer offer is unavailable. Keep the original installation request.");
  assertScope(saved.scope, current); assertQuote(supplied, readyQuote(saved));
  if (saved.offered) return view(saved, current);
  const next = { ...saved, offered: true };
  await reviseIntent(context.kernel, key, saved, next);
  return view(next, current);
}
export async function resumeInstallation(context: MsgBusToolContext, operationId: string): Promise<OperationResult | null> {
  const result = await installationStatus(context, operationId);
  if (!result || result.state === "complete" || result.nextAction === "none") return result;
  // Owner continuation must show the latest quote before any charged retry;
  // a ready offer must be opened by the physical tile on a fresh click.
  if (!context.agentMode) return result;
  return installApplications(context, result.installation!.appIds, undefined, operationId);
}
export async function installApplications(context: MsgBusToolContext, appIds: string[], supplied?: InstallationQuote, operationId?: string): Promise<OperationResult> {
  if (ownTile(context) && !supplied) throw new Error("Review the displayed installation preparation cost before installing.");
  const exact = await quoteInstallation(context, appIds, supplied?.operationId ?? operationId), client = await protocolClient(context);
  if (supplied) assertQuote(supplied, exact);
  if (client.state.canisterId !== exact.canisterId || client.state.owner !== exact.owner) throw new Error("The marketplace changed while preparing the installation quote. Review it again.");
  const currentScope = scope(context, exact.canisterId, exact.owner), storageKey = `installation:${exact.operationId}`;
  let saved = await loadIntent<SavedInstall>(context.kernel, storageKey);
  if (saved) { assertScope(saved.scope, currentScope); assertIdentity(saved.quote, exact); }
  const actionKey = `${exact.canisterId}:${exact.owner}:${exact.operationId}`;
  if (active.has(actionKey)) throw new Error(`Installation ${exact.operationId} is already being prepared. Wait for its original request.`);
  active.add(actionKey);
  try {
    await authorize(context, { kind: "installation", quote: exact as unknown as JsonObject });
    if (!saved) {
      saved = { version: 1, scope: currentScope, quote: exact, setupUrl: null, createdAt: Date.now() };
      await saveIntent(context.kernel, storageKey, saved);
    } else if (!saved.setupUrl && JSON.stringify(saved.quote) !== JSON.stringify(exact)) {
      const next = { ...saved, quote: exact };
      await reviseIntent(context.kernel, storageKey, saved, next); saved = next;
    }
    if (!saved.setupUrl) {
      const refreshed = await quoteInstallation(context, exact.appIds, exact.operationId);
      assertQuote(exact, refreshed);
      const fees = Object.fromEntries(feeKeys.map(key => [key, BigInt(exact.fee[key])])) as Fee;
      const prepared = await client.update<{ setupUrl: string }>("install_prepare", { requestId: exact.operationId, appIds: exact.appIds }, fees);
      if (typeof prepared.setupUrl !== "string" || !prepared.setupUrl) throw new Error("The marketplace did not return an installation offer.");
      const next = { ...saved, setupUrl: prepared.setupUrl };
      await reviseIntent(context.kernel, storageKey, saved, next); saved = next;
    }
    if (!context.agentMode) return view(saved, currentScope);
    // Only an agent carries invocation authority through the background route.
    // Ordinary owner handoff is performed directly by the tile client instead.
    await context.kernel.callTool({ target: "kernel", name: "apps.install_offer", arguments: { kind: "repository_setup_url", url: saved.setupUrl } }, 0);
    return markInstallationOpened(context, readyQuote(saved));
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)} Retain installation request ${exact.operationId} when continuing.`);
  } finally { active.delete(actionKey); }
}
