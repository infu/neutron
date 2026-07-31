module {
    // One product-scale contract for every complete app inventory. The
    // compiler mirrors this exact value so excess targets fail before actor
    // construction; the backend repeats it at the journal boundary.
    public let MAX_APP_INSTANCES : Nat = 256;

    // One atomic commit may retire only this many app scopes. Larger removals
    // are split into successive deployments so every broker cleanup remains
    // bounded in the commit message.
    public let MAX_APP_REMOVALS_PER_COMMIT : Nat = 64;

    // Independent transaction-work bounds. These protect the atomic asset
    // promotion path and are not app-count limits.
    public let MAX_ASSET_COPIES_PER_COMMIT : Nat = 4_000;
    public let MAX_ASSET_CLEAR_PREFIXES_PER_COMMIT : Nat = 128;
};
