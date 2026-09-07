import { useEffect, useState } from "react";
import { onAppStateChange } from "neutron-tools/app";
import type { Asset, Network, Operation } from "../data.ts";
import { presentOperation, type OperationPresentation } from "../presentation.ts";
import { enabledDecoderPacks, readDecoderPacks, subscribeDecoderPacks } from "./store.ts";
import { clearTokenMetadataCache } from "./metadata.ts";
import { resolveOperationPresentation } from "./runtime.ts";

let listening = false;
function followWalletState() {
  if (listening) return;
  listening = true;
  onAppStateChange("evm_wallet", clearTokenMetadataCache);
}

export function useOperationPresentation(operation: Operation, assets: readonly Asset[], network?: Network): OperationPresentation {
  const [revision, setRevision] = useState(0);
  const tx = operation.preparedTransaction ?? operation.intent.transaction;
  const scope = JSON.stringify([operation.kind, operation.chainId, operation.address, tx, operation.intent, assets, network]);
  const [resolved, setResolved] = useState<{ scope: string; revision: number; presentation: OperationPresentation } | null>(null);
  useEffect(() => {
    followWalletState();
    return subscribeDecoderPacks(() => setRevision(value => value + 1));
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      let packs: ReturnType<typeof enabledDecoderPacks> = [], warning: string | undefined;
      try { packs = enabledDecoderPacks(await readDecoderPacks()); }
      catch { warning = "Imported decoder definitions could not be loaded. Built-in and exact transaction details remain available."; }
      if (controller.signal.aborted) return;
      const local = presentOperation(operation, assets, network, packs);
      setResolved({ scope, revision, presentation: { ...local, ...(warning ? { decoderWarning: warning } : {}) } });
      const presentation = await resolveOperationPresentation(operation, assets, network, { packs, signal: controller.signal });
      if (!controller.signal.aborted) setResolved({ scope, revision, presentation: { ...presentation, ...(warning ? { decoderWarning: warning } : {}) } });
    })().catch(() => { /* Existing exact review remains usable if metadata is unavailable. */ });
    return () => controller.abort();
  }, [scope, revision]);
  return resolved?.scope === scope && resolved.revision === revision ? resolved.presentation : presentOperation(operation, assets, network);
}
