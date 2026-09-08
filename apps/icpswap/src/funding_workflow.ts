import { isJsonObject, type JsonObject, type JsonValue, type ScopedKernelClient } from "neutron-tools/app";
import {
  assertFundingResultMatchesRequest,
  parseFundingRequest,
  parseFundingResult,
  requestFunding,
  succeeded,
  WALLET_FUND_ROOT_TOOL,
  WALLET_TARGET,
  type FundingRequest,
  type FundingResult,
} from "./funding.ts";

/** Wire fields of the app's durable action journal. No Wallet request lives only in a tile. */
export type FundingOperation = {
  id: string;
  input_json: string;
  plan_json: string;
  funding_json: string;
  state: string;
  detail: string;
  result_json: string;
  revision: string;
  created_at: string;
  updated_at: string;
};
export type FundingUpdate = {
  id: string;
  expected_revision: string;
  state: string;
  detail: string;
  result_json: string;
  funding_json: string;
};
export type FundingStore = {
  get(id: string): Promise<FundingOperation | null>;
  update(update: FundingUpdate): Promise<FundingOperation>;
};
export type FundingInstruction = JsonObject & {
  target: typeof WALLET_TARGET;
  name: typeof WALLET_FUND_ROOT_TOOL;
  arguments: FundingRequest;
};
export type FundingProgress = {
  operation: FundingOperation;
  status: "ready" | "funding_required" | "pending" | "rejected" | "inactive";
  fundingInstructions: FundingInstruction[];
  message: string;
};

type SavedFundingResult = { requestId: string; result: FundingResult };

export function savedFundingRequests(operation: Pick<FundingOperation, "funding_json">): FundingRequest[] {
  if (operation.funding_json === "") return [];
  const value: JsonValue = JSON.parse(operation.funding_json);
  if (!Array.isArray(value)) throw new Error("Invalid saved Wallet funding requests");
  const requests = value.map(parseFundingRequest);
  if (new Set(requests.map((request) => request.requestId)).size !== requests.length) {
    throw new Error("Saved Wallet funding requests repeat an identity");
  }
  return requests;
}

function savedResults(operation: FundingOperation, requests: FundingRequest[]): SavedFundingResult[] {
  if (!operation.result_json) return [];
  const envelope: JsonValue = JSON.parse(operation.result_json);
  if (!isJsonObject(envelope) || envelope.kind !== "wallet_funding_v1" || !Array.isArray(envelope.results)) return [];
  return envelope.results.map((value) => {
    if (!isJsonObject(value) || typeof value.requestId !== "string") throw new Error("Invalid saved Wallet funding result");
    const request = requests.find((candidate) => candidate.requestId === value.requestId);
    if (!request) throw new Error("Saved Wallet result belongs to another funding request");
    const result = parseFundingResult(value.result as JsonValue, request.requestId);
    assertFundingResultMatchesRequest(result, request);
    return { requestId: request.requestId, result };
  });
}

function resultJson(results: SavedFundingResult[]): string {
  return JSON.stringify({ kind: "wallet_funding_v1", results });
}

function instructions(requests: FundingRequest[], results: SavedFundingResult[]): FundingInstruction[] {
  return requests.filter((request) => !results.some((value) => value.requestId === request.requestId && succeeded(value.result)))
    .map((request) => ({ target: WALLET_TARGET, name: WALLET_FUND_ROOT_TOOL, arguments: request }));
}

function update(store: FundingStore, operation: FundingOperation, fields: Partial<Pick<FundingUpdate, "state" | "detail" | "result_json" | "funding_json">>) {
  return store.update({ id: operation.id, expected_revision: operation.revision, state: operation.state,
    detail: operation.detail, result_json: operation.result_json, funding_json: operation.funding_json, ...fields });
}

/**
 * Finish only the funding prerequisite. The caller owns protocol dispatch and its
 * exact action review. Root mode returns instructions to its depth-zero Agent;
 * normal Agent and human calls use Wallet's existing owner review.
 */
export async function continueOperationFunding(input: {
  operation: FundingOperation;
  store: FundingStore;
  client: Pick<ScopedKernelClient, "callTool">;
  rootMode: boolean;
  /** Wallet command namespace; Root is the original coordinator app, normal is icpswap. */
  fundingCallerAppId?: string;
  /** Pure request builder; invoked only while the journal proves nothing was sent. */
  createRequests: (nowMs: number) => FundingRequest[];
  /** Replies from the root's direct calls, never accepted on the human route. */
  fundingResults?: JsonValue[];
  signal?: AbortSignal;
  nowMs?: number;
}): Promise<FundingProgress> {
  let operation = input.operation;
  const check = () => input.signal?.throwIfAborted();
  check();
  if (!["prepared", "funding_requested", "funded"].includes(operation.state)) {
    return { operation, status: "inactive", fundingInstructions: [], message: operation.detail };
  }
  if (operation.state === "funded") return { operation, status: "ready", fundingInstructions: [], message: "Funding prerequisites are retained." };
  let requests = savedFundingRequests(operation);
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Invalid clock");
  if (operation.state === "prepared" && (operation.funding_json === "" || requests.some((request) => BigInt(request.validUntilNs) <= BigInt(nowMs) * 1_000_000n))) {
    requests = input.createRequests(nowMs).map((request) => parseFundingRequest(request));
    operation = await update(input.store, operation, { funding_json: JSON.stringify(requests), result_json: "", detail: "Funding requests prepared." });
    check();
  }
  let results = savedResults(operation, requests);
  if (requests.length === 0) {
    operation = await update(input.store, operation, { state: "funded", detail: "No Wallet funding is required." });
    return { operation, status: "ready", fundingInstructions: [], message: operation.detail };
  }
  // A marker also precedes returning root instructions: once shared, their
  // outcome can be unknown. Never replace those requests just because time passed.
  if (operation.state === "prepared") {
    operation = await update(input.store, operation, { state: "funding_requested", detail: "Wallet funding requested. Retain these exact request IDs." });
    check();
  }
  if (input.rootMode && input.fundingResults?.length) {
    const accepted = input.fundingResults.map((value) => {
      const result = parseFundingResult(value);
      const request = requests.find((candidate) => result.commandId.endsWith(`:${candidate.requestId}`));
      if (!request) throw new Error("Wallet funding reply does not match this saved operation");
      assertFundingResultMatchesRequest(result, request);
      if (input.fundingCallerAppId !== undefined && result.commandId !== `${input.fundingCallerAppId}:${request.requestId}`) throw new Error("Wallet funding reply belongs to another calling application");
      return { requestId: request.requestId, result };
    });
    if (new Set(accepted.map((value) => value.requestId)).size !== accepted.length) throw new Error("Repeated Wallet funding reply");
    for (const value of accepted) {
      const prior = results.find((candidate) => candidate.requestId === value.requestId);
      if (prior && succeeded(prior.result)) continue;
      results = [...results.filter((candidate) => candidate.requestId !== value.requestId), value];
    }
    operation = await update(input.store, operation, { result_json: resultJson(results), detail: "Root Wallet funding replies retained." });
    check();
  }
  const rejected = () => results.find((value) => value.result.status === "rejected");
  if (rejected()) return { operation, status: "rejected", fundingInstructions: [], message: rejected()!.result.message ?? "Wallet declined a funding request. Review this saved operation and any earlier completed funding." };
  if (input.rootMode) {
    const remaining = instructions(requests, results);
    if (remaining.length) return { operation, status: "funding_required", fundingInstructions: remaining,
      message: "Call these exact Wallet tools directly from the root Agent, then call icpswap_continue_v1 with this operationId and their fundingResults. Reuse the same requests after a lost reply." };
  } else {
    for (const request of requests) {
      if (results.some((value) => value.requestId === request.requestId && succeeded(value.result))) continue;
      check();
      let result: FundingResult;
      try { result = await requestFunding(input.client, request); }
      catch (error) {
        // Wallet may already have committed. The marker and exact bytes survive
        // even if this diagnostic update is interrupted too.
        const message = `Wallet funding reply is unresolved: ${error instanceof Error ? error.message : String(error)}. Continue this same operation; its Wallet request will be replayed.`;
        try { operation = await update(input.store, operation, { detail: message }); } catch { /* Original dispatch marker is durable. */ }
        return { operation, status: "pending", fundingInstructions: [], message };
      }
      results = [...results.filter((value) => value.requestId !== request.requestId), { requestId: request.requestId, result }];
      // Persist each leg before asking Wallet for the next one.
      operation = await update(input.store, operation, { result_json: resultJson(results), detail: result.message ?? `Wallet funding ${result.status}.` });
      check();
      if (!succeeded(result)) return { operation, status: result.status === "rejected" ? "rejected" : "pending", fundingInstructions: [],
        message: result.message ?? (result.status === "rejected" ? "Wallet declined funding. Earlier funding, if any, remains recorded." : "Wallet funding is pending. Continue this same operation.") };
    }
  }
  operation = await update(input.store, operation, { state: "funded", detail: "Wallet funding prerequisites completed." });
  return { operation, status: "ready", fundingInstructions: [], message: operation.detail };
}
