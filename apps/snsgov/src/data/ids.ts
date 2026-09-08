/** Well-known mainnet canister ids. */

/** NNS SNS-W: the registry of every deployed SNS. */
export const SNS_WASM_CANISTER_ID = "qaa6y-5yaaa-aaaaa-aaafa-cai";

/** NNS ICP ledger. An SNS's ICP treasury lives here. */
export const ICP_LEDGER_CANISTER_ID = "ryjl3-tyaaa-aaaaa-aaaba-cai";

/** DFINITY's SNS aggregator, used only as a read accelerator for the list view. */
export const SNS_AGGREGATOR_CANISTER_ID = "3r4gx-wqaaa-aaaaq-aaaia-cai";

/** ICP is fixed at 8 decimals; every other token must be read from its ledger. */
export const ICP_DECIMALS = 8;

/**
 * Durations in SNS parameters are Julian-calendar based, not round days.
 * A "month" is 365.25/12 days and a "year" is 365.25 days.
 */
export const SECONDS_PER_DAY = 86_400;
export const SECONDS_PER_JULIAN_MONTH = 2_629_800;
export const SECONDS_PER_JULIAN_YEAR = 31_557_600;
