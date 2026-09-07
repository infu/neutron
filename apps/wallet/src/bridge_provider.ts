import type { MsgBusToolContext, SelfCallObject } from "neutron-tools/app";
import { requireEvmWalletCaller, type EvmAccount } from "neutron-tools/evm_wallet";
import { parseBridgeIntent, type BridgeIntent, type BridgeSource } from "./bridge.ts";
import { transferIdBytes } from "./transfers.ts";

export type BridgeProviderBinding = {
  appId: string; installationUid: string; agentMode: true;
  keyFingerprint: string; namespaceVersion: string;
};
export async function readBridgeProviderBinding(context: MsgBusToolContext, id: string): Promise<BridgeProviderBinding | null> {
  const result = await context.kernel.querySelf("wallet_bridge_provider_binding_v1", [transferIdBytes(id)]);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid saved bridge provider binding");
  const record = (result as Record<string, unknown>).binding;
  if (record === undefined || record === null) return null;
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Invalid saved bridge provider binding");
  const binding = record as Record<string, unknown>;
  if (typeof binding.app_id !== "string" || typeof binding.installation_uid !== "string" || binding.agent_mode !== true ||
    typeof binding.key_fingerprint !== "string" || !/^0x[0-9a-f]{64}$/.test(binding.key_fingerprint) ||
    typeof binding.namespace_version !== "string" || !/^[1-9][0-9]*$/.test(binding.namespace_version)) throw new Error("Invalid saved bridge provider binding");
  return { appId: binding.app_id, installationUid: binding.installation_uid, agentMode: true, keyFingerprint: binding.key_fingerprint, namespaceVersion: binding.namespace_version };
}
export async function assertLegacyBridgeExecutor(context: MsgBusToolContext, id: string): Promise<void> {
  if (await readBridgeProviderBinding(context, id)) throw new Error("This deposit uses the Wallet provider. Continue wallet_wrap_root_v1 with the original request ID; do not send it with the direct-root bridge tools.");
}
export function assertBridgeProviderOwner(binding: BridgeProviderBinding, source: BridgeSource, context: MsgBusToolContext, account?: EvmAccount): void {
  const caller = requireEvmWalletCaller(context, true);
  if (typeof source === "string" || source.appId !== caller.appId || source.installationUid !== caller.installationUid ||
    binding.appId !== caller.appId || binding.installationUid !== caller.installationUid) throw new Error("Only the original root Agent installation can continue this deposit");
  if (account && (binding.keyFingerprint !== account.keyFingerprint || binding.namespaceVersion !== account.namespaceVersion)) throw new Error("EVM Wallet's signing key changed. This saved deposit cannot be sent with another key.");
}
export async function prepareBridgeProvider(context: MsgBusToolContext, id: string, ledger: string, amount: string, account: EvmAccount): Promise<BridgeIntent> {
  const caller = requireEvmWalletCaller(context, true);
  const binding: SelfCallObject = { app_id: caller.appId, installation_uid: caller.installationUid, agent_mode: true, key_fingerprint: account.keyFingerprint, namespace_version: account.namespaceVersion };
  const intent = parseBridgeIntent(await context.kernel.updateSelf("wallet_bridge_provider_prepare_v1", [{
    bridge: { id: transferIdBytes(id), ledger, source: { evm_agent: { app_id: caller.appId, installation_uid: caller.installationUid } }, account: account.address, amount }, binding,
  }], 120));
  if (intent.id !== id || intent.quote.ledger !== ledger || intent.amount !== amount || intent.account.toLowerCase() !== account.address.toLowerCase()) throw new Error("The prepared bridge does not match this exact Wallet request");
  return intent;
}
