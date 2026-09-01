import { expect, test } from "bun:test";
import { Principal } from "@icp-sdk/core/principal";
import {
  normalizeToolDescriptor,
  validateToolArguments,
  validateToolResult,
  type JsonObject,
} from "neutron-tools/app";
import { encodeIcrcAccount } from "neutron-tools/src/icrc_account.js";
import {
  WALLET_FUNDING_EXECUTE_METHOD,
  WALLET_FUNDING_PREPARE_METHOD,
  WALLET_FUNDING_TOOL,
  assertRevokePreparedMatchesDisplay,
  fundingPrepareArgs,
  handleWalletFunding,
  mergeWalletAllowancesPages,
  parseFundingPrepareResult,
  parseWalletAllowancesPage,
  parseWalletFundingRequest,
  resolveWalletFundingPreparation,
  walletAllowancesPageArgs,
  walletFundingInputSchema,
  walletFundingOutputSchema,
  walletRevokePrepareArgs,
  type WalletFundingToolContext,
} from "../src/funding.ts";

const ledger = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const callerApp = "swap";
const requestId = "00112233445566778899aabbccddeeff";
const requestIdBytes = Uint8Array.from(
  { length: 16 },
  (_, index) => index * 17,
);
const commandId = {
  caller_app_id: callerApp,
  request_id: requestIdBytes,
};
const accountWithSubaccount = encodeIcrcAccount({
  owner: Principal.fromText(ledger),
  subaccount: Uint8Array.from([...new Array(31).fill(0), 255]),
});

const descriptor = normalizeToolDescriptor({
  name: WALLET_FUNDING_TOOL,
  inputSchema: walletFundingInputSchema,
  outputSchema: walletFundingOutputSchema,
  annotations: {
    "neutron:audit": "metadata_only",
    "neutron:consent": "provider_once",
    "neutron:effects": ["write", "network", "user_visible_ui"],
  },
});

const directRequest: JsonObject = {
  requestId,
  ledger,
  amountAtoms: "123456789",
  validUntilNs: "1800000000000000000",
  route: {
    kind: "direct",
    to: accountWithSubaccount,
    memoHex: "00ff",
  },
};

test("wallet_fund_v1 accepts closed canonical direct and allowance requests", () => {
  expect(() => validateToolArguments(descriptor, directRequest)).not.toThrow();
  expect(parseWalletFundingRequest(directRequest).route).toEqual({
    kind: "direct",
    to: accountWithSubaccount,
    memoHex: "00ff",
  });

  const allowance: JsonObject = {
    requestId,
    ledger,
    amountAtoms: "500000000",
    validUntilNs: "1800000000000000000",
    route: {
      kind: "allowance",
      spender: accountWithSubaccount,
      expiresAtNs: "1800000300000000000",
    },
  };
  expect(() => validateToolArguments(descriptor, allowance)).not.toThrow();
  expect(parseWalletFundingRequest(allowance).route).toMatchObject({
    kind: "allowance",
    spender: accountWithSubaccount,
  });

  expect(() =>
    validateToolArguments(descriptor, { ...directRequest, caller: "forged" }),
  ).toThrow();
  expect(() =>
    parseWalletFundingRequest({
      ...directRequest,
      requestId: "0".repeat(31),
    }),
  ).toThrow("Invalid request id");
  expect(() =>
    parseWalletFundingRequest({
      ...directRequest,
      route: { kind: "direct", to: ledger, memoHex: "0" },
    }),
  ).toThrow("Invalid transfer memo");
});

test("funding self-call arguments use the generated JSON wire contract", () => {
  const caller = {
    endpoint: "app:swap:background",
    appId: callerApp,
    role: null,
  };
  const direct = fundingPrepareArgs(
    parseWalletFundingRequest({
      ...directRequest,
      route: { kind: "direct", to: accountWithSubaccount },
    }),
    caller,
    false,
  );
  expect(direct).toEqual({
    request_id: requestIdBytes,
    ledger,
    valid_until_ns: "1800000000000000000",
    caller: {
      endpoint: "app:swap:background",
      app_id: callerApp,
    },
    agent_mode: false,
    intent: {
      direct: {
        amount_atoms: "123456789",
        to: accountWithSubaccount,
      },
    },
  });

  const allowance = fundingPrepareArgs(
    parseWalletFundingRequest({
      requestId,
      ledger,
      amountAtoms: "500000000",
      validUntilNs: "1800000000000000000",
      route: {
        kind: "allowance",
        spender: accountWithSubaccount,
        expiresAtNs: "1800000300000000000",
      },
    }),
    caller,
    true,
  );
  expect(allowance).toMatchObject({
    agent_mode: true,
    intent: {
      allowance: {
        amount_atoms: "500000000",
        spender: accountWithSubaccount,
        expires_at_ns: "1800000300000000000",
      },
    },
  });

  expect(walletAllowancesPageArgs(ledger, null)).toEqual({
    ledger,
    limit: "40",
  });
  expect(
    walletAllowancesPageArgs(ledger, {
      kind: "icrc103",
      fromAccount: ledger,
      toSpender: accountWithSubaccount,
      pages: "1",
      entries: "40",
    }),
  ).toEqual({
    ledger,
    cursor: {
      icrc103: {
        from_account: ledger,
        to_spender: accountWithSubaccount,
        pages: "1",
        entries: "40",
      },
    },
    limit: "40",
  });

  expect(
    walletRevokePrepareArgs(
      {
        key: `${ledger}:icrc:${accountWithSubaccount}`,
        ledger,
        spender: { kind: "icrc", account: accountWithSubaccount },
        amountAtoms: "200",
        expiresAtNs: null,
      },
      caller,
      requestId,
      "1800000000000000000",
    ),
  ).toMatchObject({
    caller: {
      endpoint: "app:swap:background",
      app_id: callerApp,
    },
    intent: {
      revoke: {
        source: { icrc: null },
        spender: { icrc: accountWithSubaccount },
        expected_allowance_atoms: "200",
      },
    },
  });
});

test("funding fails before preparation when provider approval is unavailable", async () => {
  const methods: string[] = [];
  const context = fundingContext(async (method) => {
    methods.push(method);
    throw new Error("must not call");
  });
  delete context.requestApproval;

  await expect(handleWalletFunding(directRequest, context)).rejects.toThrow(
    "provider approval support",
  );
  expect(methods).toEqual([]);
});

test("funding prepares, reviews authoritative facts once, then executes", async () => {
  const methods: string[] = [];
  const argumentsSeen: unknown[] = [];
  const reviews: JsonObject[] = [];
  const context = fundingContext(
    async (method, args) => {
      methods.push(method);
      argumentsSeen.push(args);
      if (method === WALLET_FUNDING_PREPARE_METHOD) {
        return preparedDirect();
      }
      if (method === WALLET_FUNDING_EXECUTE_METHOD) {
        return {
          transferred: {
            command_id: commandId,
            block_index: "91",
            duplicate: false,
          },
        };
      }
      throw new Error("unexpected method");
    },
    async (review) => {
      reviews.push(review);
    },
  );

  const result = await handleWalletFunding(directRequest, context);
  expect(methods).toEqual([
    WALLET_FUNDING_PREPARE_METHOD,
    WALLET_FUNDING_EXECUTE_METHOD,
  ]);
  const prepareArgs = (argumentsSeen[0] as unknown[])[0] as Record<
    string,
    unknown
  >;
  expect(prepareArgs.request_id).toEqual(requestIdBytes);
  expect(prepareArgs.caller).toEqual({
    endpoint: "app:swap:tile",
    app_id: callerApp,
    role: "tile",
  });
  expect(prepareArgs.agent_mode).toBe(false);
  expect(reviews).toHaveLength(1);
  expect(reviews[0]).toMatchObject({
    action: "Transfer tokens",
    commandId: `${callerApp}:${requestId}`,
    token: {
      ledger,
      symbol: "ICP",
      decimals: 8,
    },
    amount: { atoms: "123456789", display: "1.23456789 ICP" },
    destination: {
      account: accountWithSubaccount,
      owner: ledger,
      subaccountHex: `${"00".repeat(31)}ff`,
    },
  });
  expect(result).toEqual({
    status: "transferred",
    commandId: `${callerApp}:${requestId}`,
    blockIndex: "91",
    duplicate: false,
    message: null,
  });
  expect(() => validateToolResult(descriptor, result)).not.toThrow();
  const executeArgs = (argumentsSeen[1] as unknown[])[0] as Record<
    string,
    unknown
  >;
  expect(executeArgs.command_id).toEqual(commandId);
});

test("allowance review shows the exact current and replacement authority", async () => {
  const request: JsonObject = {
    requestId,
    ledger,
    amountAtoms: "100",
    validUntilNs: "1800000000000000000",
    route: {
      kind: "allowance",
      spender: accountWithSubaccount,
      expiresAtNs: "1800000300000000000",
    },
  };
  let review: JsonObject | null = null;
  const context = fundingContext(
    async (method) => {
      if (method === WALLET_FUNDING_PREPARE_METHOD) {
        return {
          prepared: {
            command_id: commandId,
            review: allowanceReview(),
          },
        };
      }
      return {
        approved: {
          command_id: commandId,
          block_index: "92",
          duplicate: false,
        },
      };
    },
    async (value) => {
      review = value;
    },
  );

  const result = await handleWalletFunding(request, context);
  expect(review).toMatchObject({
    action: "Approve token spending",
    allowanceChange: {
      current: { atoms: "50", display: "0.0000005 ICP" },
      replacement: { atoms: "110", display: "0.0000011 ICP" },
    },
    expirationChange: {
      currentNs: "1800000200000000000",
      replacementNs: "1800000300000000000",
    },
    spender: {
      account: accountWithSubaccount,
      owner: ledger,
      subaccountHex: `${"00".repeat(31)}ff`,
    },
  });
  expect(result).toMatchObject({ status: "approved", blockIndex: "92" });
});

test("funding rejects an execution receipt for another command", async () => {
  const context = fundingContext(async (method) => {
    if (method === WALLET_FUNDING_PREPARE_METHOD) return preparedDirect();
    return {
      transferred: {
        command_id: { ...commandId, caller_app_id: "another-app" },
        block_index: "91",
        duplicate: false,
      },
    };
  });

  await expect(handleWalletFunding(directRequest, context)).rejects.toThrow(
    "execution command mismatch",
  );
});

test("Agent Mode still requests approval and terminal replay never executes", async () => {
  const methods: string[] = [];
  let approvals = 0;
  const context = fundingContext(
    async (method) => {
      methods.push(method);
      return {
        completed: {
          review: directReview(),
          result: {
            transferred: {
              command_id: commandId,
              block_index: "91",
              duplicate: true,
            },
          },
        },
      };
    },
    async () => {
      approvals += 1;
    },
  );
  context.agentMode = true;

  const result = await handleWalletFunding(directRequest, context);
  expect(approvals).toBe(1);
  expect(methods).toEqual([WALLET_FUNDING_PREPARE_METHOD]);
  expect(result).toMatchObject({ status: "transferred", duplicate: true });
});

test("pending direct replay is approved once and re-enters reconciliation", async () => {
  const methods: string[] = [];
  let approvals = 0;
  const context = fundingContext(
    async (method) => {
      methods.push(method);
      if (method === WALLET_FUNDING_PREPARE_METHOD) {
        return {
          completed: {
            review: directReview(),
            result: {
              pending: {
                command_id: commandId,
                message: "Ledger outcome is unknown",
              },
            },
          },
        };
      }
      return {
        transferred: {
          command_id: commandId,
          block_index: "93",
          duplicate: true,
        },
      };
    },
    async () => {
      approvals += 1;
    },
  );

  const result = await handleWalletFunding(directRequest, context);
  expect(approvals).toBe(1);
  expect(methods).toEqual([
    WALLET_FUNDING_PREPARE_METHOD,
    WALLET_FUNDING_EXECUTE_METHOD,
  ]);
  expect(result).toMatchObject({
    status: "transferred",
    blockIndex: "93",
    duplicate: true,
  });
});

test("pending allowance replay is approved once and re-enters reconciliation", async () => {
  const request: JsonObject = {
    requestId,
    ledger,
    amountAtoms: "100",
    validUntilNs: "1800000000000000000",
    route: {
      kind: "allowance",
      spender: accountWithSubaccount,
      expiresAtNs: "1800000300000000000",
    },
  };
  const methods: string[] = [];
  let approvals = 0;
  const context = fundingContext(
    async (method) => {
      methods.push(method);
      if (method === WALLET_FUNDING_PREPARE_METHOD) {
        return {
          completed: {
            review: allowanceReview(),
            result: {
              pending: {
                command_id: commandId,
                message: "Ledger outcome is unknown",
              },
            },
          },
        };
      }
      return {
        approved: {
          command_id: commandId,
          block_index: "94",
          duplicate: true,
        },
      };
    },
    async () => {
      approvals += 1;
    },
  );

  const result = await handleWalletFunding(request, context);
  expect(approvals).toBe(1);
  expect(methods).toEqual([
    WALLET_FUNDING_PREPARE_METHOD,
    WALLET_FUNDING_EXECUTE_METHOD,
  ]);
  expect(result).toMatchObject({
    status: "approved",
    blockIndex: "94",
    duplicate: true,
  });
});

test("pending revoke replay re-enters reconciliation", async () => {
  const prepared = parseFundingPrepareResult({
    completed: {
      review: revokeReview(),
      result: {
        pending: {
          command_id: commandId,
          message: "Ledger outcome is unknown",
        },
      },
    },
  });
  let executeArgs: unknown = null;
  const result = await resolveWalletFundingPreparation(
    prepared,
    async (args) => {
      executeArgs = args;
      return {
        revoked: {
          command_id: commandId,
          duplicate: true,
        },
      };
    },
  );

  expect(executeArgs).toEqual({ command_id: commandId });
  expect(result).toMatchObject({
    status: "revoked",
    blockIndex: null,
    duplicate: true,
  });
});

test("abort after approval fences the funding execute", async () => {
  const controller = new AbortController();
  const methods: string[] = [];
  const context = fundingContext(
    async (method) => {
      methods.push(method);
      return preparedDirect();
    },
    async () => {
      controller.abort(new Error("cancelled"));
    },
  );
  context.signal = controller.signal;

  await expect(handleWalletFunding(directRequest, context)).rejects.toThrow(
    "cancelled",
  );
  expect(methods).toEqual([WALLET_FUNDING_PREPARE_METHOD]);
});

test("allowance pages preserve exact ICRC and ICP cursors and states", () => {
  const icrcPage = parseWalletAllowancesPage({
    ledger,
    token_symbol: "ICP",
    decimals: "8",
    revoke_fee_atoms: "10",
    source: { icrc103: null },
    state: { ready: null },
    entries: [
      {
        spender: {
          icrc: {
            owner: ledger,
            subaccount: Uint8Array.from([...new Array(31).fill(0), 255]),
          },
        },
        amount_atoms: "200",
        expires_at_ns: "1800000300000000000",
      },
    ],
    next: {
      icrc103: {
        from_account: { owner: ledger, subaccount: null },
        to_spender: {
          owner: ledger,
          subaccount: Uint8Array.from([...new Array(31).fill(0), 255]),
        },
        pages: "1",
        entries: "1",
      },
    },
    has_more: true,
  });
  expect(icrcPage.tokenName).toBe("ICP");
  expect(icrcPage.entries[0]).toMatchObject({
    key: `${ledger}:icrc:${accountWithSubaccount}`,
    amountAtoms: "200",
  });
  expect(icrcPage.next).toEqual({
    kind: "icrc103",
    fromAccount: ledger,
    toSpender: accountWithSubaccount,
    pages: "1",
    entries: "1",
  });
  const continuation = {
    ...icrcPage,
    entries: [
      {
        key: `${ledger}:icrc:aaaaa-aa`,
        ledger,
        spender: { kind: "icrc" as const, account: "aaaaa-aa" },
        amountAtoms: "400",
        expiresAtNs: null,
      },
    ],
    next: {
      kind: "icrc103" as const,
      fromAccount: ledger,
      toSpender: "aaaaa-aa",
      pages: "2",
      entries: "2",
    },
    hasMore: true,
  };
  expect(
    mergeWalletAllowancesPages(icrcPage, continuation).entries,
  ).toHaveLength(2);
  expect(() =>
    mergeWalletAllowancesPages(icrcPage, {
      ...continuation,
      decimals: 6,
    }),
  ).toThrow("changed during pagination");
  expect(() =>
    mergeWalletAllowancesPages(icrcPage, {
      ...continuation,
      next: { ...continuation.next, pages: "1" },
    }),
  ).toThrow("did not advance");

  const accountId = Uint8Array.from({ length: 32 }, (_, index) => index);
  const icpPage = parseWalletAllowancesPage({
    ledger,
    token_name: "Internet Computer",
    token_symbol: "ICP",
    decimals: "8",
    revoke_fee_atoms: "10",
    source: { icp: null },
    state: { ready: null },
    entries: [
      {
        spender: { icp_account_identifier: accountId },
        amount_atoms: "300",
      },
    ],
    next: {
      icp: {
        from_account_id: accountId,
        prev_spender_id: Uint8Array.from(accountId).reverse(),
        pages: "2",
        entries: "41",
      },
    },
    has_more: true,
  });
  expect(icpPage.entries[0]?.spender).toEqual({
    kind: "icp_account_identifier",
    account: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  });
  expect(icpPage.next).toMatchObject({
    kind: "icp",
    pages: "2",
    entries: "41",
  });

  const permission = parseWalletAllowancesPage({
    ledger,
    token_symbol: "CUSTOM",
    decimals: "0",
    source: { none: null },
    state: { permission_required: null },
    entries: [],
    has_more: false,
  });
  expect(permission.state).toBe("permission_required");
  expect(permission.source).toBe("none");

  const unsupported = parseWalletAllowancesPage({
    ledger,
    token_name: "Custom",
    token_symbol: "CUSTOM",
    decimals: "8",
    revoke_fee_atoms: null,
    source: { none: null },
    state: { unsupported: null },
    entries: [],
    next: null,
    has_more: false,
    warning: null,
  });
  expect(unsupported.state).toBe("unsupported");

  const degraded = parseWalletAllowancesPage({
    ledger,
    token_name: "Custom",
    token_symbol: "CUSTOM",
    decimals: "8",
    revoke_fee_atoms: "10",
    source: { icrc103: null },
    state: { degraded: "Ledger page limit reached" },
    entries: [],
    next: null,
    has_more: false,
    warning: "Results may be incomplete",
  });
  expect(degraded).toMatchObject({
    state: "degraded",
    stateDetail: "Ledger page limit reached",
    warning: "Results may be incomplete",
  });
});

test("revoke execution is gated by every displayed review-sensitive fact", () => {
  const page = parseWalletAllowancesPage({
    ledger,
    token_name: "Internet Computer",
    token_symbol: "ICP",
    decimals: "8",
    revoke_fee_atoms: "10",
    source: { icrc103: null },
    state: { ready: null },
    entries: [
      {
        spender: {
          icrc: {
            owner: ledger,
            subaccount: Uint8Array.from([...new Array(31).fill(0), 255]),
          },
        },
        amount_atoms: "200",
        expires_at_ns: "1800000300000000000",
      },
    ],
    next: null,
    has_more: false,
    warning: null,
  });
  const prepared = parseFundingPrepareResult({
    prepared: {
      command_id: commandId,
      review: revokeReview(),
    },
  });
  expect(() =>
    assertRevokePreparedMatchesDisplay(prepared, page, page.entries[0]!),
  ).not.toThrow();
  expect(() =>
    assertRevokePreparedMatchesDisplay(
      prepared,
      { ...page, revokeFeeAtoms: "11" },
      page.entries[0]!,
    ),
  ).toThrow("changed");

  expect(() =>
    parseWalletAllowancesPage({
      ledger,
      token_name: null,
      token_symbol: "ICP",
      decimals: "8",
      revoke_fee_atoms: "10",
      source: { icrc103: null },
      state: { ready: null },
      entries: [
        {
          spender: { icrc: { owner: ledger, subaccount: null } },
          amount_atoms: "1",
          expires_at_ns: "18446744073709551616",
        },
      ],
      next: null,
      has_more: false,
      warning: null,
    }),
  ).toThrow("allowance expiration");
});

function fundingContext(
  updateSelf: (method: string, args: unknown[]) => Promise<unknown>,
  requestApproval: (review: JsonObject) => Promise<void> = async () => {},
): WalletFundingToolContext {
  return {
    caller: {
      endpoint: "app:swap:tile",
      appId: callerApp,
      role: "tile",
      sessionId: "swap-session",
    },
    agentMode: false,
    reportProgress: () => undefined,
    requestApproval,
    kernel: {
      updateSelf,
    },
  } as unknown as WalletFundingToolContext;
}

function preparedDirect() {
  return {
    prepared: {
      command_id: commandId,
      review: directReview(),
    },
  };
}

function directReview() {
  return {
    command_id: commandId,
    kind: { direct: null },
    ledger,
    token_name: "Internet Computer",
    token_symbol: "ICP",
    decimals: "8",
    amount_atoms: "123456789",
    transfer_fee_atoms: "10",
    total_debit_atoms: "123456799",
    destination: {
      owner: ledger,
      subaccount: Uint8Array.from([...new Array(31).fill(0), 255]),
    },
    memo: Uint8Array.of(0, 255),
    valid_until_ns: "1800000000000000000",
  };
}

function revokeReview() {
  return {
    command_id: commandId,
    kind: { revoke: null },
    ledger,
    token_name: "Internet Computer",
    token_symbol: "ICP",
    decimals: "8",
    amount_atoms: "200",
    approval_fee_atoms: "10",
    allowance_atoms: "0",
    current_allowance_atoms: "200",
    current_expires_at_ns: "1800000300000000000",
    total_debit_atoms: "10",
    spender: {
      icrc: {
        owner: ledger,
        subaccount: Uint8Array.from([...new Array(31).fill(0), 255]),
      },
    },
    valid_until_ns: "1800000000000000000",
  };
}

function allowanceReview() {
  return {
    command_id: commandId,
    kind: { allowance: null },
    ledger,
    token_name: "Internet Computer",
    token_symbol: "ICP",
    decimals: "8",
    amount_atoms: "100",
    transfer_fee_atoms: "10",
    approval_fee_atoms: "10",
    allowance_atoms: "110",
    current_allowance_atoms: "50",
    current_expires_at_ns: "1800000200000000000",
    total_debit_atoms: "120",
    spender: {
      icrc: {
        owner: ledger,
        subaccount: Uint8Array.from([...new Array(31).fill(0), 255]),
      },
    },
    valid_until_ns: "1800000000000000000",
    expires_at_ns: "1800000300000000000",
  };
}
