import { expect, type FrameLocator, type Page } from "@playwright/test";

export type EvmWalletFaultState = {
  dropNextTransactionReply: boolean;
  omitCallerInstallationUid: boolean;
  droppedReply: Record<string, unknown> | null;
  omittedCallerCount: number;
};

/** Local qualification only: installed application bundles remain unchanged.
 * Drop one successful consumer reply, or emulate a Kernel without the additive
 * caller UID. Neither fault fabricates a wallet result or signs a transaction.
 */
export async function installEvmWalletBrowserFaults(
  page: Page,
  appIds: readonly string[] = ["evm_wallet", "kitchensink"],
): Promise<void> {
  await page.addInitScript((includedApps) => {
    const appId = /^\/app\/([^/]+)\//u.exec(location.pathname)?.[1];
    if (appId === undefined || !includedApps.includes(appId)) return;
    const scope = window as typeof window & {
      __NEUTRON_EVM_E2E_FAULTS__?: EvmWalletFaultState;
    };
    const state: EvmWalletFaultState = {
      dropNextTransactionReply: false,
      omitCallerInstallationUid: false,
      droppedReply: null,
      omittedCallerCount: 0,
    };
    scope.__NEUTRON_EVM_E2E_FAULTS__ = state;
    const originalAdd = MessagePort.prototype.addEventListener;
    const originalRemove = MessagePort.prototype.removeEventListener;
    const wrappers = new WeakMap<EventListenerOrEventListenerObject, EventListener>();
    const droppedIds = new Set<number>();
    MessagePort.prototype.addEventListener = function (
      this: MessagePort,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (!listener) return;
      if (type !== "message") {
        return originalAdd.call(this, type, listener, options);
      }
      let wrapped = wrappers.get(listener);
      if (!wrapped) {
        wrapped = (raw) => {
          const event = raw as MessageEvent;
          let data = event.data;
          if (data?.type === "response") {
            if (droppedIds.has(data.id)) return;
            if (state.dropNextTransactionReply && data.ok?.kind === "transaction" &&
                /^0x[0-9a-f]{64}$/iu.test(data.ok.transactionHash ?? "")) {
              state.dropNextTransactionReply = false;
              state.droppedReply = structuredClone(data.ok);
              droppedIds.add(data.id);
              return;
            }
          }
          const payload = data?.payload?.payload;
          if (state.omitCallerInstallationUid && data?.type === "exec" &&
              data.payload.action === "__neutron_msgbus_tools_call" &&
              payload?.name === "evm_send_transaction_v1" &&
              payload.caller && Object.hasOwn(payload.caller, "installationUid")) {
            data = structuredClone(data);
            delete data.payload.payload.caller.installationUid;
            state.omittedCallerCount += 1;
          }
          const forwarded = data === event.data ? event : new MessageEvent("message", {
            data,
            origin: event.origin,
            lastEventId: event.lastEventId,
            source: event.source,
            ports: [...event.ports],
          });
          if (typeof listener === "function") listener.call(this, forwarded);
          else listener.handleEvent(forwarded);
        };
        wrappers.set(listener, wrapped);
      }
      return originalAdd.call(this, type, wrapped, options);
    };
    MessagePort.prototype.removeEventListener = function (
      this: MessagePort,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ) {
      if (!listener) return;
      return originalRemove.call(this, type, wrappers.get(listener) ?? listener, options);
    };
  }, [...appIds]);
}

export async function setEvmWalletFault(
  frame: FrameLocator,
  fault: "dropNextTransactionReply" | "omitCallerInstallationUid",
): Promise<void> {
  await frame.locator("body").evaluate((_body, name) => {
    const state = (window as typeof window & {
      __NEUTRON_EVM_E2E_FAULTS__?: EvmWalletFaultState;
    }).__NEUTRON_EVM_E2E_FAULTS__;
    if (!state) throw new Error("EVM wallet qualification fault hook is missing");
    state[name] = true;
  }, fault);
}

export async function readEvmWalletFault(frame: FrameLocator): Promise<EvmWalletFaultState> {
  return frame.locator("body").evaluate(() => {
    const state = (window as typeof window & {
      __NEUTRON_EVM_E2E_FAULTS__?: EvmWalletFaultState;
    }).__NEUTRON_EVM_E2E_FAULTS__;
    if (!state) throw new Error("EVM wallet qualification fault hook is missing");
    return state;
  });
}

export const EVM_KERNEL_DIALOG_SELECTOR = [
  '[data-tid="frontend-tool-dialog"]',
  '[data-tid="call-dialog"]',
  '[data-tid="backend-call-dialog"]',
].join(", ");

export async function startEvmKernelDialogAudit(page: Page): Promise<void> {
  await page.evaluate((selector) => {
    const scope = window as typeof window & {
      __EVM_DIALOG_AUDIT__?: { observer: MutationObserver; seen: Set<string>; record: (node: Node) => void };
    };
    scope.__EVM_DIALOG_AUDIT__?.observer.disconnect();
    const seen = new Set<string>();
    const record = (node: Node): void => {
      if (!(node instanceof Element)) return;
      if (node.matches(selector)) seen.add((node as HTMLElement).dataset.tid ?? "unknown");
      node.querySelectorAll<HTMLElement>(selector).forEach((match) => seen.add(match.dataset.tid ?? "unknown"));
    };
    const observer = new MutationObserver((changes) => changes.forEach((change) => change.addedNodes.forEach(record)));
    observer.observe(document.body, { childList: true, subtree: true });
    record(document.body);
    scope.__EVM_DIALOG_AUDIT__ = { observer, seen, record };
  }, EVM_KERNEL_DIALOG_SELECTOR);
}

export async function expectNoEvmKernelDialogs(page: Page): Promise<void> {
  const seen = await page.evaluate(() => {
    const scope = window as typeof window & {
      __EVM_DIALOG_AUDIT__?: { observer: MutationObserver; seen: Set<string>; record: (node: Node) => void };
    };
    const audit = scope.__EVM_DIALOG_AUDIT__;
    if (!audit) throw new Error("Kernel dialog audit is missing");
    audit.observer.takeRecords().forEach((change) => change.addedNodes.forEach(audit.record));
    audit.observer.disconnect();
    return [...audit.seen];
  });
  expect(seen).toEqual([]);
  await expect(page.locator(EVM_KERNEL_DIALOG_SELECTOR)).toHaveCount(0);
}

/** Grant only inspection and saved-operation recovery tools. Status recovery
 * may persist refreshed evidence or rebroadcast already-approved bytes; it
 * cannot authorize a new signature. The Wallet owns every signing decision.
 */
export async function allowEvmInspectionGrantsUntil(
  page: Page,
  ready: () => Promise<boolean>,
): Promise<void> {
  await expect.poll(async () => {
    const dialog = page.locator('[data-tid="frontend-tool-dialog"]');
    if (await dialog.isVisible()) {
      const content = await dialog.textContent() ?? "";
      const allowed = ["evm_accounts_v1", "evm_networks_v1", "evm_operation_status_v1", "evm_balances_v1", "evm_read_contract_v1", "evm_transaction_v1", "evm_estimate_transaction_v1"];
      expect(allowed.some((name) => content.includes(name)), content).toBe(true);
      await dialog.locator('[data-tid="frontend-tool-approve-session"]').click();
    }
    await expect(page.locator('[data-tid="call-dialog"], [data-tid="backend-call-dialog"]')).toHaveCount(0);
    return ready();
  }, { timeout: 120_000, intervals: [100, 250, 500] }).toBe(true);
}
