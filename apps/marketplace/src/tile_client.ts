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
type PrivateInstallation = {
  result: OperationResult;
  handoff?: { url: string; appIds: string[]; access?: { source: string; token: string; paths: string[] } };
};

async function install(appIds: string[], quote: InstallationQuote): Promise<OperationResult> {
  if (JSON.stringify(appIds) !== JSON.stringify(quote.appIds)) throw new Error("The selected apps changed. Refresh the installation quote.");
  if (!quote.sourceAccess) {
    const refreshed = await invoke<InstallationQuote>(false, "quoteInstallation", { appIds, operationId: quote.operationId });
    if (refreshed.operationId !== quote.operationId || JSON.stringify(refreshed.appIds) !== JSON.stringify(appIds)) throw new Error("The refreshed quote does not match the saved installation request.");
    if (BigInt(refreshed.cycles.total) !== BigInt(quote.cycles.total) || BigInt(refreshed.sourceAccess?.cycles ?? "0") > 0n) return {
      operationId: quote.operationId, appIds, state: "review_required", nextAction: "review", installation: refreshed,
      message: "Review the current installation and download access cost before continuing with this saved request.",
    };
    quote = refreshed;
  }
  // Preparation and private download access complete before opening the generic
  // installer. Its manifest capability does not depend on click activation
  // surviving asynchronous canister calls.
  const response = await invoke<PrivateInstallation>(true, "install", { appIds, quote });
  const { result, handoff } = response;
  if (!result || result.operationId !== quote.operationId) throw new Error("The installation reply does not match the saved request.");
  if (!handoff) return result;
  const prepared = result.installation;
  if (!prepared || prepared.operationId !== quote.operationId || handoff.url !== prepared.setupUrl || JSON.stringify(handoff.appIds) !== JSON.stringify(appIds)) throw new Error("The installer handoff does not match the selected apps.");
  const opened = await callTool<{ presented: boolean; requestId: string }>({ target: "kernel", name: "apps.install_prepared", arguments: handoff }, { timeout: 0 });
  if (opened.presented !== true) throw new Error("The installer did not open. Resume the saved installation request.");
  // Only the public retained quote is acknowledged or returned to UI/history;
  // the download token remains private to this tile-to-Kernel handoff.
  return invoke(true, "installationOpened", { quote: prepared });
}

async function openInstallation(quote: InstallationQuote): Promise<OperationResult> {
  return install(quote.appIds, quote);
}

export function createMarketplaceClient(): MarketplaceClient {
  return {
    initialize: () => invoke(true, "initialize"), connect: () => invoke(true, "connect"),
    catalog: args => invoke(false, "catalog", args), detail: appId => invoke(false, "detail", { appId }),
    library: cursor => invoke(false, "library", cursor ? { cursor } : {}), publisherApps: cursor => invoke(false, "publisherApps", cursor ? { cursor } : {}),
    earnings: () => invoke(false, "earnings"), createReferralCode: () => invoke(true, "createReferralCode"),
    quotePurchase: args => invoke(false, "quotePurchase", args), purchase: (quote, connection) => quote.ethereum?.wallet === "browser" ? connection ? browserPurchase(connection, quote) : Promise.reject(new Error("Connect the original browser wallet before paying.")) : invoke(true, "purchase", { quote }),
    operation: operationId => invoke(false, "operation", { operationId }), recentOperations: () => invoke(false, "recentOperations"), resumeOperation: (operationId, connection) => connection ? browserPurchase(connection, undefined, operationId) : invoke(true, "resumeOperation", { operationId }),
    cancelEthereumCheckout: operationId => invoke(true, "ethereumCancel", { operationId }),
    verifyEthereumTransaction: (operationId, transactionHash) => invoke(true, "ethereumVerifyOriginal", { operationId, transactionHash }),
    quoteInstallation: (appIds, operationId) => invoke(false, "quoteInstallation", { appIds, ...(operationId ? { operationId } : {}) }),
    install, openInstallation, rate: (appId, stars, text) => invoke(true, "rate", { appId, stars, text }),
    quoteWithdrawal: args => invoke(false, "quoteWithdrawal", args), withdraw: quote => invoke(true, "withdraw", { quote }),
    quotePublication: async input => invoke(false, "quotePublication", { plan: await preparePublication(input) }), publish,
  };
}
