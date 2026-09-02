import {
  isJsonObject,
  type JsonObject,
  type MsgBusCallerContext,
  type MsgBusToolContext,
  type SelfCallObject,
} from "neutron-tools/app";
import {
  bytesToHex,
  candidIcrcAccountFromText,
  canonicalIcrcAccountText,
  hexToBytes,
  parseCandidIcrcAccount,
  parseFixedBytes,
  parsePrincipal,
} from "./icrc_account.ts";

export const WALLET_FUNDING_TOOL = "wallet_fund_v1";
export const WALLET_FUNDING_ROOT_TOOL = "wallet_fund_root_v1";
export const WALLET_FUNDING_PRESENT_TOOL = "wallet_funding_present_v1";
export const WALLET_FUNDING_PREPARE_METHOD = "wallet_funding_prepare_v1";
export const WALLET_FUNDING_EXECUTE_METHOD = "wallet_funding_execute_v1";
export const WALLET_FUNDING_REJECT_METHOD = "wallet_funding_reject_v1";
export const WALLET_ALLOWANCES_PAGE_METHOD = "wallet_allowances_page_v1";
const WALLET_ALLOWANCE_PAGE_LIMIT = 40;

const natPattern = "^0$|^[1-9][0-9]{0,79}$";
const positiveNatPattern = "^[1-9][0-9]{0,79}$";
const positiveNat64Pattern = "^[1-9][0-9]{0,19}$";
const accountPattern = "^[a-z0-9.-]{5,160}$";

const directRouteSchema: JsonObject = {
  type: "object",
  required: ["kind", "to"],
  properties: {
    kind: { const: "direct" },
    to: {
      type: "string",
      minLength: 5,
      maxLength: 160,
      pattern: accountPattern,
    },
    memoHex: {
      type: "string",
      maxLength: 64,
      pattern: "^[0-9a-f]*$",
    },
  },
  additionalProperties: false,
};

const allowanceRouteSchema: JsonObject = {
  type: "object",
  required: ["kind", "spender", "expiresAtNs"],
  properties: {
    kind: { const: "allowance" },
    spender: {
      type: "string",
      minLength: 5,
      maxLength: 160,
      pattern: accountPattern,
    },
    expiresAtNs: { type: "string", pattern: positiveNat64Pattern },
  },
  additionalProperties: false,
};

export const walletFundingInputSchema: JsonObject = {
  type: "object",
  required: ["requestId", "ledger", "amountAtoms", "validUntilNs", "route"],
  properties: {
    requestId: {
      type: "string",
      minLength: 32,
      maxLength: 32,
      pattern: "^[0-9a-f]{32}$",
    },
    ledger: { type: "string", minLength: 5, maxLength: 63 },
    amountAtoms: { type: "string", pattern: positiveNatPattern },
    validUntilNs: { type: "string", pattern: positiveNat64Pattern },
    route: { oneOf: [directRouteSchema, allowanceRouteSchema] },
  },
  additionalProperties: false,
};

const nullableNatSchema: JsonObject = {
  oneOf: [{ type: "string", pattern: natPattern }, { type: "null" }],
};

const nullableTextSchema: JsonObject = {
  oneOf: [{ type: "string", maxLength: 512 }, { type: "null" }],
};

export const walletFundingOutputSchema: JsonObject = {
  type: "object",
  required: ["status", "commandId", "blockIndex", "duplicate", "message"],
  properties: {
    status: {
      type: "string",
      enum: ["transferred", "approved", "pending", "rejected"],
    },
    commandId: { type: "string", minLength: 1, maxLength: 180 },
    blockIndex: nullableNatSchema,
    duplicate: {
      oneOf: [{ type: "boolean" }, { type: "null" }],
    },
    message: nullableTextSchema,
  },
  additionalProperties: false,
};

export type WalletFundingRequest = {
  requestId: string;
  ledger: string;
  amountAtoms: string;
  validUntilNs: string;
  route:
    | { kind: "direct"; to: string; memoHex: string | null }
    | {
        kind: "allowance";
        spender: string;
        expiresAtNs: string;
      };
};

export type WalletFundingResult = {
  status: "transferred" | "approved" | "revoked" | "pending" | "rejected";
  commandId: string;
  blockIndex: string | null;
  duplicate: boolean | null;
  message: string | null;
};

export type WalletFundingCommandId = {
  callerAppId: string;
  requestId: string;
};

export type ParsedWalletFundingResult = WalletFundingResult & {
  command: WalletFundingCommandId;
};

export type WalletFundingReview = {
  commandId: WalletFundingCommandId;
  kind: "direct" | "allowance" | "revoke";
  ledger: string;
  tokenName: string;
  tokenSymbol: string;
  decimals: number;
  amountAtoms: string;
  transferFeeAtoms: string | null;
  approvalFeeAtoms: string | null;
  allowanceAtoms: string | null;
  currentAllowanceAtoms: string | null;
  currentExpiresAtNs: string | null;
  totalDebitAtoms: string;
  destination: string | null;
  spender: WalletApprovalSpender | null;
  memoHex: string | null;
  validUntilNs: string;
  expiresAtNs: string | null;
};

export type WalletFundingPrepared = {
  commandId: WalletFundingCommandId;
  review: WalletFundingReview;
};

export type WalletFundingPrepareResult =
  | { kind: "prepared"; value: WalletFundingPrepared }
  | {
      kind: "completed";
      value: { review: WalletFundingReview; result: ParsedWalletFundingResult };
    };

export type PreparedWalletFundingOperation = {
  request: WalletFundingRequest;
  caller: WalletFundingCaller;
  preparation: WalletFundingPrepareResult;
};

export async function handleWalletFunding(
  rawRequest: JsonObject,
  context: MsgBusToolContext,
): Promise<JsonObject> {
  const presentUserInterface = context.presentUserInterface;
  if (typeof presentUserInterface !== "function") {
    throw new Error(
      "Wallet funding requires a Kernel with provider UI support",
    );
  }
  throwIfAborted(context.signal);
  requireFundingCaller(context.caller);
  const request = parseWalletFundingRequest(rawRequest);
  return presentUserInterface<JsonObject>({
    tileId: "wallet",
    tool: WALLET_FUNDING_PRESENT_TOOL,
    arguments: walletFundingRequestJson(request),
  });
}

export async function handleWalletRootFunding(
  rawRequest: JsonObject,
  context: MsgBusToolContext,
): Promise<JsonObject> {
  if (context.audience !== "agent_root") {
    throw new Error("Wallet root funding requires root-agent attestation");
  }
  const operation = await prepareWalletFundingOperation(
    rawRequest,
    context,
    true,
  );
  return executeWalletFundingOperation(
    operation,
    (executeArgs) =>
      context.kernel.updateSelf(
        WALLET_FUNDING_EXECUTE_METHOD,
        [executeArgs],
        120,
      ),
    context.signal,
  );
}

export async function prepareWalletFundingOperation(
  rawRequest: JsonObject,
  context: MsgBusToolContext,
  agentMode: boolean,
): Promise<PreparedWalletFundingOperation> {
  throwIfAborted(context.signal);
  const caller = requireFundingCaller(context.caller);
  const request = parseWalletFundingRequest(rawRequest);
  const preparation = parseFundingPrepareResult(
    await context.kernel.updateSelf(
      WALLET_FUNDING_PREPARE_METHOD,
      [fundingPrepareArgs(request, caller, agentMode)],
      60,
    ),
  );
  throwIfAborted(context.signal);
  const command = fundingPreparationCommand(preparation);
  assertPreparedFundingMatchesRequest(
    preparation.value.review,
    command,
    request,
    caller,
  );
  return { request, caller, preparation };
}

export async function executeWalletFundingOperation(
  operation: PreparedWalletFundingOperation,
  execute: (args: SelfCallObject) => Promise<unknown>,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const result = await resolveWalletFundingPreparation(
    operation.preparation,
    execute,
    signal,
  );
  return externalFundingJson(operation.request, result);
}

export async function rejectWalletFundingOperation(
  operation: PreparedWalletFundingOperation,
  reject: (args: SelfCallObject) => Promise<unknown>,
): Promise<JsonObject> {
  const command = fundingPreparationCommand(operation.preparation);
  const result = parseFundingExecutionResult(
    await reject(walletFundingExecuteArgs(command)),
  );
  if (fundingCommandIdText(result.command) !== fundingCommandIdText(command)) {
    throw new Error("Wallet funding rejection command mismatch");
  }
  return externalFundingJson(operation.request, result);
}

export async function resolveWalletFundingPreparation(
  prepared: WalletFundingPrepareResult,
  execute: (args: SelfCallObject) => Promise<unknown>,
  signal?: AbortSignal,
): Promise<ParsedWalletFundingResult> {
  if (
    prepared.kind === "completed" &&
    prepared.value.result.status !== "pending"
  ) {
    return prepared.value.result;
  }
  const command = fundingPreparationCommand(prepared);
  throwIfAborted(signal);
  const result = parseFundingExecutionResult(
    await execute(walletFundingExecuteArgs(command)),
  );
  throwIfAborted(signal);
  if (fundingCommandIdText(result.command) !== fundingCommandIdText(command)) {
    throw new Error("Wallet funding execution command mismatch");
  }
  return result;
}

export function parseWalletFundingRequest(
  value: unknown,
): WalletFundingRequest {
  const request = exactObject(
    value,
    ["requestId", "ledger", "amountAtoms", "validUntilNs", "route"],
    "Wallet funding request",
  );
  const requestId = boundedString(request.requestId, 32, 32, "request id");
  if (!/^[0-9a-f]{32}$/.test(requestId)) throw new Error("Invalid request id");
  const ledger = canonicalPrincipalText(request.ledger, "ledger");
  const amountAtoms = requiredNat(request.amountAtoms, "funding amount");
  const validUntilNs = requiredNat64(request.validUntilNs, "funding deadline");
  if (amountAtoms === "0")
    throw new Error("Funding amount must be greater than zero");
  const routeRecord = requiredObject(request.route, "funding route");
  if (routeRecord.kind === "direct") {
    assertExactKeys(routeRecord, ["kind", "to"], ["memoHex"], "direct route");
    const to = canonicalIcrcAccountText(routeRecord.to, "transfer destination");
    const memoHex = optionalHex(routeRecord.memoHex, 32, "transfer memo");
    return {
      requestId,
      ledger,
      amountAtoms,
      validUntilNs,
      route: { kind: "direct", to, memoHex },
    };
  }
  if (routeRecord.kind === "allowance") {
    assertExactKeys(
      routeRecord,
      ["kind", "spender", "expiresAtNs"],
      [],
      "allowance route",
    );
    return {
      requestId,
      ledger,
      amountAtoms,
      validUntilNs,
      route: {
        kind: "allowance",
        spender: canonicalIcrcAccountText(
          routeRecord.spender,
          "allowance spender",
        ),
        expiresAtNs: requiredNat64(
          routeRecord.expiresAtNs,
          "allowance expiration",
        ),
      },
    };
  }
  throw new Error("Invalid funding route");
}

function walletFundingRequestJson(
  request: WalletFundingRequest,
): JsonObject {
  return {
    requestId: request.requestId,
    ledger: request.ledger,
    amountAtoms: request.amountAtoms,
    validUntilNs: request.validUntilNs,
    route:
      request.route.kind === "direct"
        ? {
            kind: "direct",
            to: request.route.to,
            ...(request.route.memoHex === null
              ? {}
              : { memoHex: request.route.memoHex }),
          }
        : {
            kind: "allowance",
            spender: request.route.spender,
            expiresAtNs: request.route.expiresAtNs,
          },
  };
}

export function fundingPrepareArgs(
  request: WalletFundingRequest,
  caller: WalletFundingCaller,
  agentMode: boolean,
): SelfCallObject {
  const intent: SelfCallObject =
    request.route.kind === "direct"
      ? {
          direct: {
            amount_atoms: request.amountAtoms,
            to: candidIcrcAccountFromText(
              request.route.to,
              "transfer destination",
            ),
            ...(request.route.memoHex === null
              ? {}
              : { memo: hexToBytes(request.route.memoHex, "transfer memo") }),
          },
        }
      : {
          allowance: {
            amount_atoms: request.amountAtoms,
            spender: candidIcrcAccountFromText(
              request.route.spender,
              "allowance spender",
            ),
            expires_at_ns: request.route.expiresAtNs,
          },
        };
  return {
    request_id: hexToBytes(request.requestId, "request id"),
    ledger: request.ledger,
    valid_until_ns: request.validUntilNs,
    caller: {
      endpoint: caller.endpoint,
      app_id: caller.appId,
      ...(caller.role === null ? {} : { role: caller.role }),
    },
    agent_mode: agentMode,
    intent,
  };
}

export type WalletFundingCaller = {
  endpoint: string;
  appId: string;
  role: string | null;
};

function requireFundingCaller(
  value: MsgBusCallerContext | undefined,
): WalletFundingCaller {
  if (!value)
    throw new Error("Wallet funding requires an authenticated caller");
  const endpoint = boundedString(value.endpoint, 1, 256, "caller endpoint");
  const appId = boundedString(value.appId, 1, 64, "caller app id");
  const role =
    value.role == null ? null : boundedString(value.role, 1, 32, "caller role");
  return { endpoint, appId, role };
}

export type WalletApprovalSource = "icrc103" | "icp" | "none";
export type WalletAllowanceState =
  "ready" | "unsupported" | "permission_required" | "degraded";
export type WalletApprovalSpender =
  | { kind: "icrc"; account: string }
  | { kind: "icp_account_identifier"; account: string };
export type WalletAllowanceCursor =
  | {
      kind: "icrc103";
      fromAccount: string;
      toSpender: string;
      pages: string;
      entries: string;
    }
  | {
      kind: "icp";
      fromAccountId: string;
      previousSpenderId: string;
      pages: string;
      entries: string;
    };
export type WalletAllowance = {
  key: string;
  ledger: string;
  spender: WalletApprovalSpender;
  amountAtoms: string;
  expiresAtNs: string | null;
};
export type WalletAllowancesPage = {
  ledger: string;
  tokenName: string;
  tokenSymbol: string;
  decimals: number;
  revokeFeeAtoms: string | null;
  source: WalletApprovalSource;
  state: WalletAllowanceState;
  stateDetail: string | null;
  entries: WalletAllowance[];
  next: WalletAllowanceCursor | null;
  hasMore: boolean;
  warning: string | null;
};

export function walletAllowancesPageArgs(
  ledger: string,
  cursor: WalletAllowanceCursor | null,
  limit = WALLET_ALLOWANCE_PAGE_LIMIT,
): SelfCallObject {
  const principal = canonicalPrincipalText(ledger, "allowance ledger");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Invalid allowance page limit");
  }
  return {
    ledger: principal,
    ...(cursor === null ? {} : { cursor: allowanceCursorWire(cursor) }),
    limit: String(limit),
  };
}

export function parseWalletAllowancesPage(
  value: unknown,
): WalletAllowancesPage {
  const page = exactObject(
    value,
    [
      "ledger",
      "token_symbol",
      "decimals",
      "source",
      "state",
      "entries",
      "has_more",
    ],
    "allowances page",
    ["token_name", "revoke_fee_atoms", "next", "warning"],
  );
  const ledger = canonicalPrincipalText(page.ledger, "allowance ledger");
  const tokenSymbol = boundedString(page.token_symbol, 1, 80, "token symbol");
  const tokenName =
    optionalBoundedString(page.token_name, 240, "token name") ?? tokenSymbol;
  const decimals = requiredDecimals(page.decimals);
  const source = variantTag(
    page.source,
    ["icrc103", "icp", "none"],
    "allowance source",
  );
  const parsedState = stateVariant(page.state);
  if (!Array.isArray(page.entries) || typeof page.has_more !== "boolean") {
    throw new Error("Invalid allowances page");
  }
  const entries = page.entries.map((entry) =>
    parseAllowance(entry, ledger, source),
  );
  const next = page.next == null ? null : parseAllowanceCursor(page.next);
  if (page.has_more !== (next !== null)) {
    throw new Error("Invalid allowance continuation");
  }
  return {
    ledger,
    tokenName,
    tokenSymbol,
    decimals,
    revokeFeeAtoms: optionalNat(page.revoke_fee_atoms, "revoke fee"),
    source,
    state: parsedState.state,
    stateDetail: parsedState.detail,
    entries,
    next,
    hasMore: page.has_more,
    warning: optionalBoundedString(page.warning, 512, "allowance warning"),
  };
}

export function failedWalletAllowancesPage(
  ledger: string,
  tokenName: string,
  tokenSymbol: string,
  decimals: number,
  message: string,
): WalletAllowancesPage {
  return {
    ledger,
    tokenName,
    tokenSymbol,
    decimals,
    revokeFeeAtoms: null,
    source: "none",
    state: "degraded",
    stateDetail: message,
    entries: [],
    next: null,
    hasMore: false,
    warning: message,
  };
}

export function mergeWalletAllowancesPages(
  current: WalletAllowancesPage,
  next: WalletAllowancesPage,
): WalletAllowancesPage {
  const requestedCursor = current.next;
  if (
    requestedCursor === null ||
    !current.hasMore ||
    next.ledger !== current.ledger ||
    next.tokenName !== current.tokenName ||
    next.tokenSymbol !== current.tokenSymbol ||
    next.decimals !== current.decimals ||
    next.revokeFeeAtoms !== current.revokeFeeAtoms ||
    next.source !== current.source ||
    current.state !== "ready" ||
    (next.state !== "ready" && next.state !== "degraded")
  ) {
    throw new Error("Allowance page changed during pagination");
  }
  if (next.next !== null) {
    if (
      next.next.kind !== requestedCursor.kind ||
      BigInt(next.next.pages) <= BigInt(requestedCursor.pages) ||
      BigInt(next.next.entries) < BigInt(requestedCursor.entries)
    ) {
      throw new Error("Allowance pagination did not advance");
    }
  }
  const entries = new Map(current.entries.map((entry) => [entry.key, entry]));
  for (const entry of next.entries) entries.set(entry.key, entry);
  return { ...next, entries: [...entries.values()] };
}

export function walletRevokePrepareArgs(
  entry: WalletAllowance,
  caller: WalletFundingCaller,
  requestId: string,
  validUntilNs: string,
): SelfCallObject {
  const source = entry.spender.kind === "icrc" ? "icrc" : "icp";
  const spender: SelfCallObject =
    entry.spender.kind === "icrc"
      ? {
          icrc: candidIcrcAccountFromText(
            entry.spender.account,
            "allowance spender",
          ),
        }
      : {
          icp_account_identifier: hexToBytes(
            entry.spender.account,
            "ICP spender account identifier",
          ),
        };
  return {
    request_id: hexToBytes(
      boundedString(requestId, 32, 32, "request id"),
      "request id",
    ),
    ledger: canonicalPrincipalText(entry.ledger, "allowance ledger"),
    valid_until_ns: requiredNat64(validUntilNs, "revoke deadline"),
    caller: {
      endpoint: caller.endpoint,
      app_id: caller.appId,
      ...(caller.role === null ? {} : { role: caller.role }),
    },
    agent_mode: false,
    intent: {
      revoke: {
        source: { [source]: null },
        spender,
        expected_allowance_atoms: requiredNat(
          entry.amountAtoms,
          "expected allowance",
        ),
        ...(entry.expiresAtNs === null
          ? {}
          : {
              expected_expires_at_ns: requiredNat64(
                entry.expiresAtNs,
                "expected allowance expiration",
              ),
            }),
      },
    },
  };
}

export function assertRevokePreparedMatchesDisplay(
  prepared: WalletFundingPrepareResult,
  page: WalletAllowancesPage,
  entry: WalletAllowance,
): void {
  const review = prepared.value.review;
  const fee = page.revokeFeeAtoms;
  if (
    fee === null ||
    review.kind !== "revoke" ||
    review.ledger !== entry.ledger ||
    review.tokenName !== page.tokenName ||
    review.tokenSymbol !== page.tokenSymbol ||
    review.decimals !== page.decimals ||
    review.spender === null ||
    review.spender.kind !== entry.spender.kind ||
    review.spender.account !== entry.spender.account ||
    review.currentAllowanceAtoms !== entry.amountAtoms ||
    review.currentExpiresAtNs !== entry.expiresAtNs ||
    review.allowanceAtoms !== "0" ||
    review.approvalFeeAtoms !== fee ||
    review.totalDebitAtoms !== fee
  ) {
    throw new Error(
      "The approval or revoke fee changed. Review the refreshed approval before trying again.",
    );
  }
}

function assertPreparedFundingMatchesRequest(
  review: WalletFundingReview,
  command: WalletFundingCommandId,
  request: WalletFundingRequest,
  caller: WalletFundingCaller,
): void {
  assertFundingReviewComplete(review);
  const routeMatches =
    request.route.kind === "direct"
      ? review.kind === "direct" &&
        review.destination === request.route.to &&
        review.memoHex === request.route.memoHex &&
        review.spender === null &&
        review.expiresAtNs === null
      : review.kind === "allowance" &&
        review.destination === null &&
        review.memoHex === null &&
        review.spender?.kind === "icrc" &&
        review.spender.account === request.route.spender &&
        review.expiresAtNs === request.route.expiresAtNs;
  if (
    command.callerAppId !== caller.appId ||
    command.requestId !== request.requestId ||
    fundingCommandIdText(review.commandId) !== fundingCommandIdText(command) ||
    review.ledger !== request.ledger ||
    review.amountAtoms !== request.amountAtoms ||
    review.validUntilNs !== request.validUntilNs ||
    !routeMatches
  ) {
    throw new Error("Wallet funding preparation does not match the request");
  }
}

function assertFundingReviewComplete(review: WalletFundingReview): void {
  const complete =
    review.kind === "direct"
      ? review.destination !== null &&
        review.spender === null &&
        review.transferFeeAtoms !== null &&
        review.approvalFeeAtoms === null &&
        review.allowanceAtoms === null &&
        review.currentAllowanceAtoms === null &&
        review.currentExpiresAtNs === null &&
        review.expiresAtNs === null
      : review.kind === "allowance" &&
        review.destination === null &&
        review.memoHex === null &&
        review.spender?.kind === "icrc" &&
        review.transferFeeAtoms !== null &&
        review.approvalFeeAtoms !== null &&
        review.allowanceAtoms !== null &&
        review.currentAllowanceAtoms !== null &&
        review.expiresAtNs !== null;
  if (!complete) {
    throw new Error("Wallet funding preparation is incomplete");
  }
}

export function parseFundingPrepareResult(
  value: unknown,
): WalletFundingPrepareResult {
  const [kind, payload] = variant(
    value,
    ["prepared", "completed"],
    "funding preparation",
  );
  if (kind === "prepared") {
    return { kind, value: parseFundingPrepared(payload) };
  }
  const completed = exactObject(
    payload,
    ["review", "result"],
    "completed funding preparation",
  );
  const review = parseFundingReview(completed.review);
  const execution = parseFundingExecutionResult(completed.result);
  if (
    fundingCommandIdText(review.commandId) !==
    fundingCommandIdText(execution.command)
  ) {
    throw new Error("Completed funding review command mismatch");
  }
  return {
    kind,
    value: {
      review,
      result: execution,
    },
  };
}

function parseFundingExecutionResult(
  value: unknown,
): ParsedWalletFundingResult {
  const [status, payload] = variant(
    value,
    ["transferred", "approved", "revoked", "pending", "rejected"],
    "funding result",
  );
  const record = requiredObject(payload, `${status} funding result`);
  const command = parseFundingCommandId(record.command_id);
  const commandId = fundingCommandIdText(command);
  if (status === "pending" || status === "rejected") {
    assertExactKeys(record, ["command_id", "message"], [], `${status} result`);
    return {
      status,
      commandId,
      blockIndex: null,
      duplicate: null,
      message: boundedString(record.message, 1, 512, `${status} message`),
      command,
    };
  }
  assertExactKeys(
    record,
    status === "transferred"
      ? ["command_id", "block_index", "duplicate"]
      : ["command_id", "duplicate"],
    status === "transferred" ? [] : ["block_index"],
    `${status} result`,
  );
  if (typeof record.duplicate !== "boolean") {
    throw new Error(`Invalid ${status} duplicate flag`);
  }
  return {
    status,
    commandId,
    blockIndex: optionalNat(record.block_index, `${status} block index`),
    duplicate: record.duplicate,
    message: null,
    command,
  };
}

function walletFundingExecuteArgs(
  commandId: WalletFundingCommandId,
): SelfCallObject {
  return {
    command_id: {
      caller_app_id: commandId.callerAppId,
      request_id: hexToBytes(commandId.requestId, "command request id"),
    },
  };
}

export function fundingPreparationCommand(
  preparation: WalletFundingPrepareResult,
): WalletFundingCommandId {
  return preparation.kind === "prepared"
    ? preparation.value.commandId
    : preparation.value.result.command;
}

export function walletFundingResultNeedsRefresh(result: JsonObject): boolean {
  return (
    result.status === "transferred" ||
    result.status === "approved" ||
    result.status === "pending"
  );
}

export function createWalletRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return bytesToHex(bytes);
}

export function walletRequestDeadlineNs(minutes = 5): string {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 30) {
    throw new Error("Invalid Wallet request lifetime");
  }
  return (
    BigInt(Date.now()) * 1_000_000n +
    BigInt(minutes) * 60_000_000_000n
  ).toString();
}

export function approvalExpirationText(expiresAtNs: string | null): string {
  if (expiresAtNs === null) return "No expiration";
  const milliseconds = BigInt(expiresAtNs) / 1_000_000n;
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) return expiresAtNs;
  const date = new Date(Number(milliseconds));
  return Number.isNaN(date.getTime()) ? expiresAtNs : date.toLocaleString();
}

function parseFundingPrepared(value: unknown): WalletFundingPrepared {
  const record = exactObject(
    value,
    ["command_id", "review"],
    "prepared funding",
  );
  const commandId = parseFundingCommandId(record.command_id);
  const review = parseFundingReview(record.review);
  if (
    fundingCommandIdText(commandId) !== fundingCommandIdText(review.commandId)
  ) {
    throw new Error("Funding review command mismatch");
  }
  return {
    commandId,
    review,
  };
}

function parseFundingCommandId(value: unknown): WalletFundingCommandId {
  const record = exactObject(
    value,
    ["caller_app_id", "request_id"],
    "funding command id",
  );
  return {
    callerAppId: boundedString(record.caller_app_id, 1, 64, "command caller"),
    requestId: bytesToHex(
      parseFixedBytes(record.request_id, 16, "command request id"),
    ),
  };
}

function fundingCommandIdText(commandId: WalletFundingCommandId): string {
  return `${commandId.callerAppId}:${commandId.requestId}`;
}

function parseFundingReview(value: unknown): WalletFundingReview {
  const record = exactObject(
    value,
    [
      "kind",
      "command_id",
      "ledger",
      "token_symbol",
      "decimals",
      "amount_atoms",
      "total_debit_atoms",
      "valid_until_ns",
    ],
    "funding review",
    [
      "token_name",
      "transfer_fee_atoms",
      "approval_fee_atoms",
      "allowance_atoms",
      "current_allowance_atoms",
      "current_expires_at_ns",
      "destination",
      "spender",
      "memo",
      "expires_at_ns",
    ],
  );
  return {
    commandId: parseFundingCommandId(record.command_id),
    kind: variantTag(
      record.kind,
      ["direct", "allowance", "revoke"],
      "funding review kind",
    ),
    ledger: canonicalPrincipalText(record.ledger, "funding review ledger"),
    tokenName:
      optionalBoundedString(record.token_name, 240, "token name") ??
      boundedString(record.token_symbol, 1, 80, "token symbol"),
    tokenSymbol: boundedString(record.token_symbol, 1, 80, "token symbol"),
    decimals: requiredDecimals(record.decimals),
    amountAtoms: requiredNat(record.amount_atoms, "review amount"),
    transferFeeAtoms: optionalNat(record.transfer_fee_atoms, "transfer fee"),
    approvalFeeAtoms: optionalNat(record.approval_fee_atoms, "approval fee"),
    allowanceAtoms: optionalNat(
      record.allowance_atoms,
      "replacement allowance",
    ),
    currentAllowanceAtoms: optionalNat(
      record.current_allowance_atoms,
      "current allowance",
    ),
    currentExpiresAtNs: optionalNat64(
      record.current_expires_at_ns,
      "current allowance expiration",
    ),
    totalDebitAtoms: requiredNat(record.total_debit_atoms, "maximum debit"),
    destination:
      record.destination == null
        ? null
        : parseCandidIcrcAccount(record.destination, "review destination"),
    spender:
      record.spender == null
        ? null
        : parseApprovalSpender(record.spender, "review spender"),
    memoHex: optionalMemoHex(record.memo),
    validUntilNs: requiredNat64(record.valid_until_ns, "review validity"),
    expiresAtNs: optionalNat64(record.expires_at_ns, "review expiration"),
  };
}

function parseAllowance(
  value: unknown,
  ledger: string,
  source: WalletApprovalSource,
): WalletAllowance {
  const record = exactObject(
    value,
    ["spender", "amount_atoms"],
    "allowance entry",
    ["expires_at_ns"],
  );
  const spender = parseApprovalSpender(record.spender, "allowance spender");
  if (
    (source === "icrc103" && spender.kind !== "icrc") ||
    (source === "icp" && spender.kind !== "icp_account_identifier") ||
    source === "none"
  ) {
    throw new Error("Invalid allowance source");
  }
  const amountAtoms = requiredNat(record.amount_atoms, "allowance amount");
  if (amountAtoms === "0") throw new Error("Invalid zero allowance");
  return {
    key: `${ledger}:${spender.kind}:${spender.account}`,
    ledger,
    spender,
    amountAtoms,
    expiresAtNs: optionalNat64(record.expires_at_ns, "allowance expiration"),
  };
}

function parseApprovalSpender(
  value: unknown,
  label: string,
): WalletApprovalSpender {
  const [kind, payload] = variant(
    value,
    ["icrc", "icp_account_identifier"],
    label,
  );
  return kind === "icrc"
    ? { kind, account: parseCandidIcrcAccount(payload, label) }
    : {
        kind,
        account: bytesToHex(parseFixedBytes(payload, 32, label)),
      };
}

function parseAllowanceCursor(value: unknown): WalletAllowanceCursor {
  const [kind, payload] = variant(
    value,
    ["icrc103", "icp"],
    "allowance cursor",
  );
  const record = requiredObject(payload, `${kind} allowance cursor`);
  if (kind === "icrc103") {
    assertExactKeys(
      record,
      ["from_account", "to_spender", "pages", "entries"],
      [],
      "ICRC allowance cursor",
    );
    return {
      kind,
      fromAccount: parseCandidIcrcAccount(
        record.from_account,
        "allowance cursor source",
      ),
      toSpender: parseCandidIcrcAccount(
        record.to_spender,
        "allowance cursor spender",
      ),
      pages: requiredNat(record.pages, "allowance cursor pages"),
      entries: requiredNat(record.entries, "allowance cursor entries"),
    };
  }
  assertExactKeys(
    record,
    ["from_account_id", "prev_spender_id", "pages", "entries"],
    [],
    "ICP allowance cursor",
  );
  return {
    kind,
    fromAccountId: bytesToHex(
      parseFixedBytes(
        record.from_account_id,
        32,
        "ICP allowance cursor source",
      ),
    ),
    previousSpenderId: bytesToHex(
      parseFixedBytes(
        record.prev_spender_id,
        32,
        "ICP allowance cursor spender",
      ),
    ),
    pages: requiredNat(record.pages, "allowance cursor pages"),
    entries: requiredNat(record.entries, "allowance cursor entries"),
  };
}

function allowanceCursorWire(cursor: WalletAllowanceCursor): SelfCallObject {
  return cursor.kind === "icrc103"
    ? {
        icrc103: {
          from_account: candidIcrcAccountFromText(
            cursor.fromAccount,
            "allowance cursor source",
          ),
          to_spender: candidIcrcAccountFromText(
            cursor.toSpender,
            "allowance cursor spender",
          ),
          pages: cursor.pages,
          entries: cursor.entries,
        },
      }
    : {
        icp: {
          from_account_id: hexToBytes(
            cursor.fromAccountId,
            "ICP allowance cursor source",
          ),
          prev_spender_id: hexToBytes(
            cursor.previousSpenderId,
            "ICP allowance cursor spender",
          ),
          pages: cursor.pages,
          entries: cursor.entries,
        },
      };
}

function stateVariant(value: unknown): {
  state: WalletAllowanceState;
  detail: string | null;
} {
  const [state, payload] = variant(
    value,
    ["ready", "unsupported", "permission_required", "degraded"],
    "allowance state",
  );
  return {
    state,
    detail:
      state === "degraded"
        ? boundedString(payload, 1, 512, "allowance state detail")
        : null,
  };
}

function variantTag<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  return variant(value, allowed, label)[0];
}

function variant<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): [T, unknown] {
  const record = requiredObject(value, label);
  const keys = Object.keys(record);
  if (keys.length !== 1 || !allowed.includes(keys[0] as T)) {
    throw new Error(`Invalid ${label}`);
  }
  const kind = keys[0] as T;
  return [kind, record[kind] ?? null];
}

function exactObject(
  value: unknown,
  required: readonly string[],
  label: string,
  optional: readonly string[] = [],
): JsonObject {
  const record = requiredObject(value, label);
  assertExactKeys(record, required, optional, label);
  return record;
}

function assertExactKeys(
  value: JsonObject,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new Error(`Invalid ${label}`);
  }
}

function requiredObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) throw new Error(`Invalid ${label}`);
  return value as JsonObject;
}

function boundedString(
  value: unknown,
  minLength: number,
  maxLength: number,
  label: string,
): string {
  if (
    typeof value !== "string" ||
    value.length < minLength ||
    value.length > maxLength
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function optionalBoundedString(
  value: unknown,
  maxLength: number,
  label: string,
): string | null {
  return value == null ? null : boundedString(value, 1, maxLength, label);
}

function requiredNat(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,79})$/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function requiredNat64(value: unknown, label: string): string {
  const parsed = requiredNat(value, label);
  if (BigInt(parsed) > 18_446_744_073_709_551_615n) {
    throw new Error(`Invalid ${label}`);
  }
  return parsed;
}

function optionalNat(value: unknown, label: string): string | null {
  return value == null ? null : requiredNat(value, label);
}

function optionalNat64(value: unknown, label: string): string | null {
  return value == null ? null : requiredNat64(value, label);
}

function requiredDecimals(value: unknown): number {
  const parsed =
    typeof value === "number" && Number.isInteger(value)
      ? value
      : typeof value === "string" && /^(0|[1-9][0-9]{0,2})$/.test(value)
        ? Number(value)
        : -1;
  if (parsed < 0 || parsed > 255) throw new Error("Invalid token decimals");
  return parsed;
}

function optionalHex(
  value: unknown,
  maxBytes: number,
  label: string,
): string | null {
  if (value == null) return null;
  const text = boundedString(value, 0, maxBytes * 2, label);
  if (text.length % 2 !== 0 || !/^[0-9a-f]*$/.test(text)) {
    throw new Error(`Invalid ${label}`);
  }
  return text;
}

function optionalMemoHex(value: unknown): string | null {
  if (value == null) return null;
  if (!(value instanceof Uint8Array) || value.byteLength > 32) {
    throw new Error("Invalid review memo");
  }
  return bytesToHex(value);
}

function canonicalPrincipalText(value: unknown, label: string): string {
  return parsePrincipal(value, label).toText();
}

function asFundingJson(value: WalletFundingResult): JsonObject {
  return {
    status: value.status,
    commandId: value.commandId,
    blockIndex: value.blockIndex,
    duplicate: value.duplicate,
    message: value.message,
  };
}

function externalFundingJson(
  request: WalletFundingRequest,
  value: WalletFundingResult,
): JsonObject {
  const expected = request.route.kind === "direct" ? "transferred" : "approved";
  if (
    value.status !== expected &&
    value.status !== "pending" &&
    value.status !== "rejected"
  ) {
    throw new Error("Wallet returned a result for another funding route");
  }
  return asFundingJson(value);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("Wallet funding was cancelled", "AbortError");
}
