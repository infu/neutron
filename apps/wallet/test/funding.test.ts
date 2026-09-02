import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  normalizeToolDescriptor,
  validateToolArguments,
  validateToolResult,
  type JsonObject,
  type MsgBusToolContext,
} from "neutron-tools/app";
import {
  decodeIcrcAccount,
  encodeIcrcAccount,
} from "neutron-tools/src/icrc_account.js";
import {
  WALLET_FUNDING_EXECUTE_METHOD,
  WALLET_FUNDING_PREPARE_METHOD,
  WALLET_FUNDING_PRESENT_TOOL,
  WALLET_FUNDING_TOOL,
  assertRevokePreparedMatchesDisplay,
  executeWalletFundingOperation,
  fundingPrepareArgs,
  handleWalletFunding,
  handleWalletRootFunding,
  mergeWalletAllowancesPages,
  parseFundingPrepareResult,
  parseWalletAllowancesPage,
  parseWalletFundingRequest,
  prepareWalletFundingOperation,
  rejectWalletFundingOperation,
  resolveWalletFundingPreparation,
  walletAllowancesPageArgs,
  walletFundingInputSchema,
  walletFundingOutputSchema,
  walletRevokePrepareArgs,
} from "../src/funding.ts";
import {
  WalletApprovals,
  acceptWalletFundingPrompt,
  handleWalletFundingPresentation,
  subscribeWalletFundingRefresh,
} from "../src/index.tsx";

const ledger = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const principalOnlyAccount = "togwv-zqaaa-aaaal-qr7aa-cai";
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
const subaccount = Uint8Array.from([...new Array(31).fill(0), 255]);
const accountWithSubaccount = encodeIcrcAccount({
  owner: decodeIcrcAccount(ledger).owner,
  subaccount,
});
const candidAccountWithSubaccount = { owner: ledger, subaccount };

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

  expect(() =>
    parseWalletFundingRequest({
      ...directRequest,
      route: { kind: "direct", to: ` ${principalOnlyAccount} ` },
    }),
  ).toThrow("Invalid transfer destination");
});

test("funding replies accept only exact Candid ICRC account records", () => {
  const prepared = parseFundingPrepareResult({
    prepared: {
      command_id: commandId,
      review: {
        ...directReview(),
        destination: { owner: principalOnlyAccount },
      },
    },
  });
  expect(prepared.value.review.destination).toBe(principalOnlyAccount);

  const explicitNull = parseFundingPrepareResult({
    prepared: {
      command_id: commandId,
      review: {
        ...directReview(),
        destination: { owner: principalOnlyAccount, subaccount: null },
      },
    },
  });
  expect(explicitNull.value.review.destination).toBe(principalOnlyAccount);

  for (const destination of [
    principalOnlyAccount,
    { owner: principalOnlyAccount, subaccount: undefined },
    { owner: principalOnlyAccount, extra: null },
    ` ${principalOnlyAccount} `,
  ]) {
    expect(() =>
      parseFundingPrepareResult({
        prepared: {
          command_id: commandId,
          review: { ...directReview(), destination },
        },
      })
    ).toThrow(/Invalid review destination/u);
  }
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

test("funding fails before preparation when provider UI is unavailable", async () => {
  const methods: string[] = [];
  const context = fundingContext(async (method) => {
    methods.push(method);
    throw new Error("must not call");
  });
  delete context.presentUserInterface;

  await expect(handleWalletFunding(directRequest, context)).rejects.toThrow(
    "provider UI support",
  );
  expect(methods).toEqual([]);
});

test("public funding forwards the canonical request to Wallet UI without preparing", async () => {
  const methods: string[] = [];
  const presentations: JsonObject[] = [];
  const context = fundingContext(
    async (method) => {
      methods.push(method);
      throw new Error("must not prepare in the resident");
    },
    async (request) => {
      presentations.push(request);
      return {
        status: "transferred",
        commandId: `${callerApp}:${requestId}`,
        blockIndex: "91",
        duplicate: false,
        message: null,
      };
    },
  );

  const result = await handleWalletFunding(directRequest, context);
  expect(methods).toEqual([]);
  expect(presentations).toEqual([
    {
      tileId: "wallet",
      tool: WALLET_FUNDING_PRESENT_TOOL,
      arguments: directRequest,
    },
  ]);
  expect(result).toEqual({
    status: "transferred",
    commandId: `${callerApp}:${requestId}`,
    blockIndex: "91",
    duplicate: false,
    message: null,
  });
  expect(() => validateToolResult(descriptor, result)).not.toThrow();
});

test("accepting a prepared foreground request executes and refreshes exactly once", async () => {
  const methods: string[] = [];
  const localUpdates: Array<{ snapshot: unknown; error: string | null }> = [];
  const unsubscribe = subscribeWalletFundingRefresh((update) =>
    localUpdates.push(update),
  );
  const context = fundingContext(async (method) => {
    methods.push(method);
    if (method === WALLET_FUNDING_PREPARE_METHOD) return preparedDirect();
    if (method === WALLET_FUNDING_EXECUTE_METHOD) {
      return {
        transferred: {
          command_id: commandId,
          block_index: "94",
          duplicate: false,
        },
      };
    }
    if (method === "wallet_refresh_balances") {
      return {
        owner: principalOnlyAccount,
        configured: true,
        ledgers: [],
      };
    }
    throw new Error(`Unexpected method ${method}`);
  });
  context.audience = "foreground_tile";

  const presentation = handleWalletFundingPresentation(directRequest, context);
  try {
    for (
      let attempt = 0;
      !methods.includes(WALLET_FUNDING_EXECUTE_METHOD) && attempt < 20;
      attempt += 1
    ) {
      await acceptWalletFundingPrompt(`${callerApp}:${requestId}`);
      await Promise.resolve();
    }
    expect(methods).toContain(WALLET_FUNDING_EXECUTE_METHOD);
    await expect(presentation).resolves.toMatchObject({
      status: "transferred",
      blockIndex: "94",
      duplicate: false,
    });
  } finally {
    unsubscribe();
  }
  expect(methods).toEqual([
    WALLET_FUNDING_PREPARE_METHOD,
    WALLET_FUNDING_EXECUTE_METHOD,
    "wallet_refresh_balances",
  ]);
  expect(localUpdates).toHaveLength(1);
  expect(localUpdates[0]?.error).toBeNull();
});

test("foreground funding reconciliation refreshes and updates its tile exactly once", async () => {
  const methods: string[] = [];
  const localUpdates: Array<{
    snapshot: unknown;
    error: string | null;
  }> = [];
  const unsubscribe = subscribeWalletFundingRefresh((update) =>
    localUpdates.push(update),
  );
  const context = fundingContext(async (method) => {
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
    if (method === WALLET_FUNDING_EXECUTE_METHOD) {
      return {
        transferred: {
          command_id: commandId,
          block_index: "93",
          duplicate: true,
        },
      };
    }
    if (method === "wallet_refresh_balances") {
      return {
        owner: principalOnlyAccount,
        configured: true,
        ledgers: [],
      };
    }
    throw new Error(`Unexpected method ${method}`);
  });
  context.audience = "foreground_tile";

  try {
    await expect(handleWalletFundingPresentation(directRequest, context)).resolves
      .toMatchObject({
        status: "transferred",
        blockIndex: "93",
        duplicate: true,
      });
  } finally {
    unsubscribe();
  }
  expect(methods).toEqual([
    WALLET_FUNDING_PREPARE_METHOD,
    WALLET_FUNDING_EXECUTE_METHOD,
    "wallet_refresh_balances",
  ]);
  expect(localUpdates).toEqual([
    {
      snapshot: {
        owner: principalOnlyAccount,
        configured: true,
        ledgers: [],
      },
      error: null,
    },
  ]);
});

test("foreground funding preserves the terminal receipt when its one refresh fails", async () => {
  const methods: string[] = [];
  const localUpdates: Array<{
    snapshot: unknown;
    error: string | null;
  }> = [];
  const unsubscribe = subscribeWalletFundingRefresh((update) =>
    localUpdates.push(update),
  );
  const context = fundingContext(async (method) => {
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
    if (method === WALLET_FUNDING_EXECUTE_METHOD) {
      return {
        transferred: {
          command_id: commandId,
          block_index: "93",
          duplicate: true,
        },
      };
    }
    if (method === "wallet_refresh_balances") {
      throw new Error("refresh unavailable");
    }
    throw new Error(`Unexpected method ${method}`);
  });
  context.audience = "foreground_tile";

  try {
    await expect(handleWalletFundingPresentation(directRequest, context)).resolves
      .toMatchObject({
        status: "transferred",
        blockIndex: "93",
        duplicate: true,
      });
  } finally {
    unsubscribe();
  }
  expect(methods).toEqual([
    WALLET_FUNDING_PREPARE_METHOD,
    WALLET_FUNDING_EXECUTE_METHOD,
    "wallet_refresh_balances",
  ]);
  expect(localUpdates).toEqual([
    {
      snapshot: null,
      error:
        "Wallet funding completed; balance refresh failed: refresh unavailable",
    },
  ]);
});

test("cancelling a foreground review does not start a self-call on an aborted context", async () => {
  const controller = new AbortController();
  const methods: string[] = [];
  const context = fundingContext(async (method) => {
    methods.push(method);
    if (method === WALLET_FUNDING_PREPARE_METHOD) return preparedDirect();
    throw new Error(`Unexpected method ${method}`);
  });
  context.audience = "foreground_tile";
  context.signal = controller.signal;

  const presentation = handleWalletFundingPresentation(directRequest, context);
  await waitFor(() => methods.length === 1);
  await Promise.resolve();
  controller.abort(new Error("cancelled"));

  await expect(presentation).rejects.toThrow("cancelled");
  await Promise.resolve();
  expect(methods).toEqual([WALLET_FUNDING_PREPARE_METHOD]);
});

test("tile preparation returns authoritative allowance facts and shared execution", async () => {
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
  const context = fundingContext(async () => ({
    prepared: {
      command_id: commandId,
      review: allowanceReview(),
    },
  }));
  const operation = await prepareWalletFundingOperation(request, context, false);
  expect(operation.preparation.value.review).toMatchObject({
    kind: "allowance",
    currentAllowanceAtoms: "50",
    allowanceAtoms: "110",
    currentExpiresAtNs: "1800000200000000000",
    expiresAtNs: "1800000300000000000",
    spender: { kind: "icrc", account: accountWithSubaccount },
  });
  const result = await executeWalletFundingOperation(operation, async () => ({
    approved: {
      command_id: commandId,
      block_index: "92",
      duplicate: false,
    },
  }));
  expect(result).toMatchObject({ status: "approved", blockIndex: "92" });
});

test("funding cannot be approved with incomplete or route-mixed review facts", async () => {
  const incompleteDirect = directReview();
  delete (incompleteDirect as Partial<typeof incompleteDirect>)
    .transfer_fee_atoms;
  await expect(
    prepareWalletFundingOperation(
      directRequest,
      fundingContext(async () => ({
        prepared: { command_id: commandId, review: incompleteDirect },
      })),
      false,
    ),
  ).rejects.toThrow("preparation is incomplete");

  const allowanceRequest: JsonObject = {
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
  for (const field of [
    "transfer_fee_atoms",
    "approval_fee_atoms",
    "allowance_atoms",
    "current_allowance_atoms",
  ] as const) {
    const incompleteAllowance = allowanceReview();
    delete incompleteAllowance[field];
    await expect(
      prepareWalletFundingOperation(
        allowanceRequest,
        fundingContext(async () => ({
          prepared: { command_id: commandId, review: incompleteAllowance },
        })),
        false,
      ),
    ).rejects.toThrow("preparation is incomplete");
  }
});

test("funding rejects an execution receipt for another command", async () => {
  const context = fundingContext(async () => preparedDirect());
  const operation = await prepareWalletFundingOperation(
    directRequest,
    context,
    false,
  );
  await expect(
    executeWalletFundingOperation(operation, async () => ({
      transferred: {
        command_id: { ...commandId, caller_app_id: "another-app" },
        block_index: "91",
        duplicate: false,
      },
    })),
  ).rejects.toThrow("execution command mismatch");
});

test("root funding requires agent_root and uses only its scoped self-call client", async () => {
  const methods: string[] = [];
  const argumentsSeen: unknown[] = [];
  const context = fundingContext(async (method, args) => {
    methods.push(method);
    argumentsSeen.push(args);
    if (method === WALLET_FUNDING_PREPARE_METHOD) {
      if (methods.length === 1) return preparedDirect();
      return {
        completed: {
          review: directReview(),
          result: {
            transferred: {
              command_id: commandId,
              block_index: "91",
              duplicate: false,
            },
          },
        },
      };
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
    throw new Error(`Unexpected method ${method}`);
  });
  let presentations = 0;
  context.presentUserInterface = async () => {
    presentations += 1;
    throw new Error("root funding must not present UI");
  };

  await expect(handleWalletRootFunding(directRequest, context)).rejects.toThrow(
    "requires root-agent attestation",
  );
  expect(methods).toEqual([]);
  expect(presentations).toBe(0);

  context.audience = "agent_root";
  await expect(handleWalletRootFunding(directRequest, context)).resolves
    .toMatchObject({
      status: "transferred",
      blockIndex: "91",
      duplicate: false,
    });
  await expect(handleWalletRootFunding(directRequest, context)).resolves
    .toMatchObject({
      status: "transferred",
      blockIndex: "91",
      duplicate: false,
    });
  expect(methods).toEqual([
    WALLET_FUNDING_PREPARE_METHOD,
    WALLET_FUNDING_EXECUTE_METHOD,
    WALLET_FUNDING_PREPARE_METHOD,
  ]);
  expect(
    ((argumentsSeen[0] as unknown[])[0] as { agent_mode: boolean }).agent_mode,
  ).toBe(true);
  expect(
    ((argumentsSeen[2] as unknown[])[0] as { agent_mode: boolean }).agent_mode,
  ).toBe(true);
  expect(argumentsSeen[1]).toEqual([{ command_id: commandId }]);
  expect(presentations).toBe(0);
});

test("root funding preserves invocation cancellation across execution", async () => {
  const controller = new AbortController();
  const methods: string[] = [];
  const context = fundingContext(async (method) => {
    methods.push(method);
    if (method === WALLET_FUNDING_PREPARE_METHOD) return preparedDirect();
    if (method === WALLET_FUNDING_EXECUTE_METHOD) {
      controller.abort(new Error("root invocation cancelled"));
      return {
        transferred: {
          command_id: commandId,
          block_index: "92",
          duplicate: false,
        },
      };
    }
    throw new Error(`Unexpected method ${method}`);
  });
  context.audience = "agent_root";
  context.signal = controller.signal;
  context.presentUserInterface = async () => {
    throw new Error("root funding must not present UI");
  };

  await expect(handleWalletRootFunding(directRequest, context)).rejects.toThrow(
    "root invocation cancelled",
  );
  expect(methods).toEqual([
    WALLET_FUNDING_PREPARE_METHOD,
    WALLET_FUNDING_EXECUTE_METHOD,
  ]);
});

test("pending direct replay re-enters reconciliation without another UI decision", async () => {
  const methods: string[] = [];
  const context = fundingContext(async (method) => {
    methods.push(method);
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
  });
  const operation = await prepareWalletFundingOperation(
    directRequest,
    context,
    false,
  );
  const result = await executeWalletFundingOperation(operation, async () => {
    methods.push(WALLET_FUNDING_EXECUTE_METHOD);
    return {
      transferred: {
        command_id: commandId,
        block_index: "93",
        duplicate: true,
      },
    };
  });
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

test("prepared funding can be rejected without executing it", async () => {
  const context = fundingContext(async () => preparedDirect());
  const operation = await prepareWalletFundingOperation(
    directRequest,
    context,
    false,
  );
  let rejectArgs: unknown = null;
  const result = await rejectWalletFundingOperation(
    operation,
    async (args) => {
      rejectArgs = args;
      return {
        rejected: {
          command_id: commandId,
          message: "Wallet funding was rejected by the owner",
        },
      };
    },
  );
  expect(rejectArgs).toEqual({ command_id: commandId });
  expect(result).toEqual({
    status: "rejected",
    commandId: `${callerApp}:${requestId}`,
    blockIndex: null,
    duplicate: null,
    message: "Wallet funding was rejected by the owner",
  });
});

test("pending allowance replay re-enters reconciliation", async () => {
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
  const context = fundingContext(async () => ({
    completed: {
      review: allowanceReview(),
      result: {
        pending: {
          command_id: commandId,
          message: "Ledger outcome is unknown",
        },
      },
    },
  }));
  const operation = await prepareWalletFundingOperation(request, context, false);
  const result = await executeWalletFundingOperation(operation, async () => ({
    approved: {
      command_id: commandId,
      block_index: "94",
      duplicate: true,
    },
  }));
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

test("abort during preparation never reaches execution", async () => {
  const controller = new AbortController();
  const methods: string[] = [];
  const context = fundingContext(async (method) => {
    methods.push(method);
    controller.abort(new Error("cancelled"));
    return preparedDirect();
  });
  context.signal = controller.signal;

  await expect(
    prepareWalletFundingOperation(directRequest, context, false),
  ).rejects.toThrow("cancelled");
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
          icrc: candidAccountWithSubaccount,
        },
        amount_atoms: "200",
        expires_at_ns: "1800000300000000000",
      },
    ],
    next: {
      icrc103: {
        from_account: { owner: ledger },
        to_spender: candidAccountWithSubaccount,
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

test("empty approval pages keep their continuation action visible", () => {
  const page = parseWalletAllowancesPage({
    ledger,
    token_name: "Internet Computer",
    token_symbol: "ICP",
    decimals: "8",
    revoke_fee_atoms: "10",
    source: { icrc103: null },
    state: { ready: null },
    entries: [],
    next: {
      icrc103: {
        from_account: { owner: ledger },
        to_spender: { owner: ledger, subaccount: null },
        pages: "1",
        entries: "0",
      },
    },
    has_more: true,
    warning: null,
  });
  const markup = renderToStaticMarkup(
    createElement(WalletApprovals, {
      busy: null,
      ledgers: [],
      loading: false,
      loadingMore: new Set<string>(),
      onLoadMore: () => undefined,
      onPermissionRequired: () => undefined,
      onRevoke: () => undefined,
      pages: [page],
    }),
  );

  expect(markup).toContain("Load more ICP approvals");
  expect(markup).not.toContain("No active approvals");
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
          icrc: candidAccountWithSubaccount,
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
          spender: { icrc: { owner: ledger } },
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
  presentUserInterface: (request: JsonObject) => Promise<JsonObject> = async () => ({
    status: "rejected",
    commandId: `${callerApp}:${requestId}`,
    blockIndex: null,
    duplicate: null,
    message: "fixture",
  }),
): MsgBusToolContext {
  return {
    caller: {
      endpoint: "app:swap:tile",
      appId: callerApp,
      role: "tile",
      sessionId: "swap-session",
    },
    agentMode: false,
    reportProgress: () => undefined,
    presentUserInterface,
    kernel: {
      updateSelf,
    },
  } as unknown as MsgBusToolContext;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Timed out waiting for Wallet funding state");
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
    destination: candidAccountWithSubaccount,
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
    spender: { icrc: candidAccountWithSubaccount },
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
    spender: { icrc: candidAccountWithSubaccount },
    valid_until_ns: "1800000000000000000",
    expires_at_ns: "1800000300000000000",
  };
}
