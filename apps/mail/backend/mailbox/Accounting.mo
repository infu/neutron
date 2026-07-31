module {
    // Logical retained-byte quotas count the exact envelope plus a deliberately
    // conservative fixed allowance for the duplicated authenticated metadata,
    // map/order indexes, counters, and allocator bookkeeping kept by V1.
    // Tombstones and rate events have their own strict count bounds.
    public let INBOX_METADATA_BYTES : Nat = 512;
    public let OUTBOX_METADATA_BYTES : Nat = 1_024;

    public func inboxRetainedBytes(envelope : Blob) : Nat {
        envelope.size() + INBOX_METADATA_BYTES;
    };

    public func outboxRetainedBytes(envelope : Blob) : Nat {
        envelope.size() + OUTBOX_METADATA_BYTES;
    };
};
