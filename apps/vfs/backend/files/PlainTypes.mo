module {
    public let MAX_PATH_BYTES : Nat = 1_024;
    // Plain backend paths omit their visible policy root. Combined with
    // `/Shared` or `/Workspace`, every user-visible path remains within the
    // common 240-Unicode-scalar Files contract.
    public let MAX_SHARED_RELATIVE_PATH_SCALARS : Nat = 233;
    public let MAX_WORKSPACE_RELATIVE_PATH_SCALARS : Nat = 230;
    public let MAX_NAME_BYTES : Nat = 400;
    public let MAX_MEDIA_TYPE_BYTES : Nat = 128;
    public let MAX_ETAG_BYTES : Nat = 64;
    public let MAX_REQUEST_ID_BYTES : Nat = 128;
    public let MAX_LIST_PAGE : Nat16 = 200;
    public let MAX_FILE_BYTES : Nat = 67_108_864;
    public let MAX_TOTAL_WORKSPACE_BYTES : Nat = 67_108_864;
    public let MAX_TOTAL_SHARED_BYTES : Nat = 67_108_864;
    public let MAX_SHARED_FILES : Nat = 256;
    public let MAX_PLAIN_NODES : Nat = 10_002;
    public let MAX_PLAIN_TERMINAL_RECEIPTS : Nat = 1_024;
    public let BLOCK_BYTES : Nat = 1_889_984;
    public let MAX_BLOCKS : Nat32 = 36;
    // Workspace: idle time since the last accepted or replayed block.
    // Shared: fixed maximum lifetime since local stage creation.
    public let PLAIN_STAGE_IDLE_NS : Nat64 = 3_300_000_000_000;
    // Shared also caps its absolute local deadline this far inside the exact
    // expiry returned by Certified Assets. This keeps an idempotently replayed
    // older Kernel stage safe as well as a freshly allocated stage.
    public let SHARED_STAGE_KERNEL_MARGIN_NS : Nat64 = 300_000_000_000;
    public let PLAIN_RECEIPT_RETENTION_NS : Nat64 =
        86_400_000_000_000;

    // `shared` is a Motoko keyword. The physical Candid tag is therefore
    // `shared_`; the resident maps it to the user-facing Shared root.
    public type Space = { #shared_; #workspace };
    public type ContentKind = { #text; #binary };
    public type Presentation = { #inline_text; #attachment };
    public type EntryKind = { #file; #folder };

    public type RejectionReason = {
        #not_ready;
        #invalid_request;
        #not_found;
        #not_file;
        #not_folder;
        #already_exists;
        #stale_revision;
        #stale_content;
        #cursor_stale;
        #conflict;
        #quota;
        #busy;
        #temporarily_unavailable;
        #incompatible;
        #corrupt_state;
    };

    public type Rejection = {
        reason : ?RejectionReason;
        retry_after_ns : ?Nat64;
    };

    public func reject(reason : RejectionReason) : Rejection {
        { reason = ?reason; retry_after_ns = null };
    };

    public type Entry = {
        node_id : Nat64;
        path : Text;
        name : Text;
        kind : ?EntryKind;
        content_kind : ?ContentKind;
        byte_length : ?Nat64;
        media_type : ?Text;
        etag_sha256 : ?Text;
        created_at_ns : Nat64;
        modified_at_ns : Nat64;
        revision : Nat64;
        relative_url : ?Text;
    };

    public type Cursor = {
        after : Text;
        revision : Nat64;
        parent_node_id : Nat64;
    };

    public type ListRequest = {
        space : ?Space;
        path : Text;
        cursor : ?Cursor;
        limit : Nat16;
    };

    public type ListOk = {
        revision : Nat64;
        entries : [Entry];
        total : Nat32;
        next_cursor : ?Cursor;
        has_more : Bool;
    };

    public type ListResponse = {
        outcome : ?{ #ok : ListOk; #rejected : Rejection };
    };

    public type StatRequest = {
        space : ?Space;
        path : Text;
    };

    public type StatResponse = {
        outcome : ?{ #ok : Entry; #rejected : Rejection };
    };

    public type ReadChunkRequest = {
        space : ?Space;
        path : Text;
        block_index : Nat32;
    };

    public type ReadChunkOk = {
        entry : Entry;
        block_index : Nat32;
        block_count : Nat32;
        body_bytes : Nat32;
    };

    public type ReadChunkResponse = {
        outcome : ?{ #ok : ReadChunkOk; #rejected : Rejection };
    };

    public type ReadChunkOutput = {
        value : ReadChunkResponse;
        body : Blob;
    };

    public type WriteBlockRequest = {
        request_id : Text;
        space : ?Space;
        path : Text;
        stage_id : ?Nat64;
        block_index : Nat32;
        block_count : Nat32;
        total_bytes : Nat64;
        content_kind : ?ContentKind;
        media_type : Text;
        etag_sha256 : Text;
        presentation : ?Presentation;
        expected_node_id : ?Nat64;
        expected_revision : ?Nat64;
        if_match : ?Text;
        if_none_match : Bool;
        create_parents : Bool;
        final : Bool;
        safe_name : ?Text;
        begin_nonce : ?Blob;
        commit_nonce : ?Blob;
        delete_nonce : ?Blob;
        move_source : ?WriteMoveSource;
        body_bytes : Nat32;
        body : Blob;
    };

    public type WriteMoveSource = {
        path : Text;
        expected_node_id : Nat64;
        expected_revision : Nat64;
        if_match : ?Text;
    };

    public type WriteBlockOk = {
        stage_id : ?Nat64;
        committed : Bool;
        entry : ?Entry;
    };

    public type WriteBlockResponse = {
        outcome : ?{ #ok : WriteBlockOk; #rejected : Rejection };
    };

    public type MkdirRequest = {
        request_id : Text;
        space : ?Space;
        path : Text;
        recursive : Bool;
    };

    public type MoveRequest = {
        request_id : Text;
        space : ?Space;
        from : Text;
        to : Text;
        overwrite : Bool;
        expected_node_id : Nat64;
        expected_revision : Nat64;
        if_match : ?Text;
    };

    public type RemoveRequest = {
        request_id : Text;
        space : ?Space;
        path : Text;
        recursive : Bool;
        expected_node_id : Nat64;
        expected_revision : Nat64;
        if_match : ?Text;
        delete_nonce : ?Blob;
    };

    public type AbortRequest = {
        request_id : Text;
        space : ?Space;
        // Null safely resolves the caller's exact active stage by request_id
        // and space when a first-block receipt (and therefore its stage ID)
        // was lost.
        stage_id : ?Nat64;
    };

    public type CleanupRequest = {
        request_id : Text;
        limit : Nat8;
    };

    public type MutationOk = {
        path : Text;
        revision : Nat64;
        changed : Nat32;
    };

    public type MutationResponse = {
        outcome : ?{ #ok : MutationOk; #rejected : Rejection };
    };
};
