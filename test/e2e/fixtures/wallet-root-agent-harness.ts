import {
  createMsgBusClient,
  exposeTool,
  isJsonObject,
  requestAgentMode,
  type JsonObject,
  type MsgBusEndpointId,
  type MsgBusToolContext,
} from "neutron-tools/app";

const AGENT_ENTRYPOINT = "capability_agent_demo";
const WALLET_TARGET = "app:wallet:background" as const;
const WALLET_ROOT_TOOL = "wallet_fund_root_v1";
const NESTED_RELAY_TOOL = "wallet_root_nested_relay";
const ICP_LEDGER = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const TARGET = "eqsml-lyaaa-aaaaq-aacdq-cai";

const rootInputSchema: JsonObject = {
  type: "object",
  required: ["goal"],
  properties: { goal: { type: "string", enum: ["direct", "nested"] } },
  additionalProperties: false,
};
const relayInputSchema: JsonObject = {
  type: "object",
  required: ["request"],
  properties: { request: { type: "object" } },
  additionalProperties: false,
};
const objectOutputSchema: JsonObject = { type: "object" };

if (location.pathname.endsWith("/service.html")) {
  installResidentHarness();
} else {
  installTileHarness();
}

function installResidentHarness(): void {
  exposeTool(
    AGENT_ENTRYPOINT,
    {
      title: "Wallet root-agent E2E harness",
      description: "Exercise one deterministic, test-only scoped Agent call.",
      inputSchema: rootInputSchema,
      outputSchema: objectOutputSchema,
      annotations: {
        "neutron:effects": ["write", "network"],
        "neutron:longRunning": true,
      },
    },
    async (args, context) => {
      if (!context.agentMode || !context.signal) {
        throw new Error("The E2E harness requires an active Agent invocation");
      }
      const request = fundingRequest();
      if (args.goal === "direct") {
        return callWalletRoot(context, request);
      }
      if (args.goal !== "nested") {
        throw new Error("Invalid E2E harness goal");
      }
      return context.kernel.callTool(
        {
          target: ownTile(context),
          name: NESTED_RELAY_TOOL,
          arguments: { request },
        },
        180,
      );
    },
  );
}

function installTileHarness(): void {
  exposeTool(
    NESTED_RELAY_TOOL,
    {
      title: "Nested Wallet root-agent E2E relay",
      description: "Attempt the root-only Wallet call from depth one.",
      inputSchema: relayInputSchema,
      outputSchema: objectOutputSchema,
      annotations: { "neutron:visibility": "same_app" },
    },
    async (args, context) => {
      if (!isJsonObject(args.request)) {
        throw new Error("Invalid nested Wallet request");
      }
      return callWalletRoot(context, args.request);
    },
  );

  const root = document.getElementById("root");
  if (!root) throw new Error("Kitchen Sink E2E root is unavailable");
  root.replaceChildren(
    heading("Wallet root-agent installed E2E"),
    actionButton("agent-enable", "Enable Agent Mode", () =>
      requestAgentMode(AGENT_ENTRYPOINT)),
    actionButton("wallet-root-human", "Try as human", () =>
      createMsgBusClient().callTool(walletCall(fundingRequest()), 180)),
    actionButton("wallet-root-nested", "Try as nested agent", () =>
      createMsgBusClient().callTool({
        target: "app:kitchensink:background",
        name: AGENT_ENTRYPOINT,
        arguments: { goal: "nested" },
      }, 180)),
    actionButton("wallet-root-direct", "Run as root agent", () =>
      createMsgBusClient().callTool({
        target: "app:kitchensink:background",
        name: AGENT_ENTRYPOINT,
        arguments: { goal: "direct" },
      }, 180)),
    resultElement(),
  );
}

function actionButton(
  testId: string,
  label: string,
  action: () => Promise<unknown>,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.tid = testId;
  button.textContent = label;
  button.addEventListener("click", () => void runAction(testId, action));
  return button;
}

function heading(text: string): HTMLHeadingElement {
  const value = document.createElement("h1");
  value.dataset.tid = "wallet-root-harness";
  value.textContent = text;
  return value;
}

function resultElement(): HTMLPreElement {
  const result = document.createElement("pre");
  result.dataset.tid = "wallet-root-result";
  result.dataset.status = "idle";
  return result;
}

async function runAction(
  actionId: string,
  action: () => Promise<unknown>,
): Promise<void> {
  const result = document.querySelector<HTMLPreElement>(
    '[data-tid="wallet-root-result"]',
  );
  if (!result) throw new Error("Wallet root E2E result is unavailable");
  result.dataset.action = actionId;
  result.dataset.status = "pending";
  result.textContent = "pending";
  try {
    const value = await action();
    result.dataset.status = "success";
    result.textContent = JSON.stringify(value);
  } catch (error) {
    result.dataset.status = "error";
    result.textContent = error instanceof Error ? error.message : String(error);
  }
}

function callWalletRoot(
  context: MsgBusToolContext,
  request: JsonObject,
): Promise<JsonObject> {
  return context.kernel.callTool(walletCall(request), 180);
}

function walletCall(request: JsonObject) {
  return {
    target: WALLET_TARGET,
    name: WALLET_ROOT_TOOL,
    arguments: request,
  } as const;
}

function fundingRequest(): JsonObject {
  const requestId = new Uint8Array(16);
  crypto.getRandomValues(requestId);
  return {
    requestId: Array.from(
      requestId,
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join(""),
    ledger: ICP_LEDGER,
    amountAtoms: "1",
    validUntilNs: (BigInt(Date.now() + 4 * 60_000) * 1_000_000n).toString(),
    route: { kind: "direct", to: TARGET },
  };
}

function ownTile(context: MsgBusToolContext): MsgBusEndpointId {
  const endpoint = context.caller?.endpoint;
  if (
    context.caller?.appId !== "kitchensink" ||
    context.caller.role !== "tile" ||
    typeof endpoint !== "string" ||
    !/^app:kitchensink:tile:[^:]+:instance:[^:]+$/u.test(endpoint)
  ) {
    throw new Error("The root-agent E2E caller is not its Kitchen Sink tile");
  }
  return endpoint as MsgBusEndpointId;
}
