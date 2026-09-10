import { callTool, type JsonObject, type EthereumProviderConnection } from "neutron-tools/app";
import type { MarketplaceClient, PublicationInput, PublicationQuote, PurchaseQuote, OperationResult, InstallationQuote } from "./view-types.ts";
import { base64, preparePublication, publicationFiles, UPLOAD_CHUNK_BYTES, type PublicationPlan } from "./publication.ts";

async function invoke<T>(write: boolean, method: string, args: unknown = {}): Promise<T> {
  const value = await callTool<{ resultJson: string }>({ target: "app:marketplace:background", name: write ? "ui_update" : "ui_query", arguments: { method, paramsJson: JSON.stringify(args) } }, { timeout: write ? 0 : 90 });
  if (typeof value.resultJson !== "string") throw new Error("Marketplace returned an invalid response.");
  return JSON.parse(value.resultJson) as T;
}
import { executeBrowserFundingStep, pollEthereumFundingReceipt, readEthereumFundingState, type EthereumFundingPlan, type EthereumFundingJournal, type EthereumFundingRecord } from "./ethereum.ts";

async function browserPurchase(connection: EthereumProviderConnection, quote?: PurchaseQuote, operationId?: string): Promise<OperationResult> {
  const prepared = await invoke<{ plan: EthereumFundingPlan; result: OperationResult; fundingRequired?: boolean }>(true, "ethereumPrepareBrowser", { ...(quote ? { quote } : {}), ...(operationId ? { operationId } : {}) });
  if (prepared.result.entitled || prepared.result.nextAction !== "resume") return prepared.result;
  const id = prepared.plan.invoice.operationId;
  if (prepared.fundingRequired === false) return invoke(true, "ethereumVerifyBrowser", { operationId: id });
  const journal: EthereumFundingJournal = {
    read: kind => invoke(false, "ethereumJournalRead", { operationId: id, kind }),
    claim: record => invoke(true, "ethereumJournalClaim", { operationId: id, record }),
    record: (previous, next) => invoke(true, "ethereumJournalRecord", { operationId: id, previous, next }),
  };
  async function step(kind: "approval" | "deposit"): Promise<EthereumFundingRecord> {
    let record = await executeBrowserFundingStep(prepared.plan, kind, connection, journal);
    if (record.state === "submitted" && record.transactionHash) {
      const observed = await pollEthereumFundingReceipt(connection.provider, record, { timeoutMs: 30_000 });
      record = await journal.record(record, observed);
    }
    return record;
  }
  const existingDeposit = await journal.read("deposit");
  if (!existingDeposit) {
    const existingApproval = await journal.read("approval");
    // An exact existing allowance needs no redundant approval transaction.
    if (existingApproval || (await readEthereumFundingState(prepared.plan, connection.provider)).approvalRequired) {
      const approval = await step("approval");
      if (approval.state !== "confirmed") return invoke(false, "operation", { operationId: id });
    }
  }
  const deposit = await step("deposit");
  if (deposit.state !== "confirmed") return invoke(false, "operation", { operationId: id });
  return invoke(true, "ethereumVerifyBrowser", { operationId: id });
}

async function publish(input: PublicationInput, quote: PublicationQuote, progress: (percent: number) => void): Promise<{ message: string }> {
  const plan = quote.opaque as PublicationPlan, files = publicationFiles(input);
  if (files.length !== plan.artifacts.length) throw new Error("The selected files changed. Review the upload again.");
  for (let index = 0; index < files.length; index++) {
    const file = files[index]!, artifact = plan.artifacts[index]!;
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))];
    if (file.size !== artifact.size || JSON.stringify(digest) !== JSON.stringify(artifact.digest)) throw new Error("A selected file differs from its reviewed upload. Review it again.");
  }
  await invoke(true, "beginPublication", { quote });
  const total = files.reduce((sum, file) => sum + file.size, 0);
  let finished = 0;
  for (let index = 0; index < files.length; index++) {
    const file = files[index]!;
    const initial = await invoke<{ uploadedBytes: number }>(true, "beginArtifact", { requestId: plan.requestId, index });
    let offset = initial.uploadedBytes;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.size) throw new Error("The protocol returned an invalid upload checkpoint.");
    while (offset < file.size) {
      const bytes = new Uint8Array(await file.slice(offset, offset + UPLOAD_CHUNK_BYTES).arrayBuffer());
      const reply = await invoke<{ uploadedBytes: number }>(true, "writeArtifact", { requestId: plan.requestId, index, offset, bytes: base64(bytes) });
      if (reply.uploadedBytes !== offset + bytes.length) throw new Error("The protocol did not confirm the uploaded chunk. Resume the same upload.");
      offset = reply.uploadedBytes;
      progress(total ? (finished + offset) / total * 100 : 100);
    }
    finished += file.size;
  }
  const result = await invoke<{ message: string }>(true, "finishPublication", { requestId: plan.requestId });
  progress(100);
  return result;
}
async function openInstallation(quote: InstallationQuote): Promise<OperationResult> {
  if (!quote.setupUrl) throw new Error("Prepare this saved selection before opening the installer.");
  // Dispatch from the physical tile before the first await. A background
  // round-trip would lose both endpoint provenance and the click activation.
  await callTool({ target: "kernel", name: "apps.install_offer", arguments: { kind: "repository_setup_url", url: quote.setupUrl } }, { timeout: 0 });
  return invoke(true, "installationOpened", { quote });
}

export function createMarketplaceClient(): MarketplaceClient {
  return {
    initialize: () => invoke(true, "initialize"), configure: args => invoke(true, "configure", args), connect: () => invoke(true, "connect"),
    catalog: args => invoke(false, "catalog", args), detail: appId => invoke(false, "detail", { appId }),
    library: cursor => invoke(false, "library", cursor ? { cursor } : {}), publisherApps: cursor => invoke(false, "publisherApps", cursor ? { cursor } : {}),
    earnings: () => invoke(false, "earnings"), createReferralCode: () => invoke(true, "createReferralCode"),
    quotePurchase: args => invoke(false, "quotePurchase", args), purchase: (quote, connection) => quote.ethereum?.wallet === "browser" ? connection ? browserPurchase(connection, quote) : Promise.reject(new Error("Connect the original browser wallet before paying.")) : invoke(true, "purchase", { quote }),
    operation: operationId => invoke(false, "operation", { operationId }), recentOperations: () => invoke(false, "recentOperations"), resumeOperation: (operationId, connection) => connection ? browserPurchase(connection, undefined, operationId) : invoke(true, "resumeOperation", { operationId }),
    cancelEthereumCheckout: operationId => invoke(true, "ethereumCancel", { operationId }),
    verifyEthereumTransaction: (operationId, transactionHash) => invoke(true, "ethereumVerifyOriginal", { operationId, transactionHash }),
    quoteInstallation: (appIds, operationId) => invoke(false, "quoteInstallation", { appIds, ...(operationId ? { operationId } : {}) }),
    install: (appIds, quote) => {
      if (JSON.stringify(appIds) !== JSON.stringify(quote.appIds)) return Promise.reject(new Error("The selected apps changed. Refresh the installation quote."));
      return quote.setupUrl ? openInstallation(quote) : invoke(true, "install", { appIds, quote });
    }, openInstallation, rate: (appId, stars, text) => invoke(true, "rate", { appId, stars, text }),
    quoteWithdrawal: args => invoke(false, "quoteWithdrawal", args), withdraw: quote => invoke(true, "withdraw", { quote }),
    quotePublication: async input => invoke(false, "quotePublication", { plan: await preparePublication(input) }), publish,
  };
}
