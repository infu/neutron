import {
  createMsgBusClient, exposeTool, isJsonObject, requestAgentMode,
  type JsonObject, type MsgBusEndpointId,
} from "neutron-tools/app";

const ENTRYPOINT = "capability_agent_demo";
const RELAY = "evm_wallet_root_descendant_e2e";
const rootSchema: JsonObject = {
  type: "object", required: ["mode", "call"], additionalProperties: false,
  properties: {
    mode: { enum: ["direct", "descendant"] },
    call: { type: "object", required: ["target", "name", "arguments"], additionalProperties: false,
      properties: { target: { type: "string" }, name: { type: "string" }, arguments: { type: "object" } } },
  },
};

function readCall(value: unknown) {
  if (!isJsonObject(value) || typeof value.target !== "string" || typeof value.name !== "string" || !isJsonObject(value.arguments)) {
    throw new Error("Invalid deterministic E2E tool call");
  }
  return { target: value.target as MsgBusEndpointId, name: value.name, arguments: value.arguments as JsonObject };
}

if (location.pathname.endsWith("/service.html")) {
  exposeTool(ENTRYPOINT, {
    title: "EVM root protocol qualification", description: "Deterministic local-only Agent caller fixture.",
    inputSchema: rootSchema, outputSchema: { type: "object" },
    annotations: { "neutron:effects": ["write", "network"], "neutron:longRunning": true },
  }, async (args, context) => {
    if (!context.agentMode || !context.signal) throw new Error("An active Kernel Agent invocation is required");
    if (!context.agentConsent) throw new Error("Kernel Agent consent registration is unavailable");
    const unregister = context.agentConsent.register((challenge) => {
      const walletBackend = challenge.kind === "backend_access" && challenge.requester.appId === "evm_wallet";
      const uniswapWalletRead = challenge.kind === "frontend_tool" && challenge.requester.appId === "uniswap" &&
        challenge.action.targetAppId === "evm_wallet" &&
        ["evm_accounts_v1", "evm_read_contract_v1", "evm_estimate_transaction_v1", "evm_transaction_v1"].includes(String(challenge.action.tool));
      return {
        decision: walletBackend || uniswapWalletRead ? "allow" : "deny",
        reason: "Deterministic local qualification permits EVM Wallet backend access and Uniswap inspection calls only",
      };
    });
    try {
      const call = readCall(args.call);
      // Await before cleanup: descendants may request the root's consent while
      // their own asynchronous backend/inspection work is still running.
      if (args.mode === "direct") return await context.kernel.callTool(call, 180);
      const endpoint = context.caller?.endpoint;
      if (context.caller?.appId !== "kitchensink" || context.caller.role !== "tile" ||
          typeof endpoint !== "string" || !/^app:kitchensink:tile:[^:]+:instance:[^:]+$/u.test(endpoint)) {
        throw new Error("Root fixture caller is not its own Kitchen Sink tile");
      }
      return await context.kernel.callTool({ target: endpoint as MsgBusEndpointId, name: RELAY, arguments: { call: args.call! } }, 180);
    } finally {
      unregister();
    }
  });
} else {
  exposeTool(RELAY, {
    title: "EVM descendant misuse fixture", description: "Attempt a root-only tool from depth one.",
    inputSchema: { type: "object", required: ["call"], properties: { call: { type: "object" } }, additionalProperties: false },
    outputSchema: { type: "object" }, annotations: { "neutron:visibility": "same_app" },
  }, async (args, context) => context.kernel.callTool(readCall(args.call), 180));
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing EVM root fixture DOM");
  root.innerHTML = '<h1 data-tid="evm-root-harness">EVM root protocol qualification</h1><button data-tid="evm-root-enable" type="button">Enable Agent mode</button><pre data-tid="evm-root-grant"></pre>';
  root.querySelector("button")!.addEventListener("click", () => {
    void requestAgentMode(ENTRYPOINT).then(
      () => { root.querySelector("pre")!.textContent = "enabled"; },
      (error) => { root.querySelector("pre")!.textContent = String(error); },
    );
  });
  (window as typeof window & {
    __NEUTRON_EVM_ROOT_CALL__?: (mode: "direct" | "descendant" | "human", call: JsonObject) => Promise<JsonObject>;
  }).__NEUTRON_EVM_ROOT_CALL__ = (mode, raw) => {
    const call = readCall(raw);
    return mode === "human" ? createMsgBusClient().callTool(call, 180) : createMsgBusClient().callTool({
      target: "app:kitchensink:background", name: ENTRYPOINT, arguments: { mode, call },
    }, 180);
  };
}
