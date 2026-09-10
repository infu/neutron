/** Browser view models. Monetary atomic values remain exact decimal strings. */
export type RankingWindow = "week" | "month" | "all";
export type AppTier = "free" | "paid";
export type PaymentToken = "ICP" | "ckBTC" | "ckUSDC";
export type Money = { atoms: string; decimals: number; symbol: string };
export type Page<T> = { items: T[]; nextCursor: string | null; asOf?: string; warning?: string };
export type AppListing = {
  id: string; title: string; summary: string; category: string; publisher: string;
  priceUsdMicros: string; iconUrl?: string; version: string;
  rating: number | null; ratingCount: number; acquisitions?: number; owned?: boolean;
};
export type AuditView = { auditor: string; verdict: "approved" | "rejected" | "revoked"; analysis: string; date: string; packageHash: string };
export type AppDetail = AppListing & {
  description: string; screenshots: { url: string; caption?: string }[];
  website?: string; sourceUrl?: string; audit: AuditView | null;
  releaseNotes?: string; ownRating?: { stars: number; text: string } | null;
};
export type LibraryApp = AppListing & { acquiredAt: string; installedVersion: string | null; available: boolean; unavailableReason?: string };
export type PublishedApp = AppListing & {
  status: "draft" | "uploading" | "in_review" | "approved" | "rejected" | "revoked";
  rejectionReason?: string; coverageEndsAt?: string;
};
export type Session = { configured: boolean; canisterId: string; host: string; account: string | null; connected: boolean };
export type CycleEstimate = { total: string; processing: string; storage?: string; schedule: string };
export type Allocation = { kind: "developer" | "affiliate" | "burn"; principal: string | null; amount: Money; label?: string };
export type PurchaseQuote = {
  operationId: string; commitment: string; appIds: string[]; items: AppListing[];
  token: PaymentToken; subtotalUsdMicros: string; discountUsdMicros: string;
  payment: Money; approvalFee: Money; collectionFee: Money; totalDebit: Money;
  allocations: Allocation[]; cycles: CycleEstimate; affiliateCode: string;
  priceObservedAt?: string; warnings: string[];
  /** Preserves the exact protocol quote for same-ID execution and recovery. */
  opaque: unknown;
};
export type OperationResult = {
  operationId: string; state: "complete" | "pending" | "approval_required" | "review_required" | "failed";
  message: string; nextAction: "none" | "resume" | "review"; appIds?: string[];
  /** Ledger-confirmed block returned for the retained attempt, when available. */
  ledgerBlock?: string;
};
export type Earnings = {
  referralCode: string | null; affiliateDiscountBps: number; affiliateShareBps: number;
  balances: { token: PaymentToken; available: Money; reserved: Money; earned: Money | null }[];
};
export type WithdrawalQuote = {
  operationId: string; token: PaymentToken; destination: string; debit: Money;
  fee: Money; receive: Money; cycles: CycleEstimate; warnings: string[]; opaque: unknown;
};
export type PublicationInput = {
  appId: string; title: string; summary: string; description: string; category: string;
  priceUsdMicros: string; website: string; releaseNotes: string;
  packageFile: File | null; sourceFile: File | null; iconFile: File | null; screenshotFiles: File[];
};
export type PublicationQuote = { cycles: CycleEstimate; bytes: number; coverageEndsAt: string; warnings: string[]; opaque: unknown };
export interface MarketplaceClient {
  initialize(): Promise<Session>;
  configure(input: { canisterId: string; host: string }): Promise<Session>;
  connect(): Promise<Session>;
  catalog(input: { tier: AppTier; window: RankingWindow; search: string; cursor?: string }): Promise<Page<AppListing>>;
  detail(appId: string): Promise<AppDetail>;
  library(cursor?: string): Promise<Page<LibraryApp>>;
  publisherApps(cursor?: string): Promise<Page<PublishedApp>>;
  earnings(): Promise<Earnings>;
  createReferralCode(): Promise<string>;
  quotePurchase(input: { appIds: string[]; token: PaymentToken; affiliateCode: string }): Promise<PurchaseQuote>;
  purchase(quote: PurchaseQuote): Promise<OperationResult>;
  operation(operationId: string): Promise<OperationResult>;
  recentOperations(): Promise<OperationResult[]>;
  resumeOperation(operationId: string): Promise<OperationResult>;
  install(appIds: string[]): Promise<{ message: string }>;
  rate(appId: string, stars: number, text: string): Promise<void>;
  quoteWithdrawal(input: { token: PaymentToken; amountAtoms: string; destination: string }): Promise<WithdrawalQuote>;
  withdraw(quote: WithdrawalQuote): Promise<OperationResult>;
  quotePublication(input: PublicationInput): Promise<PublicationQuote>;
  publish(input: PublicationInput, quote: PublicationQuote, progress: (percent: number) => void): Promise<{ message: string }>;
}
