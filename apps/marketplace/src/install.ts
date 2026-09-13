import type { JsonObject, MsgBusToolContext } from "neutron-tools/app";
import { protocolClient, randomId, cycleView, ProtocolError } from "./client.ts";
import { authorize, scope, assertScope, type Scope } from "./actions.ts";
import { listIntents, loadIntent, saveIntent, reviseIntent } from "./store.ts";
import type { Fee, WireReleaseSelection } from "./protocol.ts";
import type { InstallationQuote, OperationResult } from "./view-types.ts";
import { readInstallAccessDescriptor, readInstallAccessSelection } from "./install_access.ts";
import { readReleasePreferences, releasePreferencesEqual, assertReleasePreferencesUnchanged, type ReleasePreferences } from "./release_preferences.ts";

// Optional fields extend an existing JSON draft; the managed-memory root stays
// at state v2. Drafts predating channel or dispatch markers still restore.
type SavedAccess = { requestId: string; token: string; paths: string[]; feeVersion: string; cycles: string; ready: boolean; submitted?: boolean };
type SavedInstall = { version: 1; scope: Scope; quote: InstallationQuote; setupUrl: string | null; offered?: boolean; createdAt?: number; unavailableReason?: string; prepareSubmitted?: boolean; access?: SavedAccess };
export type InstallationHandoff = { url: string; appIds: string[]; releasePreferences?: ReleasePreferences; access: { source: string; token: string; paths: string[] } };
export type PrivateInstallResult = { result: OperationResult; handoff?: InstallationHandoff };
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
function pendingFinancial(saved: SavedInstall): boolean {
  // A legacy draft was saved immediately before dispatch. An absent marker on
  // that draft cannot prove the source never accepted the original request.
  return !saved.unavailableReason && (!saved.setupUrl && saved.prepareSubmitted !== false || !!saved.access && !saved.access.ready && saved.access.submitted !== false);
}
function preferenceQuote(quote: InstallationQuote, current: ReleasePreferences, saved?: SavedInstall | null): InstallationQuote {
  const { preferenceChanged: _, reconciliationRequired: __, ...retained } = quote;
  return { ...retained, ...(quote.releasePreferences && !releasePreferencesEqual(quote.releasePreferences, current)
    ? { preferenceChanged: true, ...(saved && pendingFinancial(saved) ? { reconciliationRequired: true } : {}) } : {}) };
}
function releaseMode(value: Record<string, null>): "stable" | "beta" {
  const keys = Object.keys(value);
  if (keys.length !== 1 || (keys[0] !== "stable" && keys[0] !== "beta")) throw new Error("The marketplace returned an invalid release channel.");
  return keys[0];
}
function digestHex(value: Uint8Array): string {
  if (value.length !== 32) throw new Error("The marketplace returned an invalid release digest.");
  return [...value].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function wireSelection(quote: InstallationQuote): WireReleaseSelection[] {
  return quote.selection!.packages.map(pkg => ({ appId: pkg.appId, candidateId: BigInt(pkg.candidateId), version: BigInt(pkg.version),
    digest: Uint8Array.from(pkg.digest.match(/../g)!.map(byte => parseInt(byte, 16))),
    sourceDigest: pkg.sourceDigest ? [Uint8Array.from(pkg.sourceDigest.match(/../g)!.map(byte => parseInt(byte, 16)))] : [],
    channel: pkg.channel === "beta" ? { beta: null } : { stable: null }, revision: BigInt(pkg.revision) }));
}
function prepareRequest(quote: InstallationQuote) {
  const request = { requestId: quote.operationId, appIds: quote.appIds };
  return quote.selection ? { method: "install_prepare_v2", request: { request, mode: { [quote.selection.mode]: null }, selection: wireSelection(quote) } }
    : { method: "install_prepare", request };
}
async function assertAdmission(context: MsgBusToolContext, quote: InstallationQuote): Promise<void> {
  if (quote.releasePreferences) assertReleasePreferencesUnchanged(quote.releasePreferences, await readReleasePreferences(context));
}
function withAccess(quote: InstallationQuote, sourceAccess: NonNullable<InstallationQuote["sourceAccess"]>): InstallationQuote {
  return { ...quote, sourceAccess, cycles: {
    ...quote.cycles,
    total: String(BigInt(quote.fee.totalCycles) + BigInt(sourceAccess.cycles)),
    processing: String(BigInt(quote.fee.processingCycles) + BigInt(sourceAccess.cycles)),
  } };
}
function readyQuote(saved: SavedInstall): InstallationQuote {
  let quote = { ...saved.quote, ...(saved.unavailableReason ? { unavailableReason: saved.unavailableReason } : {}) };
  if (saved.setupUrl) quote = {
    ...quote, setupUrl: saved.setupUrl,
    cycles: { ...quote.cycles, total: "0", processing: "0", storage: "0" },
    fee: { ...quote.fee, processingCycles: "0", storageCycles: "0", totalCycles: "0", processingBytes: "0", newStorageBytes: "0" },
  };
  const access = saved.access
    ? { source: saved.scope.canister, feeVersion: saved.access.feeVersion, cycles: saved.access.ready ? "0" : saved.access.cycles }
    : quote.sourceAccess;
  return access ? withAccess(quote, access) : quote;
}
function handoff(saved: SavedInstall): InstallationHandoff {
  if (!saved.setupUrl || !saved.access?.ready) throw new Error("The saved download access is not ready. Continue this original installation.");
  return { url: saved.setupUrl, appIds: saved.quote.appIds, ...(saved.quote.releasePreferences ? { releasePreferences: saved.quote.releasePreferences } : {}), access: { source: saved.scope.canister, token: saved.access.token, paths: saved.access.paths } };
}
async function requirePreparedInstaller(context: MsgBusToolContext): Promise<void> {
  context.signal?.throwIfAborted();
  const tools = await context.kernel.listTools("kernel");
  if (!tools.some(tool => tool.name === "apps.install_prepared")) throw new Error("Update Neutron before installing these apps.");
}

function view(saved: SavedInstall, current: Scope, preferences?: ReleasePreferences): OperationResult {
  const permitted = sameScope(saved.scope, current), ready = !!saved.setupUrl;
  const legacyComplete = !!saved.offered && !saved.access;
  const quote = preferences ? preferenceQuote(readyQuote(saved), preferences, saved) : readyQuote(saved);
  return {
    operationId: saved.quote.operationId, appIds: saved.quote.appIds,
    state: legacyComplete ? "complete" : saved.unavailableReason ? "failed" : quote.preferenceChanged && !quote.reconciliationRequired ? "review_required" : ready ? "pending" : "review_required",
    nextAction: legacyComplete || !permitted ? "none" : quote.preferenceChanged && !quote.reconciliationRequired ? "review" : ready ? "resume" : "review",
    ...(permitted ? { installation: quote } : {}),
    message: quote.preferenceChanged && permitted
      ? quote.reconciliationRequired
        ? "Beta updates changed. Continue the original request to confirm its submitted charge; then prepare a new selection using the current setting."
        : "Beta updates changed. The original financial request is retained. Prepare a new selection using the current setting before opening installation."
      : saved.offered
      ? "The package review was opened. This is not an installation receipt. Reopen this saved selection if the review was closed; its prepared download access is retained."
      : !permitted
        ? `This saved installation belongs to the original ${saved.scope.callerApp} ${saved.scope.root ? "agent invocation" : "application"}. Resume it there to preserve the reviewed request.`
        : saved.unavailableReason
          ? `${saved.unavailableReason} Prepare the latest selection to review a new installation request. This does not purchase the apps again.`
          : ready
            ? "Your selection is saved. Continue this installation to open Neutron’s package review using its retained download access."
            : "The original installation request is saved. Refresh and review its preparation cost before continuing with the same request ID.",
  };
}
export async function quoteInstallation(context: MsgBusToolContext, appIds: string[], operationId?: string): Promise<InstallationQuote> {
  const [client, preferences] = await Promise.all([protocolClient(context), readReleasePreferences(context)]), appSelection = selection(appIds);
  const current = scope(context, client.state.canisterId!, client.state.owner);
  let currentSelection: InstallationQuote["selection"];
  async function resolveSelection(): Promise<NonNullable<InstallationQuote["selection"]>> {
    if (currentSelection) return currentSelection;
    const mode = preferences.betaEnabled ? "beta" : "stable";
    const resolved = await client.query<{ appIds: string[]; mode: Record<string, null>; selection: WireReleaseSelection[] }>("install_selection_v2", [{ appIds: appSelection, mode: { [mode]: null } }]);
    if (new Set(resolved.appIds).size !== resolved.appIds.length || JSON.stringify([...resolved.appIds].sort()) !== JSON.stringify([...new Set(appSelection)].sort()) || releaseMode(resolved.mode) !== mode) throw new Error("The marketplace returned a different installation selection.");
    const packages = resolved.selection.map(pkg => ({ appId: pkg.appId, candidateId: String(pkg.candidateId), version: String(pkg.version), digest: digestHex(pkg.digest), sourceDigest: pkg.sourceDigest[0] ? digestHex(pkg.sourceDigest[0]) : null, channel: releaseMode(pkg.channel), revision: String(pkg.revision) })).sort((a, b) => a.appId < b.appId ? -1 : a.appId > b.appId ? 1 : 0);
    if (new Set(packages.map(pkg => pkg.appId)).size !== packages.length || appSelection.some(id => !packages.some(pkg => pkg.appId === id)) || mode === "stable" && packages.some(pkg => pkg.channel !== "stable")) throw new Error("The marketplace returned an inconsistent installation selection.");
    assertReleasePreferencesUnchanged(preferences, await readReleasePreferences(context));
    return currentSelection = { mode, packages };
  }
  let saved: SavedInstall | null = null;
  if (operationId) {
    saved = await loadIntent<SavedInstall>(context.kernel, `installation:${quoteId(operationId)}`);
    if (saved) {
      assertScope(saved.scope, current);
      assertIdentity(saved.quote, { ...saved.quote, appIds: appSelection, owner: current.owner, canisterId: current.canister });
    }
  } else {
    const [rows, selected] = await Promise.all([listIntents<SavedInstall>(context.kernel), resolveSelection()]);
    saved = rows.filter(row => row.id.startsWith("installation:") && (!row.value.offered || !!row.value.access) && sameScope(row.value.scope, current) && JSON.stringify(row.value.quote.appIds) === JSON.stringify(appSelection)
      && !!row.value.quote.releasePreferences && releasePreferencesEqual(row.value.quote.releasePreferences, preferences)
      && JSON.stringify(row.value.quote.selection) === JSON.stringify(selected))
      .map(row => row.value).sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))[0] ?? null;
  }
  if (saved?.unavailableReason || saved?.access) return preferenceQuote(readyQuote(saved), preferences, saved);
  const descriptor = await readInstallAccessDescriptor(current.canister, { host: client.state.host, ...(context.signal ? { signal: context.signal } : {}) });
  const sourceAccess = { source: current.canister, feeVersion: descriptor.fee_version, cycles: descriptor.cycles };
  if (saved?.setupUrl) return preferenceQuote(withAccess(readyQuote(saved), sourceAccess), preferences, saved);
  let exactSelection = saved?.quote.selection;
  if (!saved) exactSelection = await resolveSelection();
  const identity = { operationId: quoteId(saved?.quote.operationId ?? operationId ?? randomId()), appIds: appSelection, canisterId: current.canister, owner: current.owner,
    ...(exactSelection ? { selection: exactSelection, releasePreferences: saved?.quote.releasePreferences ?? preferences } : {}) };
  const request = prepareRequest(identity as InstallationQuote);
  const fee = await client.estimateUpdate(request.method, request.request);
  return preferenceQuote(withAccess({ ...identity, cycles: cycleView(fee), fee: feeView(fee) }, sourceAccess), preferences, saved);
}
function assertIdentity(proposed: InstallationQuote, exact: InstallationQuote) {
  if (!proposed || proposed.operationId !== exact.operationId || proposed.owner !== exact.owner || proposed.canisterId !== exact.canisterId || JSON.stringify(proposed.appIds) !== JSON.stringify(exact.appIds) || JSON.stringify(proposed.releasePreferences) !== JSON.stringify(exact.releasePreferences) || JSON.stringify(proposed.selection) !== JSON.stringify(exact.selection)) throw new Error("The selected apps, releases, Beta updates setting or marketplace changed. Review the installation preparation cost again.");
}
function assertQuote(proposed: InstallationQuote, exact: InstallationQuote) {
  assertIdentity(proposed, exact);
  if (proposed.preferenceChanged !== exact.preferenceChanged || proposed.reconciliationRequired !== exact.reconciliationRequired) throw new Error("Beta updates changed. Refresh the original request before continuing.");
  if (proposed.setupUrl !== exact.setupUrl || proposed.unavailableReason !== exact.unavailableReason || !proposed.fee || feeKeys.some(key => proposed.fee[key] !== exact.fee[key]) || proposed.cycles.total !== exact.cycles.total || proposed.cycles.processing !== exact.cycles.processing || proposed.cycles.storage !== exact.cycles.storage || proposed.cycles.schedule !== exact.cycles.schedule || JSON.stringify(proposed.sourceAccess) !== JSON.stringify(exact.sourceAccess)) throw new Error("The installation preparation fee or saved offer changed. Refresh its displayed cost before installing; nothing was charged.");
}
export async function installationStatus(context: MsgBusToolContext, operationId: string): Promise<OperationResult | null> {
  const saved = await loadIntent<SavedInstall>(context.kernel, `installation:${quoteId(operationId)}`);
  if (!saved) return null;
  const client = await protocolClient(context);
  if (saved.scope.canister !== client.state.canisterId || saved.scope.owner !== client.state.owner) return null;
  return view(saved, scope(context, client.state.canisterId!, client.state.owner), await readReleasePreferences(context));
}
export async function recentInstallations(context: MsgBusToolContext): Promise<OperationResult[]> {
  const client = await protocolClient(context), current = scope(context, client.state.canisterId!, client.state.owner);
  const preferences = await readReleasePreferences(context);
  return (await listIntents<SavedInstall>(context.kernel))
    .filter(row => row.id.startsWith("installation:") && row.value.scope.canister === current.canister && row.value.scope.owner === current.owner)
    .map(row => view(row.value, current, preferences));
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
  // Owner continuation displays the retained costs before a charged retry.
  // The tile privately hands prepared access to the generic installer.
  if (!context.agentMode) return result;
  return installApplications(context, result.installation!.appIds, undefined, operationId);
}
export async function installApplications(context: MsgBusToolContext, appIds: string[], supplied?: InstallationQuote, operationId?: string): Promise<OperationResult> {
  if (ownTile(context) && !supplied) throw new Error("Review the displayed installation cost before installing.");
  await requirePreparedInstaller(context);
  const exact = await quoteInstallation(context, appIds, supplied?.operationId ?? operationId), client = await protocolClient(context);
  if (supplied) assertQuote(supplied, exact);
  if (exact.unavailableReason) throw new Error(`${exact.unavailableReason} Prepare the latest selection using a new installation request; retain ${exact.operationId} as its original record.`);
  if (client.state.canisterId !== exact.canisterId || client.state.owner !== exact.owner) throw new Error("The marketplace changed while preparing the installation quote. Review it again.");
  const currentScope = scope(context, exact.canisterId, exact.owner), storageKey = `installation:${exact.operationId}`;
  let saved = await loadIntent<SavedInstall>(context.kernel, storageKey);
  if (saved) { assertScope(saved.scope, currentScope); assertIdentity(saved.quote, exact); }
  if (exact.preferenceChanged && (!saved || !pendingFinancial(saved))) {
    if (saved) return view(saved, currentScope, await readReleasePreferences(context));
    await assertAdmission(context, exact);
  }
  const actionKey = `${exact.canisterId}:${exact.owner}:${exact.operationId}`;
  if (active.has(actionKey)) throw new Error(`Installation ${exact.operationId} is already being prepared. Wait for its original request.`);
  active.add(actionKey);
  try {
    await authorize(context, { kind: "installation", quote: exact as unknown as JsonObject });
    if (!saved || !pendingFinancial(saved)) await assertAdmission(context, exact);
    if (!saved) {
      saved = { version: 1, scope: currentScope, quote: exact, setupUrl: null, createdAt: Date.now(), prepareSubmitted: false };
      await saveIntent(context.kernel, storageKey, saved);
    } else if (!saved.access?.ready && JSON.stringify(readyQuote(saved)) !== JSON.stringify(exact)) {
      const next = { ...saved, quote: exact };
      await reviseIntent(context.kernel, storageKey, saved, next); saved = next;
    }
    if (!saved.setupUrl) {
      const refreshed = await quoteInstallation(context, exact.appIds, exact.operationId);
      assertQuote(exact, refreshed);
      const fees = Object.fromEntries(feeKeys.map(key => [key, BigInt(exact.fee[key])])) as Fee;
      const request = prepareRequest(exact);
      if (saved.prepareSubmitted === false) {
        await assertAdmission(context, exact);
        const next = { ...saved, prepareSubmitted: true };
        await reviseIntent(context.kernel, storageKey, saved, next); saved = next;
      }
      let prepared: { setupUrl: string };
      try {
        prepared = await client.update<{ setupUrl: string }>(request.method, request.request, fees);
      } catch (error) {
        // A missing response remains unknown. Only the protocol's explicit
        // terminal answer permits a new selection after this one was retired.
        if (error instanceof ProtocolError && (error.code === "release_unavailable" || error.code === "selection_changed")) {
          const next = { ...saved, unavailableReason: error.message };
          await reviseIntent(context.kernel, storageKey, saved, next); saved = next;
        }
        throw error;
      }
      if (typeof prepared.setupUrl !== "string" || !prepared.setupUrl) throw new Error("The marketplace did not return an installation offer.");
      const next = { ...saved, setupUrl: prepared.setupUrl };
      await reviseIntent(context.kernel, storageKey, saved, next); saved = next;
    }
    const afterPreparation = await readReleasePreferences(context);
    if (exact.releasePreferences && !releasePreferencesEqual(exact.releasePreferences, afterPreparation) && !pendingFinancial(saved)) return view(saved, currentScope, afterPreparation);
    if (!saved.access) {
      const sourceAccess = exact.sourceAccess;
      if (!sourceAccess || sourceAccess.source !== currentScope.canister) throw new Error("Refresh the installation cost to include download access.");
      const descriptor = await readInstallAccessDescriptor(currentScope.canister, { host: client.state.host, ...(context.signal ? { signal: context.signal } : {}) });
      if (descriptor.cycles !== sourceAccess.cycles || descriptor.fee_version !== sourceAccess.feeVersion) throw new Error("The download access cost changed. Refresh this installation’s cost before continuing; its prepared selection is retained.");
      const selection = await readInstallAccessSelection(saved.setupUrl!, currentScope.canister, exact.appIds, { host: client.state.host, ...(exact.selection ? { selection: exact.selection } : {}), ...(context.signal ? { signal: context.signal } : {}) });
      await assertAdmission(context, exact);
      const token = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, "0")).join("");
      const next: SavedInstall = { ...saved, access: { requestId: randomId(), token, paths: selection.paths, feeVersion: sourceAccess.feeVersion, cycles: sourceAccess.cycles, ready: false, submitted: false } };
      // Persist the exact request and bearer before calling the source. A lost
      // reply retries this same grant; it never generates a second credential.
      await reviseIntent(context.kernel, storageKey, saved, next); saved = next;
    }
    if (!saved.access!.ready) {
      if (saved.access!.submitted === false) {
        await assertAdmission(context, exact);
        const next = { ...saved, access: { ...saved.access!, submitted: true } };
        await reviseIntent(context.kernel, storageKey, saved, next); saved = next;
      }
      const access = saved.access!;
      context.signal?.throwIfAborted();
      await client.grantSourceAccess({ request_id: access.requestId, token: access.token, paths: access.paths, fee_version: BigInt(access.feeVersion) }, BigInt(access.cycles));
      const next: SavedInstall = { ...saved, access: { ...access, ready: true } };
      await reviseIntent(context.kernel, storageKey, saved, next); saved = next;
    }
    const currentPreferences = await readReleasePreferences(context);
    if (!context.agentMode || exact.releasePreferences && !releasePreferencesEqual(exact.releasePreferences, currentPreferences)) return view(saved, currentScope, currentPreferences);
    // Only this private in-process handoff contains the bearer. Public agent
    // results and durable-operation views below never include access records.
    await context.kernel.callTool({ target: "kernel", name: "apps.install_prepared", arguments: handoff(saved) }, 0);
    return markInstallationOpened(context, readyQuote(saved));
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)} Retain installation request ${exact.operationId} when continuing.`);
  } finally { active.delete(actionKey); }
}

/** Same-app UI transport only. Public tools always use installApplications. */
export async function prepareInstallationForTile(context: MsgBusToolContext, appIds: string[], quote: InstallationQuote): Promise<PrivateInstallResult> {
  if (!ownTile(context)) throw new Error("Prepared installation access belongs to the Marketplace tile.");
  const result = await installApplications(context, appIds, quote);
  const client = await protocolClient(context), current = scope(context, client.state.canisterId!, client.state.owner);
  const saved = await loadIntent<SavedInstall>(context.kernel, `installation:${result.operationId}`);
  if (!saved) throw new Error("The original installation record is unavailable.");
  assertScope(saved.scope, current);
  const preferences = await readReleasePreferences(context);
  if (saved.quote.releasePreferences && !releasePreferencesEqual(saved.quote.releasePreferences, preferences)) return { result: view(saved, current, preferences) };
  return { result, handoff: handoff(saved) };
}
