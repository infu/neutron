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
      for (const scope of historyScopes(gasCatalog, true)) addScope(scopes, scope);
    }
  }
  for (const principal of selected) {
    if (catalogByPrincipal.has(principal)) continue;
    for (const method of [
      "icrc1_metadata",
      "icrc1_balance_of",
      "icrc1_fee",
      "icrc1_transfer",
      "icrc3_get_blocks",
    ]) {
      addScope(scopes, exact(principal, method));
    }
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
    if (!desiredByKey.has(key)) actions.push({ kind: "release", scope });
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
  if (route.kind === "ckbtc") {
    return [
      exact(route.minter, "get_btc_address"),
      exact(route.minter, "update_balance"),
      exact(route.minter, "retrieve_btc_with_approval"),
    ];
  }
  if (route.kind === "ckdoge") {
    return [
      exact(route.minter, "get_doge_address"),
      exact(route.minter, "update_balance"),
      exact(route.minter, "retrieve_doge_with_approval"),
    ];
  }
  if (route.kind === "cksol") {
    return [
      exact(route.minter, "update_balance"),
      exact(route.minter, "withdraw"),
    ];
  }
  if (route.kind === "cketh") {
    return [exact(route.minter, "withdraw_eth")];
  }
  if (route.kind === "ckerc20") {
    if (!route.gasLedger) throw new Error("ckERC20 route is missing ckETH ledger");
    return [
      exact(route.minter, "eip_1559_transaction_price"),
      exact(route.minter, "withdraw_erc20"),
      exact(route.gasLedger, "icrc1_fee"),
      exact(route.gasLedger, "icrc2_approve"),
    ];
  }
  return [];
}

function historyScopes(
  ledger: CatalogLedger,
  includeBalanceRead = false,
): BackendCallReservationScope[] {
  if (!ledger.index && ledger.historyKind === "icp") {
    throw new Error(`${ledger.symbol} requires a history index`);
  }
  const scopes = ledger.index
    ? [exact(ledger.index, "get_account_transactions")]
    : [exact(ledger.principal, "icrc3_get_blocks")];
  if (includeBalanceRead) {
    scopes.unshift(exact(ledger.principal, "icrc1_balance_of"));
  }
  return scopes;
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
