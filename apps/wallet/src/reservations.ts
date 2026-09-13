import {
  isJsonObject,
  type BackendCallReservationAction,
  type BackendCallReservationScope,
  type JsonValue,
} from "neutron-tools/app";
import type { CatalogLedger, CatalogNativeRoute } from "./catalog.ts";

export function desiredWalletReservationScopes(
  catalog: CatalogLedger[],
  selected: ReadonlySet<string>,
): BackendCallReservationScope[] {
  const scopes = new Map<string, BackendCallReservationScope>();
  const catalogByPrincipal = new Map(
    catalog.map((ledger) => [ledger.principal, ledger]),
  );
  for (const ledger of catalog) {
    if (!selected.has(ledger.principal)) continue;
    addScope(scopes, { kind: "principal", principal: ledger.principal });
    for (const scope of historyScopes(ledger)) addScope(scopes, scope);
    for (const scope of nativeScopes(ledger.nativeRoute)) {
      addScope(scopes, scope);
    }
    const gasLedger = ledger.nativeRoute?.gasLedger;
    if (gasLedger) {
      const gasCatalog = catalogByPrincipal.get(gasLedger);
      if (!gasCatalog) throw new Error("ckERC20 gas ledger is not in the catalog");
      for (const scope of historyScopes(gasCatalog)) addScope(scopes, scope);
    }
  }
  for (const principal of selected) {
    if (catalogByPrincipal.has(principal)) continue;
    addScope(scopes, { kind: "principal", principal });
  }
  return [...scopes.values()];
}

export function reservationActions(
  current: BackendCallReservationScope[],
  desired: BackendCallReservationScope[],
): BackendCallReservationAction[] {
  const currentByKey = new Map(
    current.map((scope) => [reservationScopeKey(scope), scope]),
  );
  const desiredByKey = new Map(
    desired.map((scope) => [reservationScopeKey(scope), scope]),
  );
  const actions: BackendCallReservationAction[] = [];
  for (const [key, scope] of desiredByKey) {
    if (!currentByKey.has(key)) actions.push({ kind: "reserve", scope });
  }
  for (const [key, scope] of currentByKey) {
    // Refill permissions belong to the app feature, not to the Assets watchlist.
    if (!desiredByKey.has(key) && !walletRefillReservationScopes().some((entry) => reservationScopeKey(entry) === key)) actions.push({ kind: "release", scope });
  }
  return actions;
}

export function parseWalletReservationScopes(
  value: JsonValue,
): BackendCallReservationScope[] {
  if (!isJsonObject(value) || !Array.isArray(value.reservations)) {
    throw new Error("Invalid backend access list");
  }
  return value.reservations.map((candidate) => {
    if (!isJsonObject(candidate)) throw new Error("Invalid backend access");
    if (
      candidate.scopeKind === "principal" &&
      typeof candidate.principal === "string"
    ) {
      return { kind: "principal", principal: candidate.principal };
    }
    if (
      candidate.scopeKind === "method" &&
      typeof candidate.method === "string"
    ) {
      return { kind: "method", method: candidate.method };
    }
    if (
      candidate.scopeKind === "exact" &&
      typeof candidate.principal === "string" &&
      typeof candidate.method === "string"
    ) {
      return {
        kind: "exact",
        principal: candidate.principal,
        method: candidate.method,
      };
    }
    throw new Error("Invalid backend access scope");
  });
}

export function reservationScopeKey(
  scope: BackendCallReservationScope,
): string {
  if (scope.kind === "principal") return `principal:${scope.principal}`;
  if (scope.kind === "method") return `method:${scope.method}`;
  return `exact:${scope.principal}:${scope.method}`;
}

function nativeScopes(
  route: CatalogNativeRoute | null,
): BackendCallReservationScope[] {
  if (!route) return [];
  if (route.kind === "ckerc20") {
    if (!route.gasLedger) throw new Error("ckERC20 route is missing ckETH ledger");
    return [
      { kind: "principal", principal: route.minter },
      { kind: "principal", principal: route.gasLedger },
    ];
  }
  return [{ kind: "principal", principal: route.minter }];
}

function historyScopes(ledger: CatalogLedger): BackendCallReservationScope[] {
  if (!ledger.index && ledger.historyKind === "icp") {
    throw new Error(`${ledger.symbol} requires a history index`);
  }
  return ledger.index
    ? [exact(ledger.index, "get_account_transactions")]
    : [exact(ledger.principal, "icrc3_get_blocks")];
}

function exact(principal: string, method: string): BackendCallReservationScope {
  return { kind: "exact", principal, method };
}

function addScope(
  scopes: Map<string, BackendCallReservationScope>,
  scope: BackendCallReservationScope,
): void {
  scopes.set(reservationScopeKey(scope), scope);
}

/** Refill recovery stays available even when a source token is hidden in Assets. */
export function walletRefillReservationScopes(): BackendCallReservationScope[] {
  return [
    { kind: "principal", principal: "ryjl3-tyaaa-aaaaa-aaaba-cai" },
    { kind: "principal", principal: "um5iw-rqaaa-aaaaq-qaaba-cai" },
    { kind: "principal", principal: "rkp4c-7iaaa-aaaaa-aaaca-cai" },
  ];
}
