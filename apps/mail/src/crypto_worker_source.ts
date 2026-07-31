// The Mail build replaces this module with the recursively bundled worker.
// Keeping a closed placeholder makes direct source/test execution fail closed
// instead of silently starting an incomplete key-bearing runtime.
export const MAIL_CRYPTO_WORKER_SOURCE = "";
