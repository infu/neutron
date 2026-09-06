import {
  createMsgBusClient, exposeTool, isJsonObject, requestAgentMode,
  type JsonObject, type MsgBusEndpointId, type MsgBusToolContext,
} from "neutron-tools/app";
import { createEvmWalletClient, type EvmSendTransactionRequest } from "neutron-tools/evm_wallet";

// A deterministic caller fixture. Installed Kernel, IC Wallet, EVM Wallet,
// released minter/ledger and their signing/consent boundaries remain actual.
const entrypoint = "capability_agent_demo";
const target = "app:wallet:background" as const;
const ledger = "ss2fx-dyaaa-aaaar-qacoq-cai";
const relay = "ic_bridge_root_nested_relay";
const inputSchema: JsonObject = {
  type: "object", required: ["action", "id"], additionalProperties: false,
  properties: {
    action: { enum: ["inspect", "direct", "nested", "refresh"] },
    id: { type: "string", pattern: "^[0-9a-f]{32}$" },
  },
};

if (location.pathname.endsWith("/service.html")) {
  exposeTool(entrypoint, {
    title: "IC bridge root qualification", inputSchema,
    outputSchema: { type: "object" },
    annotations: { "neutron:effects": ["read", "write", "network"], "neutron:longRunning": true },
  }, async (args, context) => {
    if (!context.agentMode || !context.signal) throw new Error("Active Agent invocation required");
    if (!context.agentConsent) throw new Error("Kernel Agent consent registration is unavailable");
    const unregister = context.agentConsent.register((challenge) => {
      const backend = challenge.kind === "backend_access" && ["wallet", "evm_wallet"].includes(challenge.requester.appId);
      const inspection = challenge.kind === "frontend_tool" && challenge.requester.appId === "wallet" && challenge.action.targetAppId === "evm_wallet" &&
        ["evm_accounts_v1", "evm_read_contract_v1", "evm_transaction_v1", "evm_replacement_transaction_v1"].includes(String(challenge.action.tool));
      return { decision: backend || inspection ? "allow" : "deny", reason: "Isolated bridge qualification permits Wallet backend access and IC Wallet inspection of EVM Wallet only" };
    });
    try {
    const evm = createEvmWalletClient(context.kernel);
    if (args.action === "inspect") return await evm.accounts() as unknown as JsonObject;
    const id = String(args.id);
    if (args.action === "nested") {
      return await context.kernel.callTool({
        target: ownTile(context), name: relay, arguments: { id },
      }, 180);
    }
    if (args.action === "refresh") return await context.kernel.callTool({ target, name: "wallet_bridge_refresh_v1", arguments: { id } }, 180);
    if (args.action !== "direct") throw new Error("Invalid qualification action");
    const prepared = await context.kernel.callTool({ target, name: "wallet_bridge_prepare_root_v1", arguments: request(id) }, 180);
    const next = await context.kernel.callTool<JsonObject>({ target, name: "wallet_bridge_next_root_v1", arguments: { id } }, 180);
    if (next.request === null) {
      const intent = next.intent as unknown as { steps: { kind: string; transactionHash: string | null }[] };
      const savedHash = intent.steps.find((step) => step.kind === next.step)?.transactionHash;
      if (next.step && savedHash) {
        const attachment = await context.kernel.callTool({ target, name: "wallet_bridge_attach_root_v1", arguments: { id, step: next.step, transactionHash: savedHash } }, 180);
        return { prepared, next, attachment };
      }
      return { prepared, next };
    }
    if (!isJsonObject(next.request)) throw new Error("Bridge did not return its exact next request");
    const transaction = next.request as EvmSendTransactionRequest;
    let operation = await evm.operationStatus({ accountId: transaction.accountId, chainId: transaction.chainId, requestId: transaction.requestId });
    if (operation.status === "not_found" || operation.status === "prepared" || operation.status === "preparing") {
      operation = await evm.sendTransactionRoot(transaction);
    }
    if (!operation.transactionHash) {
      return { prepared, next, operation: operation as unknown as JsonObject, attachment: null };
    }
    const attached = await context.kernel.callTool({
      target, name: "wallet_bridge_attach_root_v1",
      arguments: { id, step: next.step!, transactionHash: operation.transactionHash },
    }, 180);
    return { prepared, next, operation: operation as unknown as JsonObject, attachment: attached };
    } finally { unregister(); }
  });
} else {
  exposeTool(relay, {
    title: "Nested IC bridge qualification relay",
    inputSchema: { type: "object", required: ["id"], additionalProperties: false, properties: { id: { type: "string" } } },
    outputSchema: { type: "object" }, annotations: { "neutron:visibility": "same_app" },
  }, async (args, context) => context.kernel.callTool({ target, name: "wallet_bridge_prepare_root_v1", arguments: request(String(args.id)) }, 180));
  const root = document.getElementById("root");
  if (!root) throw new Error("Qualification tile root unavailable");
  const heading = document.createElement("h1");
  heading.textContent = "IC Wallet root bridge qualification";
  heading.dataset.tid = "ic-bridge-root-harness";
  const id = document.createElement("input");
  id.setAttribute("aria-label", "Bridge request ID");
  id.value = "10".repeat(16);
  const result = document.createElement("pre");
  result.dataset.tid = "ic-bridge-root-result";
  result.dataset.status = "idle";
  const button = (action: string, label: string, run: () => Promise<unknown>) => {
    const element = document.createElement("button");
    element.textContent = label;
    element.dataset.tid = action;
    element.addEventListener("click", () => {
      result.dataset.action = action; result.dataset.status = "pending";
      result.textContent = "pending";
      void run().then((value) => {
        result.textContent = JSON.stringify(value); result.dataset.status = "success";
      }, (error: unknown) => {
        result.textContent = error instanceof Error ? error.message : String(error);
        result.dataset.status = "error";
      });
    });
    return element;
  };
  const invoke = (action: string) => createMsgBusClient().callTool({
    target: "app:kitchensink:background", name: entrypoint, arguments: { action, id: id.value },
  }, 600);
  root.replaceChildren(
    heading, id,
    button("enable", "Enable Agent Mode", () => requestAgentMode(entrypoint)),
    button("inspect", "Inspect EVM account", () => invoke("inspect")),
    button("human", "Try bridge as human", () => createMsgBusClient().callTool({ target, name: "wallet_bridge_prepare_root_v1", arguments: request(id.value) }, 180)),
    button("nested", "Try bridge as nested agent", () => invoke("nested")),
    button("direct", "Execute bridge as root agent", () => invoke("direct")),
    button("refresh", "Refresh exact bridge mint", () => invoke("refresh")),
    result,
  );
}

function request(id: string): JsonObject { return { id, ledger, amountAtoms: "20000000000000000" }; }
function ownTile(context: MsgBusToolContext): MsgBusEndpointId {
  const endpoint = context.caller?.endpoint;
  if (context.caller?.appId !== "kitchensink" || context.caller.role !== "tile" || typeof endpoint !== "string" || !/^app:kitchensink:tile:[^:]+:instance:[^:]+$/u.test(endpoint)) {
    throw new Error("Qualification root must originate from its Kitchen Sink tile");
  }
  return endpoint as MsgBusEndpointId;
}
