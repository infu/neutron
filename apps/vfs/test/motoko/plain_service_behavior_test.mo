import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Char "mo:core/Char";
import Map "mo:core/Map";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Sha256 "mo:sha2/Sha256";
import Text "mo:core/Text";
import Capabilities "mo:neutron-capabilities";
import PlainService "../../backend/files/PlainService";
import Types "../../backend/files/PlainTypes";
import Memory "../../backend/memory/files/v2";
import CertifiedAssetsMock "CertifiedAssetsMock";
import Fixtures "Fixtures";

func codePointText(codePoints : [Nat32]) : Text {
    Text.fromArray(
        Array.map<Nat32, Char>(codePoints, Char.fromNat32)
    );
};

func fail<T>() : T {
    assert false;
    loop {};
};

func writeOk(response : Types.WriteBlockResponse) : Types.WriteBlockOk {
    switch (response.outcome) {
        case (?#ok(value)) value;
        case (_) fail();
    };
};

func listOk(response : Types.ListResponse) : Types.ListOk {
    switch (response.outcome) {
        case (?#ok(value)) value;
        case (_) fail();
    };
};

func statOk(response : Types.StatResponse) : Types.Entry {
    switch (response.outcome) {
        case (?#ok(value)) value;
        case (_) fail();
    };
};

func assertWriteReason(
    response : Types.WriteBlockResponse,
    expected : Types.RejectionReason,
) {
    switch (response.outcome) {
        case (?#rejected({ reason = ?actual })) assert (actual == expected);
        case (_) assert false;
    };
};

func assertListReason(
    response : Types.ListResponse,
    expected : Types.RejectionReason,
) {
    switch (response.outcome) {
        case (?#rejected({ reason = ?actual })) assert (actual == expected);
        case (_) assert false;
    };
};

func assertStatReason(
    response : Types.StatResponse,
    expected : Types.RejectionReason,
) {
    switch (response.outcome) {
        case (?#rejected({ reason = ?actual })) assert (actual == expected);
        case (_) assert false;
    };
};

func assertMutationReason(
    response : Types.MutationResponse,
    expected : Types.RejectionReason,
) {
    switch (response.outcome) {
        case (?#rejected({ reason = ?actual })) assert (actual == expected);
        case (_) assert false;
    };
};

func workspaceRequest(
    requestId : Text,
    path : Text,
    stageId : ?Nat64,
    blockIndex : Nat32,
    blockCount : Nat32,
    totalBytes : Nat,
    body : Blob,
    etag : Text,
    createParents : Bool,
) : Types.WriteBlockRequest {
    {
        request_id = requestId;
        space = ?#workspace;
        path;
        stage_id = stageId;
        block_index = blockIndex;
        block_count = blockCount;
        total_bytes = Nat64.fromNat(totalBytes);
        content_kind = ?#binary;
        media_type = "application/octet-stream";
        etag_sha256 = etag;
        presentation = null;
        expected_node_id = null;
        expected_revision = null;
        if_match = null;
        if_none_match = true;
        create_parents = createParents;
        final = blockIndex + 1 == blockCount;
        safe_name = null;
        begin_nonce = null;
        commit_nonce = null;
        delete_nonce = null;
        move_source = null;
        body_bytes = Nat32.fromNat(body.size());
        body;
    };
};

// Keep this explicit vector synchronized with the resident classifier in
// storage_roots.ts and PlainService.inlineTextSuffixes.
let inlineTextExtensions : [Text] = [
    "bash",
    "bat",
    "c",
    "cc",
    "cfg",
    "cjs",
    "cmd",
    "conf",
    "config",
    "cpp",
    "css",
    "csv",
    "cts",
    "cxx",
    "diff",
    "env",
    "fish",
    "go",
    "gql",
    "graphql",
    "h",
    "hpp",
    "htm",
    "html",
    "ini",
    "java",
    "js",
    "json",
    "json5",
    "jsonl",
    "jsx",
    "log",
    "lua",
    "md",
    "markdown",
    "mjs",
    "mts",
    "ndjson",
    "patch",
    "php",
    "properties",
    "proto",
    "ps1",
    "py",
    "r",
    "rb",
    "rs",
    "scss",
    "sh",
    "shell",
    "source",
    "sql",
    "svelte",
    "swift",
    "text",
    "toml",
    "ts",
    "tsv",
    "tsx",
    "txt",
    "vue",
    "xml",
    "yaml",
    "yml",
    "zsh",
];

func testSharedPresentation(name : Text) : Types.Presentation {
    let lower = Text.toLower(name);
    for (extension in inlineTextExtensions.vals()) {
        let suffix = "." # extension;
        if (
            lower.size() >= suffix.size() and
            Text.endsWith(lower, #text suffix)
        ) return #inline_text;
    };
    #attachment;
};

func sharedRequest(
    requestId : Text,
    path : Text,
    stageId : ?Nat64,
    blockIndex : Nat32,
    blockCount : Nat32,
    totalBytes : Nat,
    body : Blob,
    etag : Text,
    ifMatch : ?Text,
    safeName : Text,
) : Types.WriteBlockRequest {
    let first = blockIndex == 0 and stageId == null;
    let final = blockIndex + 1 == blockCount;
    let presentation = testSharedPresentation(safeName);
    {
        request_id = requestId;
        space = ?#shared_;
        path;
        stage_id = stageId;
        block_index = blockIndex;
        block_count = blockCount;
        total_bytes = Nat64.fromNat(totalBytes);
        content_kind = ?(
            switch (presentation) {
                case (#inline_text) #text;
                case (#attachment) #binary;
            }
        );
        media_type = "application/octet-stream";
        etag_sha256 = etag;
        presentation = ?presentation;
        expected_node_id = null;
        expected_revision = null;
        if_match = ifMatch;
        if_none_match = ifMatch == null;
        create_parents = true;
        final;
        safe_name = ?safeName;
        begin_nonce = if (first) ?Fixtures.zeros(16) else null;
        commit_nonce = if (final) ?Fixtures.zeros(16) else null;
        delete_nonce = if (final) ?Fixtures.zeros(16) else null;
        move_source = null;
        body_bytes = Nat32.fromNat(body.size());
        body;
    };
};

func shareScope() : Capabilities.ScopeInfo {
    {
        installation_generation = 1;
        store_authority_epoch = 1;
        collections = [{
            id = "shares";
            kind = #publication;
            authority_epoch = 1;
            generation = 7;
            serving = #enabled;
            writes = #enabled;
            manifest_limits = Fixtures.zeroLimits();
            effective_limits = Fixtures.zeroLimits();
        }];
    };
};

func publicationId(value : Nat8) : Blob {
    Blob.fromArray(
        Array.tabulate<Nat8>(32, func(_) { value })
    );
};

func target(
    _generation : Nat64,
    idByte : Nat8,
    filename : Text,
) : Capabilities.Target {
    {
        collection = "shares";
        collection_generation = 7;
        locator = #publication({
            publication_id = publicationId(idByte);
            filename;
        });
    };
};

func geometry(lengths : [Nat], expectedBytes : Nat) :
    Capabilities.StageGeometry {
    {
        block_bytes = Types.BLOCK_BYTES;
        block_count = Nat32.fromNat(lengths.size());
        expected_bytes = expectedBytes;
    };
};

func usage(liveEntries : Nat, committedBytes : Nat) :
    Capabilities.Usage {
    let zero = Fixtures.zeroUsage();
    {
        zero with
        current = {
            zero.current with
            live_entries = liveEntries;
            occupied_entry_slots = liveEntries;
            committed_body_bytes = committedBytes;
            allocated_body_bytes = committedBytes;
        };
    };
};

func configureBegin(
    mock : CertifiedAssetsMock.Mock,
    kernelStageId : Nat64,
    publicationTarget : Capabilities.Target,
    lengths : [Nat],
    expectedBytes : Nat,
) {
    mock.scope_info_result := #ok(shareScope());
    mock.begin_stage_result := #ok({
        stage_id = kernelStageId;
        identity = {
            collection = "shares";
            collection_generation = 7;
            computed_target = ?publicationTarget;
        };
        geometry = geometry(lengths, expectedBytes);
        expires_at_ns =
            Types.PLAIN_STAGE_IDLE_NS +
            Types.SHARED_STAGE_KERNEL_MARGIN_NS +
            10_000;
    });
};

func configurePut(
    mock : CertifiedAssetsMock.Mock,
    kernelStageId : Nat64,
    blockIndex : Nat32,
    publicationTarget : Capabilities.Target,
    body : Blob,
    complete : Bool,
    rawSha256 : Blob,
) {
    // Mirror the generic Certified Assets contract: the whole-body digest is
    // absent while staging and present on the completing chunk.
    mock.put_chunk_result := #ok({
        stage_id = kernelStageId;
        index = blockIndex;
        block_sha256 = Sha256.fromBlob(#sha256, body);
        accepted = #new;
        complete;
        raw_sha256 = if (complete) ?rawSha256 else null;
        computed_target = ?publicationTarget;
    });
};

func putReceipt(
    publicationTarget : Capabilities.Target,
    revision : Nat64,
    bodies : [Blob],
) : Capabilities.CommitBatchResult {
    let lengths = Array.map<Blob, Nat>(
        bodies,
        func(body) { body.size() },
    );
    let hashes = Array.map<Blob, Blob>(
        bodies,
        func(body) { Sha256.fromBlob(#sha256, body) },
    );
    var bodyBytes = 0;
    for (length in lengths.vals()) bodyBytes += length;
    #ok({
        operations = [#put({
            request_index = 0;
            lifecycle = {
                committed = {
                    target = publicationTarget;
                    kernel_revision = revision;
                    content_tag = certifiedContentTag(
                        bodyBytes,
                        lengths,
                        hashes,
                    );
                    body_bytes = bodyBytes;
                    geometry = geometry(lengths, bodyBytes);
                    block_hashes = hashes;
                };
            };
        })];
    });
};

func certifiedContentTag(
    totalBytes : Nat,
    lengths : [Nat],
    hashes : [Blob],
) : Blob {
    assert (lengths.size() == hashes.size());
    let digest = Sha256.Digest(#sha256);
    digest.writeBlob(
        Text.encodeUtf8("neutron-certified-asset-v2\00")
    );
    digest.writeBlob(u64be(Nat64.fromNat(totalBytes)));
    digest.writeBlob(u32be(Nat32.fromNat(lengths.size())));
    var index = 0;
    while (index < lengths.size()) {
        digest.writeBlob(u32be(Nat32.fromNat(lengths[index])));
        digest.writeBlob(hashes[index]);
        index += 1;
    };
    digest.sum();
};

func u32be(value : Nat32) : Blob {
    Blob.fromArray([
        Nat8.fromNat(Nat32.toNat(value >> 24) % 256),
        Nat8.fromNat(Nat32.toNat(value >> 16) % 256),
        Nat8.fromNat(Nat32.toNat(value >> 8) % 256),
        Nat8.fromNat(Nat32.toNat(value) % 256),
    ]);
};

func u64be(value : Nat64) : Blob {
    Blob.fromArray(
        Array.tabulate<Nat8>(
            8,
            func(index) {
                Nat8.fromNat(
                    Nat64.toNat(
                        value >> Nat64.fromNat((7 - index) * 8)
                    ) % 256
                );
            },
        )
    );
};

func deleteReceipt(
    publicationTarget : Capabilities.Target,
    revision : Nat64,
    priorContentTag : Blob,
) : Capabilities.CommitBatchResult {
    #ok({
        operations = [#delete({
            request_index = 0;
            identity = {
                target = publicationTarget;
                kernel_revision = revision;
                prior_content_tag = priorContentTag;
            };
        })];
    });
};

let zeroEtag =
    "0000000000000000000000000000000000000000000000000000000000000000";
let oneEtag =
    "1111111111111111111111111111111111111111111111111111111111111111";
let twoEtag =
    "2222222222222222222222222222222222222222222222222222222222222222";

let mem = Memory.init();
let mock = CertifiedAssetsMock.Mock(Fixtures.zeroUsage());
var clock : Nat64 = 100;
let service = PlainService.Service(
    mem,
    mock.handle(),
    func() {
        clock += 1;
        clock;
    },
);

// create_parents is a real backend contract: both nested folders and the file
// are committed by one write, and the plaintext body remains backend-readable.
let nestedBody : Blob = "nested";
let nestedRequest = workspaceRequest(
    "workspace-nested",
    "/nested/dir/file.bin",
    null,
    0,
    1,
    nestedBody.size(),
    nestedBody,
    zeroEtag,
    true,
);
let nested = writeOk(
    service.writeBlock(nestedRequest)
);
assert nested.committed;
let nestedReplay = writeOk(service.writeBlock(nestedRequest));
assert (nestedReplay.entry == nested.entry);
assertWriteReason(
    service.writeBlock({
        nestedRequest with
        body = "change";
    }),
    #conflict,
);
assert (statOk(service.stat({ space = ?#workspace; path = "/nested" })).kind == ?#folder);
assert (
    statOk(
        service.stat({
            space = ?#workspace;
            path = "/nested/dir/file.bin";
        })
    ).byte_length == ?Nat64.fromNat(nestedBody.size())
);
let nestedRead = service.readChunk({
    space = ?#workspace;
    path = "/nested/dir/file.bin";
    block_index = 0;
});
assert (nestedRead.body == nestedBody);

// A drag move is conditional on the entry the user actually saw. A stale
// revision or content tag cannot move a replacement that later occupied the
// same source path.
let moveSource = statOk(
    service.stat({
        space = ?#workspace;
        path = "/nested/dir/file.bin";
    })
);
assertMutationReason(
    service.move({
        request_id = "workspace-move-stale-revision";
        space = ?#workspace;
        from = "/nested/dir/file.bin";
        to = "/nested/dir/moved.bin";
        overwrite = false;
        expected_node_id = moveSource.node_id;
        expected_revision = moveSource.revision + 1;
        if_match = ?zeroEtag;
    }),
    #stale_revision,
);
assertMutationReason(
    service.move({
        request_id = "workspace-move-stale-content";
        space = ?#workspace;
        from = "/nested/dir/file.bin";
        to = "/nested/dir/moved.bin";
        overwrite = false;
        expected_node_id = moveSource.node_id;
        expected_revision = moveSource.revision;
        if_match = ?oneEtag;
    }),
    #stale_content,
);
let workspaceMoveRequest : Types.MoveRequest = {
    request_id = "workspace-move";
    space = ?#workspace;
    from = "/nested/dir/file.bin";
    to = "/nested/dir/moved.bin";
    overwrite = false;
    expected_node_id = moveSource.node_id;
    expected_revision = moveSource.revision;
    if_match = ?zeroEtag;
};
switch (service.move(workspaceMoveRequest).outcome) {
    case (?#ok(_)) {};
    case (_) assert false;
};
assertStatReason(
    service.stat({
        space = ?#workspace;
        path = "/nested/dir/file.bin";
    }),
    #not_found,
);
assert (
    statOk(
        service.stat({
            space = ?#workspace;
            path = "/nested/dir/moved.bin";
        })
    ).byte_length == ?Nat64.fromNat(nestedBody.size())
);
let movedRevision = statOk(
    service.stat({
        space = ?#workspace;
        path = "/nested/dir/moved.bin";
    })
).revision;
switch (service.move(workspaceMoveRequest).outcome) {
    case (?#ok({ changed = 1 })) {};
    case (_) assert false;
};
assert (
    statOk(
        service.stat({
            space = ?#workspace;
            path = "/nested/dir/moved.bin";
        })
    ).revision == movedRevision
);
assertMutationReason(
    service.move({
        workspaceMoveRequest with
        to = "/nested/dir/else.bin";
    }),
    #conflict,
);

// The ordered child index paginates deterministically and invalidates a cursor
// as soon as the folder revision changes.
for ((name, requestId) in [
    ("alpha.bin", "workspace-alpha"),
    ("beta.bin", "workspace-beta"),
    ("gamma.bin", "workspace-gamma"),
].vals()) {
    ignore writeOk(
        service.writeBlock(
            workspaceRequest(
                requestId,
                "/" # name,
                null,
                0,
                1,
                1,
                "x",
                zeroEtag,
                false,
            )
        )
    );
};
let firstPage = listOk(
    service.list({
        space = ?#workspace;
        path = "/";
        cursor = null;
        limit = 2;
    })
);
assert (firstPage.entries.size() == 2);
assert firstPage.has_more;
let ?firstCursor = firstPage.next_cursor else fail();
assertListReason(
    service.list({
        space = ?#workspace;
        path = "/";
        cursor = ?{
            firstCursor with
            parent_node_id = firstCursor.parent_node_id + 1;
        };
        limit = 2;
    }),
    #cursor_stale,
);
let secondPage = listOk(
    service.list({
        space = ?#workspace;
        path = "/";
        cursor = ?firstCursor;
        limit = 2;
    })
);
assert (secondPage.entries.size() == 2);
assert (not secondPage.has_more);
ignore writeOk(
    service.writeBlock(
        workspaceRequest(
            "workspace-delta",
            "/delta.bin",
            null,
            0,
            1,
            1,
            "d",
            zeroEtag,
            false,
        )
    )
);
assertListReason(
    service.list({
        space = ?#workspace;
        path = "/";
        cursor = ?firstCursor;
        limit = 2;
    }),
    #cursor_stale,
);

// A partial Workspace stage is fully retired by abort.
let fullBlock = Blob.fromArray(
    Array.tabulate<Nat8>(Types.BLOCK_BYTES, func(_) { 7 })
);
let partial = writeOk(
    service.writeBlock(
        workspaceRequest(
            "workspace-abort",
            "/pending.bin",
            null,
            0,
            2,
            Types.BLOCK_BYTES + 1,
            fullBlock,
            oneEtag,
            false,
        )
    )
);
let ?workspaceStageId = partial.stage_id else fail();
assert (mem.staged_workspace_bytes == Types.BLOCK_BYTES);
let workspaceAbortRequest : Types.AbortRequest = {
    request_id = "workspace-abort";
    space = ?#workspace;
    stage_id = ?workspaceStageId;
};
switch (service.abort(workspaceAbortRequest).outcome) {
    case (?#ok(_)) {};
    case (_) assert false;
};
assert (mem.staged_workspace_bytes == 0);
assert (Map.size(mem.plain_stages) == 0);
assertStatReason(
    service.stat({ space = ?#workspace; path = "/pending.bin" }),
    #not_found,
);
switch (service.abort(workspaceAbortRequest).outcome) {
    case (?#ok(_)) {};
    case (_) assert false;
};
assertMutationReason(
    service.abort({
        workspaceAbortRequest with
        stage_id = ?(workspaceStageId + 1);
    }),
    #conflict,
);

// create_parents plans are invisible until commit. Repeated explicit aborts
// and expiry cleanup retire only staging bytes; neither path can accumulate
// durable folder nodes.
let deferredMem = Memory.init();
let deferredMock = CertifiedAssetsMock.Mock(Fixtures.zeroUsage());
var deferredNow : Nat64 = 1_000;
let deferredService = PlainService.Service(
    deferredMem,
    deferredMock.handle(),
    func() { deferredNow },
);
let deferredRootNodes = Map.size(deferredMem.plain_nodes);
func beginDeferred(requestId : Text, path : Text) : Nat64 {
    let partial = writeOk(
        deferredService.writeBlock(
            workspaceRequest(
                requestId,
                path,
                null,
                0,
                2,
                Types.BLOCK_BYTES + 1,
                fullBlock,
                zeroEtag,
                true,
            )
        )
    );
    let ?stageId = partial.stage_id else fail();
    assert (not partial.committed);
    assert (Map.size(deferredMem.plain_nodes) == deferredRootNodes);
    stageId;
};
func abortDeferred(requestId : Text, stageId : Nat64) {
    switch (
        deferredService.abort({
            request_id = requestId;
            space = ?#workspace;
            stage_id = ?stageId;
        }).outcome
    ) {
        case (?#ok(_)) {};
        case (_) assert false;
    };
    assert (Map.size(deferredMem.plain_nodes) == deferredRootNodes);
};
let deferredAbortOne = beginDeferred(
    "deferred-abort-one",
    "/aborted/one/file.bin",
);
assertStatReason(
    deferredService.stat({
        space = ?#workspace;
        path = "/aborted";
    }),
    #not_found,
);
abortDeferred("deferred-abort-one", deferredAbortOne);
let deferredAbortTwo = beginDeferred(
    "deferred-abort-two",
    "/aborted/two/file.bin",
);
abortDeferred("deferred-abort-two", deferredAbortTwo);

func expireDeferred(
    requestId : Text,
    cleanupId : Text,
    path : Text,
) {
    let stageId = beginDeferred(requestId, path);
    let ?stage = Map.get(
        deferredMem.plain_stages,
        Nat64.compare,
        stageId,
    ) else fail();
    deferredNow :=
        stage.modified_at_ns + Types.PLAIN_STAGE_IDLE_NS;
    switch (
        deferredService.cleanup({
            request_id = cleanupId;
            limit = 3;
        }).outcome
    ) {
        case (?#ok({ changed = 1 })) {};
        case (_) assert false;
    };
    assert (Map.size(deferredMem.plain_nodes) == deferredRootNodes);
};
expireDeferred(
    "deferred-expire-one",
    "cleanup-deferred-expire-one",
    "/expired/one/file.bin",
);
expireDeferred(
    "deferred-expire-two",
    "cleanup-deferred-expire-two",
    "/expired/two/file.bin",
);
assertStatReason(
    deferredService.stat({
        space = ?#workspace;
        path = "/expired";
    }),
    #not_found,
);

// Overlapping stages may reserve the same missing prefix conservatively.
// A concurrent mkdir can materialize a sibling, but a move cannot occupy an
// ancestor claimed by either stage. Each final commit resolves the current
// shape and attaches its file to the effective (possibly newly-created) parent.
let siblingMem = Memory.init();
let siblingMock = CertifiedAssetsMock.Mock(Fixtures.zeroUsage());
let siblingService = PlainService.Service(
    siblingMem,
    siblingMock.handle(),
    func() { 2_000 },
);
let siblingLeft = writeOk(
    siblingService.writeBlock(
        workspaceRequest(
            "deferred-sibling-left",
            "/team/left/file.bin",
            null,
            0,
            2,
            Types.BLOCK_BYTES + 1,
            fullBlock,
            zeroEtag,
            true,
        )
    )
);
let siblingRight = writeOk(
    siblingService.writeBlock(
        workspaceRequest(
            "deferred-sibling-right",
            "/team/right/file.bin",
            null,
            0,
            2,
            Types.BLOCK_BYTES + 1,
            fullBlock,
            oneEtag,
            true,
        )
    )
);
let ?siblingLeftStageId = siblingLeft.stage_id else fail();
let ?siblingRightStageId = siblingRight.stage_id else fail();
assert (Map.size(siblingMem.plain_nodes) == 2);
switch (
    siblingService.mkdir({
        request_id = "deferred-sibling-mkdir";
        space = ?#workspace;
        path = "/team/manual";
        recursive = true;
    }).outcome
) {
    case (?#ok({ changed = 2 })) {};
    case (_) assert false;
};
let manualFolder = statOk(
    siblingService.stat({
        space = ?#workspace;
        path = "/team/manual";
    })
);
assertMutationReason(
    siblingService.move({
        request_id = "deferred-ancestor-move";
        space = ?#workspace;
        from = "/team/manual";
        to = "/team/left";
        overwrite = false;
        expected_node_id = manualFolder.node_id;
        expected_revision = manualFolder.revision;
        if_match = null;
    }),
    #busy,
);
assertStatReason(
    siblingService.stat({
        space = ?#workspace;
        path = "/team/left";
    }),
    #not_found,
);
let siblingLeftCommitted = writeOk(
    siblingService.writeBlock(
        workspaceRequest(
            "deferred-sibling-left",
            "/team/left/file.bin",
            ?siblingLeftStageId,
            1,
            2,
            Types.BLOCK_BYTES + 1,
            "l",
            zeroEtag,
            true,
        )
    )
);
assert siblingLeftCommitted.committed;
assertStatReason(
    siblingService.stat({
        space = ?#workspace;
        path = "/team/right";
    }),
    #not_found,
);
let siblingRightCommitted = writeOk(
    siblingService.writeBlock(
        workspaceRequest(
            "deferred-sibling-right",
            "/team/right/file.bin",
            ?siblingRightStageId,
            1,
            2,
            Types.BLOCK_BYTES + 1,
            "r",
            oneEtag,
            true,
        )
    )
);
assert siblingRightCommitted.committed;
assert (
    statOk(
        siblingService.stat({
            space = ?#workspace;
            path = "/team/left/file.bin";
        })
    ).byte_length == ?Nat64.fromNat(Types.BLOCK_BYTES + 1)
);
assert (
    statOk(
        siblingService.stat({
            space = ?#workspace;
            path = "/team/right/file.bin";
        })
    ).byte_length == ?Nat64.fromNat(Types.BLOCK_BYTES + 1)
);
assert (
    statOk(
        siblingService.stat({
            space = ?#workspace;
            path = "/team/manual";
        })
    ).kind == ?#folder
);

// Upgrade compatibility: a stage persisted by the pre-deferral writer has
// already-visible parents and stores the final direct parent in parent_id.
// Simulate that snapshot exactly; both continuation and abort remain valid.
let legacyParentMem = Memory.init();
let legacyParentMock = CertifiedAssetsMock.Mock(Fixtures.zeroUsage());
let legacyParentService = PlainService.Service(
    legacyParentMem,
    legacyParentMock.handle(),
    func() { 2_250 },
);
func simulateLegacyMaterializedParent(
    requestId : Text,
    folderPath : Text,
    filePath : Text,
) : Nat64 {
    let partial = writeOk(
        legacyParentService.writeBlock(
            workspaceRequest(
                requestId,
                filePath,
                null,
                0,
                2,
                Types.BLOCK_BYTES + 1,
                fullBlock,
                zeroEtag,
                true,
            )
        )
    );
    let ?stageId = partial.stage_id else fail();
    switch (
        legacyParentService.mkdir({
            request_id = requestId # "-old-materialize";
            space = ?#workspace;
            path = folderPath;
            recursive = true;
        }).outcome
    ) {
        case (?#ok(_)) {};
        case (_) assert false;
    };
    let parent = statOk(
        legacyParentService.stat({
            space = ?#workspace;
            path = folderPath;
        })
    );
    let ?stage = Map.get(
        legacyParentMem.plain_stages,
        Nat64.compare,
        stageId,
    ) else fail();
    Map.add(
        legacyParentMem.plain_stages,
        Nat64.compare,
        stageId,
        { stage with parent_id = parent.node_id },
    );
    stageId;
};
let legacyCommitStage = simulateLegacyMaterializedParent(
    "legacy-parent-commit",
    "/legacy/commit",
    "/legacy/commit/file.bin",
);
assert (
    writeOk(
        legacyParentService.writeBlock(
            workspaceRequest(
                "legacy-parent-commit",
                "/legacy/commit/file.bin",
                ?legacyCommitStage,
                1,
                2,
                Types.BLOCK_BYTES + 1,
                "c",
                zeroEtag,
                true,
            )
        )
    ).committed
);
let legacyAbortStage = simulateLegacyMaterializedParent(
    "legacy-parent-abort",
    "/legacy/abort",
    "/legacy/abort/file.bin",
);
switch (
    legacyParentService.abort({
        request_id = "legacy-parent-abort";
        space = ?#workspace;
        stage_id = ?legacyAbortStage;
    }).outcome
) {
    case (?#ok(_)) {};
    case (_) assert false;
};
assert (
    statOk(
        legacyParentService.stat({
            space = ?#workspace;
            path = "/legacy/abort";
        })
    ).kind == ?#folder
);
assertStatReason(
    legacyParentService.stat({
        space = ?#workspace;
        path = "/legacy/abort/file.bin";
    }),
    #not_found,
);

// Fixed reservations are exact at both the durable-node and Nat64 ID bounds.
// Two stages deliberately reserve the same missing "bound" prefix; the second
// admission reaches MAX_PLAIN_NODES exactly. Unrelated work cannot consume the
// final slot/IDs, while each stage can consume its own reservation at commit.
let nodeBoundMem = Memory.init();
let ?nodeBoundRoot = Map.get(
    nodeBoundMem.plain_nodes,
    Nat64.compare,
    nodeBoundMem.workspace_root_id,
) else fail();
let fillerId : Nat64 = 3;
let fillerName = "quota-fill";
let fillerNode : Memory.PlainNode = {
    node_id = fillerId;
    space = #workspace;
    parent_id = nodeBoundRoot.node_id;
    name = fillerName;
    kind = #folder;
    file = null;
    created_at_ns = 0;
    modified_at_ns = 0;
    revision = 1;
    children_revision = 1;
    direct_child_count = Nat32.fromNat(
        Types.MAX_PLAIN_NODES - 9
    );
};
Map.add(
    nodeBoundMem.plain_nodes,
    Nat64.compare,
    fillerId,
    fillerNode,
);
Map.add(
    nodeBoundMem.plain_children,
    Text.compare,
    "w\00" # Nat64.toText(nodeBoundRoot.node_id) # "\00" #
        fillerName,
    fillerId,
);
let nodeBoundRevisedRoot : Memory.PlainNode = {
    nodeBoundRoot with
    revision = 1;
    children_revision = 1;
    direct_child_count = 1;
};
Map.add(
    nodeBoundMem.plain_nodes,
    Nat64.compare,
    nodeBoundRoot.node_id,
    nodeBoundRevisedRoot,
);
var fillerNodeId : Nat64 = 4;
while (
    Map.size(nodeBoundMem.plain_nodes) <
        Types.MAX_PLAIN_NODES - 6
) {
    let name = "n" # Nat64.toText(fillerNodeId);
    let fillerChild : Memory.PlainNode = {
        node_id = fillerNodeId;
        space = #workspace;
        parent_id = fillerId;
        name;
        kind = #folder;
        file = null;
        created_at_ns = 0;
        modified_at_ns = 0;
        revision = 1;
        children_revision = 0;
        direct_child_count = 0;
    };
    Map.add(
        nodeBoundMem.plain_nodes,
        Nat64.compare,
        fillerNodeId,
        fillerChild,
    );
    Map.add(
        nodeBoundMem.plain_children,
        Text.compare,
        "w\00" # Nat64.toText(fillerId) # "\00" # name,
        fillerNodeId,
    );
    fillerNodeId += 1;
};
assert (
    Map.size(nodeBoundMem.plain_nodes) ==
        Types.MAX_PLAIN_NODES - 6
);
nodeBoundMem.next_plain_node_id := Nat64.maxValue - 6;
let nodeBoundMock = CertifiedAssetsMock.Mock(Fixtures.zeroUsage());
let nodeBoundService = PlainService.Service(
    nodeBoundMem,
    nodeBoundMock.handle(),
    func() { 2_400 },
);
let nodeBoundLeft = writeOk(
    nodeBoundService.writeBlock(
        workspaceRequest(
            "node-bound-left",
            "/bound/left/file.bin",
            null,
            0,
            2,
            Types.BLOCK_BYTES + 1,
            fullBlock,
            zeroEtag,
            true,
        )
    )
);
let nodeBoundRight = writeOk(
    nodeBoundService.writeBlock(
        workspaceRequest(
            "node-bound-right",
            "/bound/right/file.bin",
            null,
            0,
            2,
            Types.BLOCK_BYTES + 1,
            fullBlock,
            oneEtag,
            true,
        )
    )
);
let ?nodeBoundLeftStage = nodeBoundLeft.stage_id else fail();
let ?nodeBoundRightStage = nodeBoundRight.stage_id else fail();
let nodeBoundBeforeReject = Map.size(nodeBoundMem.plain_nodes);
let nodeBoundIdBeforeReject = nodeBoundMem.next_plain_node_id;
assertMutationReason(
    nodeBoundService.mkdir({
        request_id = "node-bound-plus-one-mkdir";
        space = ?#workspace;
        path = "/extra";
        recursive = false;
    }),
    #quota,
);
assertWriteReason(
    nodeBoundService.writeBlock(
        workspaceRequest(
            "node-bound-plus-one-write",
            "/extra.bin",
            null,
            0,
            1,
            1,
            "x",
            twoEtag,
            false,
        )
    ),
    #quota,
);
assert (Map.size(nodeBoundMem.plain_nodes) == nodeBoundBeforeReject);
assert (nodeBoundMem.next_plain_node_id == nodeBoundIdBeforeReject);
assert (
    writeOk(
        nodeBoundService.writeBlock(
            workspaceRequest(
                "node-bound-left",
                "/bound/left/file.bin",
                ?nodeBoundLeftStage,
                1,
                2,
                Types.BLOCK_BYTES + 1,
                "l",
                zeroEtag,
                true,
            )
        )
    ).committed
);
assert (
    Map.size(nodeBoundMem.plain_nodes) +
        3 ==
        Types.MAX_PLAIN_NODES
);
assert (
    writeOk(
        nodeBoundService.writeBlock(
            workspaceRequest(
                "node-bound-right",
                "/bound/right/file.bin",
                ?nodeBoundRightStage,
                1,
                2,
                Types.BLOCK_BYTES + 1,
                "r",
                oneEtag,
                true,
            )
        )
    ).committed
);
assert (
    statOk(
        nodeBoundService.stat({
            space = ?#workspace;
            path = "/bound/left/file.bin";
        })
    ).kind == ?#file
);
assert (
    statOk(
        nodeBoundService.stat({
            space = ?#workspace;
            path = "/bound/right/file.bin";
        })
    ).kind == ?#file
);

// Shared republish may move a root child beneath parents that do not exist yet.
// Materializing the new branch revises the root before the source is removed,
// so the commit must reload that parent instead of overwriting it with the
// pre-materialization child-count snapshot.
let republishMem = Memory.init();
let republishMock = CertifiedAssetsMock.Mock(Fixtures.zeroUsage());
let republishService = PlainService.Service(
    republishMem,
    republishMock.handle(),
    func() { 2_500 },
);
let republishBody : Blob = "republish";
let republishSourceTarget = target(70, 70, "source.bin");
configureBegin(
    republishMock,
    70,
    republishSourceTarget,
    [republishBody.size()],
    republishBody.size(),
);
configurePut(
    republishMock,
    70,
    0,
    republishSourceTarget,
    republishBody,
    true,
    publicationId(0),
);
republishMock.commit_batch_result := putReceipt(
    republishSourceTarget,
    1,
    [republishBody],
);
let republishSource = writeOk(
    republishService.writeBlock(
        sharedRequest(
            "republish-source",
            "/source.bin",
            null,
            0,
            1,
            republishBody.size(),
            republishBody,
            zeroEtag,
            null,
            "source.bin",
        )
    )
);
let ?republishSourceEntry = republishSource.entry else fail();
let republishDestinationTarget = target(71, 71, "source.bin");
configureBegin(
    republishMock,
    71,
    republishDestinationTarget,
    [republishBody.size()],
    republishBody.size(),
);
configurePut(
    republishMock,
    71,
    0,
    republishDestinationTarget,
    republishBody,
    true,
    publicationId(17),
);
republishMock.usage_result := #ok(usage(1, republishBody.size()));
let republishTag = certifiedContentTag(
    republishBody.size(),
    [republishBody.size()],
    [Sha256.fromBlob(#sha256, republishBody)],
);
republishMock.commit_batch_results := [
    putReceipt(republishDestinationTarget, 1, [republishBody]),
    deleteReceipt(republishSourceTarget, 2, republishTag),
];
republishMock.commit_batch_result_index := 0;
let republished = writeOk(
    republishService.writeBlock({
        sharedRequest(
            "republish-under-missing-parents",
            "/new/dir/source.bin",
            null,
            0,
            1,
            republishBody.size(),
            republishBody,
            oneEtag,
            null,
            "source.bin",
        ) with
        move_source = ?{
            path = "/source.bin";
            expected_node_id = republishSourceEntry.node_id;
            expected_revision = republishSourceEntry.revision;
            if_match = ?zeroEtag;
        };
    })
);
assert republished.committed;
assertStatReason(
    republishService.stat({
        space = ?#shared_;
        path = "/source.bin";
    }),
    #not_found,
);
assert (
    statOk(
        republishService.stat({
            space = ?#shared_;
            path = "/new/dir/source.bin";
        })
    ).node_id == republishSourceEntry.node_id
);
let republishRoot = listOk(
    republishService.list({
        space = ?#shared_;
        path = "/";
        cursor = null;
        limit = 10;
    })
);
assert (republishRoot.total == 1);
assert (republishRoot.entries.size() == 1);
assert (republishRoot.entries[0].name == "new");

// A failed Shared allocation does not expose pre-created parent folders.
let failedTarget = target(10, 10, "failed.txt");
configureBegin(mock, 40, failedTarget, [1], 1);
mock.begin_stage_result := #err(#busy);
let nodesBeforeFailedBegin = Map.size(mem.plain_nodes);
switch (
    service.writeBlock(
        sharedRequest(
            "shared-failed",
            "/failed/parents/failed.txt",
            null,
            0,
            1,
            1,
            "f",
            zeroEtag,
            null,
            "failed.txt",
        )
    ).outcome
) {
    case (?#rejected({ reason = ?#busy })) {};
    case (_) assert false;
};
assert (Map.size(mem.plain_nodes) == nodesBeforeFailedBegin);
assertStatReason(
    service.stat({ space = ?#shared_; path = "/failed" }),
    #not_found,
);

// Shared presentation and text/binary treatment are both derived from the
// logical extension rather than trusted from caller metadata.
let presentationCallsBefore = mock.begin_stage_calls;
for (extension in inlineTextExtensions.vals()) {
    let upper = Text.toUpper(extension);
    let safeName = "sample." # upper;
    assertWriteReason(
        service.writeBlock({
            sharedRequest(
                "shared-text-extension",
                "/" # safeName,
                null,
                0,
                1,
                1,
                "x",
                zeroEtag,
                null,
                safeName,
            ) with presentation = ?#attachment
        }),
        #invalid_request,
    );
    assertWriteReason(
        service.writeBlock({
            sharedRequest(
                "shared-text-content-kind",
                "/" # safeName,
                null,
                0,
                1,
                1,
                "x",
                zeroEtag,
                null,
                safeName,
            ) with content_kind = ?#binary
        }),
        #invalid_request,
    );
    let dotfile = "." # upper;
    assertWriteReason(
        service.writeBlock({
            sharedRequest(
                "shared-text-dotfile",
                "/" # dotfile,
                null,
                0,
                1,
                1,
                "x",
                zeroEtag,
                null,
                dotfile,
            ) with presentation = ?#attachment
        }),
        #invalid_request,
    );
};
let attachmentNames : [Text] = [
    "photo.png",
    "photo.jpg",
    "photo.jpeg",
    "document.pdf",
    "document.docx",
    "archive.zip",
    "audio.mp3",
    "video.mp4",
    "vector.svg",
    "unknown.neutron",
    ".neutron",
    ".png",
    "README",
    "report.",
];
for (safeName in attachmentNames.vals()) {
    assertWriteReason(
        service.writeBlock({
            sharedRequest(
                "shared-attachment-extension",
                "/" # safeName,
                null,
                0,
                1,
                1,
                "x",
                zeroEtag,
                null,
                safeName,
            ) with presentation = ?#inline_text
        }),
        #invalid_request,
    );
    assertWriteReason(
        service.writeBlock({
            sharedRequest(
                "shared-attachment-content-kind",
                "/" # safeName,
                null,
                0,
                1,
                1,
                "x",
                zeroEtag,
                null,
                safeName,
            ) with content_kind = ?#text
        }),
        #invalid_request,
    );
};
// The Certified Assets filename is a deterministic rendering of the actual
// logical basename; a direct caller cannot pair a text path with an executable
// download name.
assertWriteReason(
    service.writeBlock({
        sharedRequest(
            "shared-safe-name-binding",
            "/foo.txt",
            null,
            0,
            1,
            1,
            "x",
            zeroEtag,
            null,
            "download.exe",
        ) with
        presentation = ?#inline_text;
        content_kind = ?#text;
    }),
    #invalid_request,
);
assert (mock.begin_stage_calls == presentationCallsBefore);

// A recognized dotfile reaches the certified store as safe inline text; the
// presentation check must not merely reject the opposite test vector above.
let dotfileMem = Memory.init();
let dotfileMock = CertifiedAssetsMock.Mock(Fixtures.zeroUsage());
let dotfileService = PlainService.Service(
    dotfileMem,
    dotfileMock.handle(),
    func() { 1_000 },
);
let dotfileBody : Blob = "PUBLIC=true";
let dotfileTarget = target(30, 30, ".ENV");
configureBegin(
    dotfileMock,
    30,
    dotfileTarget,
    [dotfileBody.size()],
    dotfileBody.size(),
);
configurePut(
    dotfileMock,
    30,
    0,
    dotfileTarget,
    dotfileBody,
    true,
    publicationId(0),
);
dotfileMock.commit_batch_result := putReceipt(
    dotfileTarget,
    1,
    [dotfileBody],
);
let dotfileWrite = writeOk(
    dotfileService.writeBlock({
        sharedRequest(
            "shared-dotfile-accepted",
            "/.ENV",
            null,
            0,
            1,
            dotfileBody.size(),
            dotfileBody,
            zeroEtag,
            null,
            ".ENV",
        ) with content_kind = ?#text
    })
);
assert dotfileWrite.committed;
let ?dotfileEntry = dotfileWrite.entry else fail();
assert (dotfileEntry.content_kind == ?#text);
let ?dotfileBegin = dotfileMock.last_begin_stage else fail();
switch (dotfileBegin.target) {
    case (#allocate_publication(value)) {
        assert (value.presentation == #inline_text);
    };
    case (_) assert false;
};

// Unsupported filename runs are rendered deterministically from the logical
// basename; an upload/display name cannot select a different public filename.
let slugMem = Memory.init();
let slugMock = CertifiedAssetsMock.Mock(Fixtures.zeroUsage());
let slugService = PlainService.Service(
    slugMem,
    slugMock.handle(),
    func() { 1_000 },
);
let slugBody : Blob = "slug";
let slugTarget = target(31, 31, "weird-name.txt");
configureBegin(
    slugMock,
    31,
    slugTarget,
    [slugBody.size()],
    slugBody.size(),
);
configurePut(
    slugMock,
    31,
    0,
    slugTarget,
    slugBody,
    true,
    publicationId(0),
);
slugMock.commit_batch_result := putReceipt(slugTarget, 1, [slugBody]);
let slugWrite = writeOk(
    slugService.writeBlock(
        sharedRequest(
            "shared-safe-name-rendering",
            "/weird?! name.txt",
            null,
            0,
            1,
            slugBody.size(),
            slugBody,
            zeroEtag,
            null,
            "weird-name.txt",
        )
    )
);
assert slugWrite.committed;

// A first-block CA rejection is handleless: the backend aborts the freshly
// allocated certified stage before returning the original rejection.
let putRejectMem = Memory.init();
let putRejectMock = CertifiedAssetsMock.Mock(Fixtures.zeroUsage());
let putRejectService = PlainService.Service(
    putRejectMem,
    putRejectMock.handle(),
    func() { 1_000 },
);
let putRejectBody : Blob = "put-rejected";
let putRejectTarget = target(14, 14, "put-rejected.txt");
configureBegin(
    putRejectMock,
    44,
    putRejectTarget,
    [putRejectBody.size()],
    putRejectBody.size(),
);
putRejectMock.put_chunk_result := #err(#busy);
putRejectMock.abort_stage_result := #ok;
let putRejectRequest = sharedRequest(
    "shared-put-rejected",
    "/rejected/put/put-rejected.txt",
    null,
    0,
    1,
    putRejectBody.size(),
    putRejectBody,
    zeroEtag,
    null,
    "put-rejected.txt",
);
assertWriteReason(
    putRejectService.writeBlock(putRejectRequest),
    #busy,
);
assert (putRejectMock.begin_stage_calls == 1);
assert (putRejectMock.put_chunk_calls == 1);
assert (putRejectMock.commit_batch_calls == 0);
assert (putRejectMock.abort_stage_calls == 1);
assert (putRejectMock.last_abort_stage == ?44);
assert (Map.size(putRejectMem.plain_stages) == 0);
assert (Map.size(putRejectMem.plain_stage_by_request) == 0);
assert (Map.size(putRejectMem.plain_terminal_receipts) == 0);
assert (putRejectMem.shared_file_count == 0);
assert (putRejectMem.shared_plaintext_bytes == 0);
assert (Map.size(putRejectMem.plain_nodes) == 2);
assertStatReason(
    putRejectService.stat({
        space = ?#shared_;
        path = "/rejected";
    }),
    #not_found,
);
// Unknown-stage abort is still safe after the proactive cleanup and does not
// allocate an idempotency receipt.
assertMutationReason(
    putRejectService.abort({
        request_id = "shared-put-rejected";
        space = ?#shared_;
        stage_id = null;
    }),
    #not_found,
);
assert (Map.size(putRejectMem.plain_terminal_receipts) == 0);

// A one-block commit rejection has the same handleless cleanup guarantee even
// when Certified Assets reports that the stage is already expired.
let commitRejectMem = Memory.init();
let commitRejectMock = CertifiedAssetsMock.Mock(Fixtures.zeroUsage());
let commitRejectService = PlainService.Service(
    commitRejectMem,
    commitRejectMock.handle(),
    func() { 1_000 },
);
let commitRejectBody : Blob = "commit-rejected";
let commitRejectTarget = target(15, 15, "commit-rejected.txt");
configureBegin(
    commitRejectMock,
    45,
    commitRejectTarget,
    [commitRejectBody.size()],
    commitRejectBody.size(),
);
configurePut(
    commitRejectMock,
    45,
    0,
    commitRejectTarget,
    commitRejectBody,
    true,
    publicationId(0),
);
commitRejectMock.commit_batch_result := #err(#busy);
commitRejectMock.abort_stage_result := #err(#expired);
assertWriteReason(
    commitRejectService.writeBlock(
        sharedRequest(
            "shared-commit-rejected",
            "/rejected/commit/commit-rejected.txt",
            null,
            0,
            1,
            commitRejectBody.size(),
            commitRejectBody,
            zeroEtag,
            null,
            "commit-rejected.txt",
        )
    ),
    #busy,
);
assert (commitRejectMock.begin_stage_calls == 1);
assert (commitRejectMock.put_chunk_calls == 1);
assert (commitRejectMock.commit_batch_calls == 1);
assert (commitRejectMock.abort_stage_calls == 1);
assert (commitRejectMock.last_abort_stage == ?45);
assert (Map.size(commitRejectMem.plain_stages) == 0);
assert (Map.size(commitRejectMem.plain_stage_by_request) == 0);
assert (Map.size(commitRejectMem.plain_terminal_receipts) == 0);
assert (commitRejectMem.shared_file_count == 0);
assert (commitRejectMem.shared_plaintext_bytes == 0);
assert (Map.size(commitRejectMem.plain_nodes) == 2);
assertStatReason(
    commitRejectService.stat({
        space = ?#shared_;
        path = "/rejected";
    }),
    #not_found,
);

// Once a caller has received a stage ID, a transient final commit remains
// replayable instead of being retired behind that known handle.
let retryMem = Memory.init();
let retryMock = CertifiedAssetsMock.Mock(Fixtures.zeroUsage());
let retryService = PlainService.Service(
    retryMem,
    retryMock.handle(),
    func() { 1_000 },
);
let retryTail : Blob = "r";
let retryTarget = target(16, 16, "retry.bin");
configureBegin(
    retryMock,
    46,
    retryTarget,
    [Types.BLOCK_BYTES, retryTail.size()],
    Types.BLOCK_BYTES + retryTail.size(),
);
configurePut(
    retryMock,
    46,
    0,
    retryTarget,
    fullBlock,
    false,
    publicationId(0),
);
let retryFirst = sharedRequest(
    "shared-final-retry",
    "/retry.bin",
    null,
    0,
    2,
    Types.BLOCK_BYTES + retryTail.size(),
    fullBlock,
    zeroEtag,
    null,
    "retry.bin",
);
let retryStarted = writeOk(retryService.writeBlock(retryFirst));
let ?retryStageId = retryStarted.stage_id else fail();
configurePut(
    retryMock,
    46,
    1,
    retryTarget,
    retryTail,
    true,
    publicationId(0),
);
retryMock.commit_batch_result := #err(#busy);
let retryFinal = sharedRequest(
    "shared-final-retry",
    "/retry.bin",
    ?retryStageId,
    1,
    2,
    Types.BLOCK_BYTES + retryTail.size(),
    retryTail,
    zeroEtag,
    null,
    "retry.bin",
);
let retryPutCallsBeforeInvalidName = retryMock.put_chunk_calls;
assertWriteReason(
    retryService.writeBlock({
        retryFinal with safe_name = ?"other.bin"
    }),
    #invalid_request,
);
assertWriteReason(
    retryService.writeBlock({
        retryFinal with safe_name = null
    }),
    #invalid_request,
);
assert (retryMock.put_chunk_calls == retryPutCallsBeforeInvalidName);
assert (retryMock.commit_batch_calls == 0);
let retryAbortCalls = retryMock.abort_stage_calls;
assertWriteReason(retryService.writeBlock(retryFinal), #busy);
assert (retryMock.abort_stage_calls == retryAbortCalls);
assert (Map.size(retryMem.plain_stages) == 1);
assert (Map.size(retryMem.plain_terminal_receipts) == 0);
retryMock.commit_batch_result := putReceipt(
    retryTarget,
    1,
    [fullBlock, retryTail],
);
retryMock.put_chunk_result := #ok({
    stage_id = 46;
    index = 1;
    block_sha256 = Sha256.fromBlob(#sha256, retryTail);
    accepted = #replayed;
    complete = true;
    raw_sha256 = ?publicationId(0);
    computed_target = ?retryTarget;
});
let retryCommitted = writeOk(retryService.writeBlock(retryFinal));
assert retryCommitted.committed;
assert (Map.size(retryMem.plain_stages) == 0);
assert (Map.size(retryMem.plain_terminal_receipts) == 1);

// If the first successful receipt was lost and its null-ID replay later gets
// an explicit CA error, the request lookup is retired rather than stranded.
let lostReplayMem = Memory.init();
let lostReplayMock = CertifiedAssetsMock.Mock(Fixtures.zeroUsage());
let lostReplayService = PlainService.Service(
    lostReplayMem,
    lostReplayMock.handle(),
    func() { 1_000 },
);
let lostReplayTail : Blob = "z";
let lostReplayTarget = target(17, 17, "lost-replay.bin");
configureBegin(
    lostReplayMock,
    47,
    lostReplayTarget,
    [Types.BLOCK_BYTES, lostReplayTail.size()],
    Types.BLOCK_BYTES + lostReplayTail.size(),
);
configurePut(
    lostReplayMock,
    47,
    0,
    lostReplayTarget,
    fullBlock,
    false,
    publicationId(0),
);
let lostReplayFirst = sharedRequest(
    "shared-lost-first-receipt",
    "/lost-replay.bin",
    null,
    0,
    2,
    Types.BLOCK_BYTES + lostReplayTail.size(),
    fullBlock,
    zeroEtag,
    null,
    "lost-replay.bin",
);
ignore writeOk(lostReplayService.writeBlock(lostReplayFirst));
assert (Map.size(lostReplayMem.plain_stages) == 1);
lostReplayMock.put_chunk_result := #err(#busy);
lostReplayMock.abort_stage_result := #ok;
assertWriteReason(
    lostReplayService.writeBlock(lostReplayFirst),
    #busy,
);
assert (lostReplayMock.abort_stage_calls == 1);
assert (lostReplayMock.last_abort_stage == ?47);
assert (Map.size(lostReplayMem.plain_stages) == 0);
assert (Map.size(lostReplayMem.plain_stage_by_request) == 0);
assert (Map.size(lostReplayMem.plain_terminal_receipts) == 0);

// Shared writes publish directly to Certified Assets. Replacement publishes a
// new identity and revokes the previous URL before switching local metadata.
let firstSharedBody : Blob = "public-one";
let firstTarget = target(11, 11, "readme.txt");
configureBegin(
    mock,
    41,
    firstTarget,
    [firstSharedBody.size()],
    firstSharedBody.size(),
);
configurePut(
    mock,
    41,
    0,
    firstTarget,
    firstSharedBody,
    true,
    publicationId(17),
);
mock.commit_batch_result := putReceipt(
    firstTarget,
    1,
    [firstSharedBody],
);
mock.commit_batch_results := [];
mock.commit_batch_result_index := 0;
let firstShared = writeOk(
    service.writeBlock(
        sharedRequest(
            "shared-first",
            "/public/docs/readme.txt",
            null,
            0,
            1,
            firstSharedBody.size(),
            firstSharedBody,
            oneEtag,
            null,
            "readme.txt",
        )
    )
);
assert firstShared.committed;
let ?firstSharedEntry = firstShared.entry else fail();
assert (firstSharedEntry.relative_url != null);
assert (
    Text.contains(
        switch (firstSharedEntry.relative_url) {
            case (?value) value;
            case null fail();
        },
        #text "readme.txt",
    )
);
assert (mem.shared_plaintext_bytes == firstSharedBody.size());

let secondSharedBody : Blob = "public-two-longer";
let secondTarget = target(12, 12, "readme.txt");
configureBegin(
    mock,
    42,
    secondTarget,
    [secondSharedBody.size()],
    secondSharedBody.size(),
);
configurePut(
    mock,
    42,
    0,
    secondTarget,
    secondSharedBody,
    true,
    publicationId(34),
);
mock.usage_result := #ok(usage(1, firstSharedBody.size()));
let firstTag = certifiedContentTag(
    firstSharedBody.size(),
    [firstSharedBody.size()],
    [Sha256.fromBlob(#sha256, firstSharedBody)],
);
mock.commit_batch_results := [
    putReceipt(
        secondTarget,
        1,
        [secondSharedBody],
    ),
    deleteReceipt(firstTarget, 2, firstTag),
];
mock.commit_batch_result_index := 0;
let commitCallsBeforeReplace = mock.commit_batch_calls;
let replaced = writeOk(
    service.writeBlock(
        {
            sharedRequest(
            "shared-replace",
            "/public/docs/readme.txt",
            null,
            0,
            1,
            secondSharedBody.size(),
            secondSharedBody,
            twoEtag,
            ?oneEtag,
            "readme.txt",
            ) with
            expected_node_id = ?firstSharedEntry.node_id;
            expected_revision = ?firstSharedEntry.revision;
        }
    )
);
assert replaced.committed;
assert (mock.commit_batch_calls == commitCallsBeforeReplace + 2);
assert (mem.shared_plaintext_bytes == secondSharedBody.size());
let ?replacedEntry = replaced.entry else fail();
assert (replacedEntry.relative_url != firstSharedEntry.relative_url);

// The public filename is part of the certified target. Same-root metadata
// moves may reorganize folders, but filename changes must republish through
// the resident instead of silently leaving the old public name.
assertMutationReason(
    service.move({
        request_id = "shared-rename-requires-republish";
        space = ?#shared_;
        from = "/public/docs/readme.txt";
        to = "/public/docs/renamed.txt";
        overwrite = false;
        expected_node_id = replacedEntry.node_id;
        expected_revision = replacedEntry.revision;
        if_match = ?twoEtag;
    }),
    #invalid_request,
);
assert (
    statOk(
        service.stat({
            space = ?#shared_;
            path = "/public/docs/readme.txt";
        })
    ).etag_sha256 == ?twoEtag
);

// A Shared leaf rename atomically publishes the new filename and revokes the
// old URL.
let renamedTarget = target(18, 18, "renamed.txt");
configureBegin(
    mock,
    48,
    renamedTarget,
    [secondSharedBody.size()],
    secondSharedBody.size(),
);
configurePut(
    mock,
    48,
    0,
    renamedTarget,
    secondSharedBody,
    true,
    publicationId(34),
);
let secondTag = certifiedContentTag(
    secondSharedBody.size(),
    [secondSharedBody.size()],
    [Sha256.fromBlob(#sha256, secondSharedBody)],
);
mock.commit_batch_results := [
    putReceipt(renamedTarget, 1, [secondSharedBody]),
    deleteReceipt(secondTarget, 2, secondTag),
];
mock.commit_batch_result_index := 0;
let renameRequest : Types.WriteBlockRequest = {
    sharedRequest(
        "shared-atomic-rename",
        "/public/docs/renamed.txt",
        null,
        0,
        1,
        secondSharedBody.size(),
        secondSharedBody,
        twoEtag,
        null,
        "renamed.txt",
    ) with
    move_source = ?{
        path = "/public/docs/readme.txt";
        expected_node_id = replacedEntry.node_id;
        expected_revision = replacedEntry.revision;
        if_match = ?twoEtag;
    };
};
let renameCommitCalls = mock.commit_batch_calls;
let renamed = writeOk(service.writeBlock(renameRequest));
let ?renamedEntry = renamed.entry else fail();
assert (mock.commit_batch_calls == renameCommitCalls + 2);
assert (renamedEntry.node_id == replacedEntry.node_id);
assert (renamedEntry.revision == replacedEntry.revision + 1);
assert (renamedEntry.created_at_ns == replacedEntry.created_at_ns);
assert (renamedEntry.relative_url != replacedEntry.relative_url);
assert (mem.shared_file_count == 1);
assert (mem.shared_plaintext_bytes == secondSharedBody.size());
assertStatReason(
    service.stat({
        space = ?#shared_;
        path = "/public/docs/readme.txt";
    }),
    #not_found,
);
let beginCallsAfterRename = mock.begin_stage_calls;
let putCallsAfterRename = mock.put_chunk_calls;
let replayedRename = writeOk(service.writeBlock(renameRequest));
assert (replayedRename.entry == renamed.entry);
assert (mock.begin_stage_calls == beginCallsAfterRename);
assert (mock.put_chunk_calls == putCallsAfterRename);
assert (mock.commit_batch_calls == renameCommitCalls + 2);
assertWriteReason(
    service.writeBlock({
        renameRequest with etag_sha256 = oneEtag
    }),
    #conflict,
);

// Removing a Shared file revokes its current Certified Assets identity.
mock.commit_batch_results := [];
mock.commit_batch_result_index := 0;
mock.commit_batch_result := deleteReceipt(
    renamedTarget,
    2,
    secondTag,
);
let commitCallsBeforeRemove = mock.commit_batch_calls;
switch (
    service.remove({
        request_id = "shared-remove-stale-revision";
        space = ?#shared_;
        path = "/public/docs/renamed.txt";
        recursive = false;
        expected_node_id = renamedEntry.node_id;
        expected_revision = renamedEntry.revision - 1;
        if_match = ?twoEtag;
        delete_nonce = ?Fixtures.zeros(16);
    }).outcome
) {
    case (?#rejected({ reason = ?#stale_revision })) {};
    case (_) assert false;
};
switch (
    service.remove({
        request_id = "shared-remove-stale-content";
        space = ?#shared_;
        path = "/public/docs/renamed.txt";
        recursive = false;
        expected_node_id = renamedEntry.node_id;
        expected_revision = renamedEntry.revision;
        if_match = ?oneEtag;
        delete_nonce = ?Fixtures.zeros(16);
    }).outcome
) {
    case (?#rejected({ reason = ?#stale_content })) {};
    case (_) assert false;
};
assert (mock.commit_batch_calls == commitCallsBeforeRemove);
let sharedRemoveRequest : Types.RemoveRequest = {
    request_id = "shared-remove";
    space = ?#shared_;
    path = "/public/docs/renamed.txt";
    recursive = false;
    expected_node_id = renamedEntry.node_id;
    expected_revision = renamedEntry.revision;
    if_match = ?twoEtag;
    delete_nonce = ?Fixtures.zeros(16);
};
switch (service.remove(sharedRemoveRequest).outcome) {
    case (?#ok(_)) {};
    case (_) assert false;
};
assert (mock.commit_batch_calls == commitCallsBeforeRemove + 1);
switch (service.remove(sharedRemoveRequest).outcome) {
    case (?#ok({ changed = 1 })) {};
    case (_) assert false;
};
assert (mock.commit_batch_calls == commitCallsBeforeRemove + 1);
assertMutationReason(
    service.remove({
        sharedRemoveRequest with recursive = true
    }),
    #conflict,
);
assert (mem.shared_plaintext_bytes == 0);
assertStatReason(
    service.stat({
        space = ?#shared_;
        path = "/public/docs/renamed.txt";
    }),
    #not_found,
);
mock.usage_result := #ok(Fixtures.zeroUsage());

// Aborting a partial Shared upload retires its Certified Assets stage.
let pendingTarget = target(13, 13, "pending.bin");
configureBegin(
    mock,
    43,
    pendingTarget,
    [Types.BLOCK_BYTES, 1],
    Types.BLOCK_BYTES + 1,
);
configurePut(
    mock,
    43,
    0,
    pendingTarget,
    fullBlock,
    false,
    publicationId(0),
);
mock.abort_stage_result := #err(#expired);
let pendingShared = writeOk(
    service.writeBlock(
        sharedRequest(
            "shared-abort",
            "/pending.bin",
            null,
            0,
            2,
            Types.BLOCK_BYTES + 1,
            fullBlock,
            zeroEtag,
            null,
            "pending.bin",
        )
    )
);
let ?sharedStageId = pendingShared.stage_id else fail();
let abortCallsBefore = mock.abort_stage_calls;
let sharedAbortRequest : Types.AbortRequest = {
    request_id = "shared-abort";
    space = ?#shared_;
    stage_id = null;
};
switch (service.abort(sharedAbortRequest).outcome) {
    case (?#ok(_)) {};
    case (_) assert false;
};
assert (mock.abort_stage_calls == abortCallsBefore + 1);
assert (mock.last_abort_stage == ?43);
assert (Map.size(mem.plain_stages) == 0);
switch (service.abort(sharedAbortRequest).outcome) {
    case (?#ok(_)) {};
    case (_) assert false;
};
assert (mock.abort_stage_calls == abortCallsBefore + 1);
assertMutationReason(
    service.abort({
        sharedAbortRequest with stage_id = ?sharedStageId
    }),
    #conflict,
);

// Workspace expiry remains an idle policy: an exact replay refreshes local
// activity, so cleanup at the original deadline does not retire the stage.
let cleanupMem = Memory.init();
let cleanupMock = CertifiedAssetsMock.Mock(Fixtures.zeroUsage());
var cleanupNow : Nat64 = 500;
let cleanupService = PlainService.Service(
    cleanupMem,
    cleanupMock.handle(),
    func() { cleanupNow },
);
let cleanupPartial = writeOk(
    cleanupService.writeBlock(
        workspaceRequest(
            "cleanup-abandoned",
            "/abandoned.bin",
            null,
            0,
            2,
            Types.BLOCK_BYTES + 1,
            fullBlock,
            zeroEtag,
            false,
        )
    )
);
let ?cleanupStageId = cleanupPartial.stage_id else fail();
assert (Map.size(cleanupMem.plain_stages) == 1);
let ?cleanupStarted = Map.get(
    cleanupMem.plain_stages,
    Nat64.compare,
    cleanupStageId,
) else fail();
cleanupNow :=
    cleanupStarted.modified_at_ns + Types.PLAIN_STAGE_IDLE_NS - 1;
let cleanupReplay = writeOk(
    cleanupService.writeBlock(
        workspaceRequest(
            "cleanup-abandoned",
            "/abandoned.bin",
            ?cleanupStageId,
            0,
            2,
            Types.BLOCK_BYTES + 1,
            fullBlock,
            zeroEtag,
            false,
        )
    )
);
assert (not cleanupReplay.committed);
let ?cleanupRefreshed = Map.get(
    cleanupMem.plain_stages,
    Nat64.compare,
    cleanupStageId,
) else fail();
assert (cleanupRefreshed.modified_at_ns == cleanupNow);
cleanupNow := cleanupStarted.modified_at_ns + Types.PLAIN_STAGE_IDLE_NS;
switch (
    cleanupService.cleanup({
        request_id = "cleanup-before-idle-deadline";
        limit = 3;
    }).outcome
) {
    case (?#ok({ changed = 0 })) {};
    case (_) assert false;
};
assert (Map.size(cleanupMem.plain_stages) == 1);
cleanupNow :=
    cleanupRefreshed.modified_at_ns + Types.PLAIN_STAGE_IDLE_NS;
switch (
    cleanupService.cleanup({
        request_id = "cleanup-at-refreshed-idle-deadline";
        limit = 3;
    }).outcome
) {
    case (?#ok({ changed = 1 })) {};
    case (_) assert false;
};
assert (Map.size(cleanupMem.plain_stages) == 0);
assert (Map.size(cleanupMem.plain_blocks) == 0);
assert (cleanupMem.staged_workspace_bytes == 0);
switch (
    cleanupService.cleanup({
        request_id = "cleanup-at-refreshed-idle-deadline";
        limit = 3;
    }).outcome
) {
    case (?#ok({ changed = 0 })) {};
    case (_) assert false;
};
switch (
    cleanupService.cleanup({
        request_id = "cleanup-at-refreshed-idle-deadline";
        limit = 1;
    }).outcome
) {
    case (?#ok({ changed = 0 })) {};
    case (_) assert false;
};
assertWriteReason(
    cleanupService.writeBlock(
        workspaceRequest(
            "cleanup-abandoned",
            "/abandoned.bin",
            null,
            0,
            2,
            Types.BLOCK_BYTES + 1,
            fullBlock,
            zeroEtag,
            false,
        )
    ),
    #conflict,
);
assertWriteReason(
    cleanupService.writeBlock(
        workspaceRequest(
            "cleanup-abandoned",
            "/different.bin",
            null,
            0,
            2,
            Types.BLOCK_BYTES + 1,
            fullBlock,
            zeroEtag,
            false,
        )
    ),
    #conflict,
);
assertMutationReason(
    cleanupService.cleanup({
        request_id = "cleanup-abandoned";
        limit = 1;
    }),
    #conflict,
);

// Shared expiry is instead a fixed 55-minute maximum lifetime from local
// stage creation. Neither a Certified Assets replay nor a newly accepted later
// block may move it beyond the Kernel stage's initial one-hour deadline.
let sharedExpiryMem = Memory.init();
let sharedExpiryMock = CertifiedAssetsMock.Mock(Fixtures.zeroUsage());
var sharedExpiryNow : Nat64 = 2_000;
let sharedExpiryService = PlainService.Service(
    sharedExpiryMem,
    sharedExpiryMock.handle(),
    func() { sharedExpiryNow },
);
let sharedExpiryTarget = target(16, 16, "fixed.bin");
configureBegin(
    sharedExpiryMock,
    46,
    sharedExpiryTarget,
    [Types.BLOCK_BYTES, Types.BLOCK_BYTES, 1],
    Types.BLOCK_BYTES * 2 + 1,
);
configurePut(
    sharedExpiryMock,
    46,
    0,
    sharedExpiryTarget,
    fullBlock,
    false,
    publicationId(0),
);
let sharedExpiryPartial = writeOk(
    sharedExpiryService.writeBlock(
        sharedRequest(
            "shared-fixed-expiry",
            "/fixed.bin",
            null,
            0,
            3,
            Types.BLOCK_BYTES * 2 + 1,
            fullBlock,
            zeroEtag,
            null,
            "fixed.bin",
        )
    )
);
let ?sharedExpiryStageId = sharedExpiryPartial.stage_id else fail();
let ?sharedExpiryStarted = Map.get(
    sharedExpiryMem.plain_stages,
    Nat64.compare,
    sharedExpiryStageId,
) else fail();
assert (
    sharedExpiryStarted.shared_expires_at_ns ==
        ?(
            sharedExpiryStarted.modified_at_ns +
            Types.PLAIN_STAGE_IDLE_NS
        )
);
sharedExpiryNow :=
    sharedExpiryStarted.modified_at_ns + Types.PLAIN_STAGE_IDLE_NS - 2;
sharedExpiryMock.put_chunk_result := #ok({
    stage_id = 46;
    index = 0;
    block_sha256 = Sha256.fromBlob(#sha256, fullBlock);
    accepted = #replayed;
    complete = false;
    raw_sha256 = null;
    computed_target = ?sharedExpiryTarget;
});
ignore writeOk(
    sharedExpiryService.writeBlock(
        sharedRequest(
            "shared-fixed-expiry",
            "/fixed.bin",
            ?sharedExpiryStageId,
            0,
            3,
            Types.BLOCK_BYTES * 2 + 1,
            fullBlock,
            zeroEtag,
            null,
            "fixed.bin",
        )
    )
);
let ?sharedAfterReplay = Map.get(
    sharedExpiryMem.plain_stages,
    Nat64.compare,
    sharedExpiryStageId,
) else fail();
assert (
    sharedAfterReplay.modified_at_ns ==
        sharedExpiryStarted.modified_at_ns
);
sharedExpiryNow += 1;
configurePut(
    sharedExpiryMock,
    46,
    1,
    sharedExpiryTarget,
    fullBlock,
    false,
    publicationId(0),
);
ignore writeOk(
    sharedExpiryService.writeBlock(
        sharedRequest(
            "shared-fixed-expiry",
            "/fixed.bin",
            ?sharedExpiryStageId,
            1,
            3,
            Types.BLOCK_BYTES * 2 + 1,
            fullBlock,
            zeroEtag,
            null,
            "fixed.bin",
        )
    )
);
let ?sharedAfterProgress = Map.get(
    sharedExpiryMem.plain_stages,
    Nat64.compare,
    sharedExpiryStageId,
) else fail();
assert (
    sharedAfterProgress.modified_at_ns ==
        sharedExpiryStarted.modified_at_ns
);
sharedExpiryNow :=
    sharedExpiryStarted.modified_at_ns + Types.PLAIN_STAGE_IDLE_NS;
sharedExpiryMock.abort_stage_result := #err(#busy);
let sharedExpiryAbortCalls = sharedExpiryMock.abort_stage_calls;
switch (
    sharedExpiryService.cleanup({
        request_id = "cleanup-shared-fixed-expiry";
        limit = 3;
    }).outcome
) {
    case (?#ok({ changed = 0 })) {};
    case (_) assert false;
};
assert (
    sharedExpiryMock.abort_stage_calls == sharedExpiryAbortCalls + 1
);
assert (sharedExpiryMock.last_abort_stage == ?46);
assert (Map.size(sharedExpiryMem.plain_stages) == 1);
assert (Map.size(sharedExpiryMem.plain_stage_by_request) == 1);
assert (Map.size(sharedExpiryMem.plain_terminal_receipts) == 0);
sharedExpiryMock.abort_stage_result := #ok;
switch (
    sharedExpiryService.cleanup({
        request_id = "cleanup-shared-fixed-expiry-retry";
        limit = 3;
    }).outcome
) {
    case (?#ok({ changed = 1 })) {};
    case (_) assert false;
};
assert (
    sharedExpiryMock.abort_stage_calls == sharedExpiryAbortCalls + 2
);
assert (Map.size(sharedExpiryMem.plain_stages) == 0);
assert (Map.size(sharedExpiryMem.plain_stage_by_request) == 0);
assert (Map.size(sharedExpiryMem.plain_terminal_receipts) == 1);

// A replayed Kernel begin that is already inside the safety margin is aborted
// before rejection because no local request/stage handle has been installed.
let shortBeginMem = Memory.init();
let shortBeginMock = CertifiedAssetsMock.Mock(Fixtures.zeroUsage());
var shortBeginNow : Nat64 = 3_000;
let shortBeginService = PlainService.Service(
    shortBeginMem,
    shortBeginMock.handle(),
    func() { shortBeginNow },
);
let shortBeginTarget = target(18, 18, "too-short.bin");
configureBegin(
    shortBeginMock,
    48,
    shortBeginTarget,
    [1],
    1,
);
let #ok(shortBeginReceipt) = shortBeginMock.begin_stage_result else fail();
shortBeginMock.begin_stage_result := #ok({
    shortBeginReceipt with
    expires_at_ns =
        shortBeginNow + Types.SHARED_STAGE_KERNEL_MARGIN_NS;
});
shortBeginMock.abort_stage_result := #ok;
assertWriteReason(
    shortBeginService.writeBlock(
        sharedRequest(
            "shared-too-short-begin",
            "/too-short.bin",
            null,
            0,
            1,
            1,
            "x",
            zeroEtag,
            null,
            "too-short.bin",
        )
    ),
    #conflict,
);
assert (shortBeginMock.abort_stage_calls == 1);
assert (shortBeginMock.last_abort_stage == ?48);
assert (shortBeginMock.put_chunk_calls == 0);
assert (Map.size(shortBeginMem.plain_stages) == 0);
assert (Map.size(shortBeginMem.plain_stage_by_request) == 0);

// An idempotent begin can return an older still-active Kernel stage. Its exact
// returned expiry, less the five-minute safety margin, further shortens the
// local deadline instead of granting a fresh 55-minute lifecycle.
let kernelCappedMem = Memory.init();
let kernelCappedMock = CertifiedAssetsMock.Mock(Fixtures.zeroUsage());
var kernelCappedNow : Nat64 = 4_000;
let kernelCappedService = PlainService.Service(
    kernelCappedMem,
    kernelCappedMock.handle(),
    func() { kernelCappedNow },
);
let kernelCappedTarget = target(17, 17, "older.bin");
configureBegin(
    kernelCappedMock,
    47,
    kernelCappedTarget,
    [Types.BLOCK_BYTES, 1],
    Types.BLOCK_BYTES + 1,
);
let #ok(kernelCappedBegin) = kernelCappedMock.begin_stage_result else fail();
kernelCappedMock.begin_stage_result := #ok({
    kernelCappedBegin with
    expires_at_ns =
        kernelCappedNow + Types.SHARED_STAGE_KERNEL_MARGIN_NS + 100;
});
configurePut(
    kernelCappedMock,
    47,
    0,
    kernelCappedTarget,
    fullBlock,
    false,
    publicationId(0),
);
let kernelCappedPartial = writeOk(
    kernelCappedService.writeBlock(
        sharedRequest(
            "shared-kernel-capped-expiry",
            "/older.bin",
            null,
            0,
            2,
            Types.BLOCK_BYTES + 1,
            fullBlock,
            zeroEtag,
            null,
            "older.bin",
        )
    )
);
let ?kernelCappedStageId = kernelCappedPartial.stage_id else fail();
let ?kernelCappedStage = Map.get(
    kernelCappedMem.plain_stages,
    Nat64.compare,
    kernelCappedStageId,
) else fail();
assert (
    kernelCappedStage.shared_expires_at_ns ==
        ?(kernelCappedNow + 100)
);
kernelCappedNow += 100;
kernelCappedMock.abort_stage_result := #ok;
switch (
    kernelCappedService.cleanup({
        request_id = "cleanup-shared-kernel-capped-expiry";
        limit = 3;
    }).outcome
) {
    case (?#ok({ changed = 1 })) {};
    case (_) assert false;
};
assert (kernelCappedMock.last_abort_stage == ?47);
assert (Map.size(kernelCappedMem.plain_stages) == 0);

// A staged file target reserves its path as a file. mkdir cannot race it by
// materializing that path (or a descendant) as a folder.
let mkdirGuardMem = Memory.init();
let mkdirGuardMock = CertifiedAssetsMock.Mock(Fixtures.zeroUsage());
let mkdirGuardService = PlainService.Service(
    mkdirGuardMem,
    mkdirGuardMock.handle(),
    func() { 700 },
);
ignore writeOk(
    mkdirGuardService.writeBlock(
        workspaceRequest(
            "mkdir-guard-stage",
            "/reserved.bin",
            null,
            0,
            2,
            Types.BLOCK_BYTES + 1,
            fullBlock,
            zeroEtag,
            false,
        )
    )
);
assertMutationReason(
    mkdirGuardService.mkdir({
        request_id = "mkdir-at-stage";
        space = ?#workspace;
        path = "/reserved.bin";
        recursive = false;
    }),
    #busy,
);
assertMutationReason(
    mkdirGuardService.mkdir({
        request_id = "mkdir-below-stage";
        space = ?#workspace;
        path = "/reserved.bin/child";
        recursive = true;
    }),
    #busy,
);
let nodesBeforeNestedWrite = Map.size(mkdirGuardMem.plain_nodes);
assertWriteReason(
    mkdirGuardService.writeBlock(
        workspaceRequest(
            "write-below-stage",
            "/reserved.bin/child.bin",
            null,
            0,
            1,
            1,
            "x",
            oneEtag,
            true,
        )
    ),
    #busy,
);
assert (Map.size(mkdirGuardMem.plain_nodes) == nodesBeforeNestedWrite);

// The 257th Certified Assets manifest entry is internal replacement headroom,
// not durable user capacity. An in-flight new Shared file also reserves one of
// the 256 durable slots.
let countMem = Memory.init();
countMem.shared_file_count := Types.MAX_SHARED_FILES - 1;
let countMock = CertifiedAssetsMock.Mock(
    usage(Types.MAX_SHARED_FILES - 1, 0)
);
let countService = PlainService.Service(
    countMem,
    countMock.handle(),
    func() { 800 },
);
let countTarget = target(15, 15, "reserved.bin");
configureBegin(
    countMock,
    45,
    countTarget,
    [Types.BLOCK_BYTES, 1],
    Types.BLOCK_BYTES + 1,
);
configurePut(
    countMock,
    45,
    0,
    countTarget,
    fullBlock,
    false,
    publicationId(0),
);
ignore writeOk(
    countService.writeBlock(
        sharedRequest(
            "shared-count-reservation",
            "/reserved.bin",
            null,
            0,
            2,
            Types.BLOCK_BYTES + 1,
            fullBlock,
            zeroEtag,
            null,
            "reserved.bin",
        )
    )
);
let beginCallsAtCapacity = countMock.begin_stage_calls;
assertWriteReason(
    countService.writeBlock(
        sharedRequest(
            "shared-over-capacity",
            "/over.bin",
            null,
            0,
            1,
            1,
            "x",
            oneEtag,
            null,
            "over.bin",
        )
    ),
    #quota,
);
assert (countMock.begin_stage_calls == beginCallsAtCapacity);

// A provisional shrink is not capacity. At the 64-MiB Workspace ceiling,
// beginning 63 -> 2 MiB must not make room for a concurrent 1 -> 63 MiB
// replacement. Aborting the shrink first must leave the growth rejected, so
// no commit order can lift the durable counter above the ceiling.
let reservationMem = Memory.init();
let reservationMock = CertifiedAssetsMock.Mock(Fixtures.zeroUsage());
let reservationService = PlainService.Service(
    reservationMem,
    reservationMock.handle(),
    func() { 975 },
);
ignore writeOk(
    reservationService.writeBlock(
        workspaceRequest(
            "reservation-seed-large",
            "/large.bin",
            null,
            0,
            1,
            1,
            "l",
            zeroEtag,
            false,
        )
    )
);
ignore writeOk(
    reservationService.writeBlock(
        workspaceRequest(
            "reservation-seed-small",
            "/small.bin",
            null,
            0,
            1,
            1,
            "s",
            oneEtag,
            false,
        )
    )
);
let reservationLarge = statOk(
    reservationService.stat({
        space = ?#workspace;
        path = "/large.bin";
    })
);
let reservationSmall = statOk(
    reservationService.stat({
        space = ?#workspace;
        path = "/small.bin";
    })
);
let ?reservationLargeNode = Map.get(
    reservationMem.plain_nodes,
    Nat64.compare,
    reservationLarge.node_id,
) else fail();
let ?reservationLargeFile = reservationLargeNode.file else fail();
let ?reservationSmallNode = Map.get(
    reservationMem.plain_nodes,
    Nat64.compare,
    reservationSmall.node_id,
) else fail();
let ?reservationSmallFile = reservationSmallNode.file else fail();
let oneMiB = 1_048_576;
let shrinkFromBytes = 63 * oneMiB;
let shrinkToBytes = 2 * oneMiB;
let growFromBytes = oneMiB;
let growToBytes = 63 * oneMiB;
Map.add(
    reservationMem.plain_nodes,
    Nat64.compare,
    reservationLarge.node_id,
    {
        reservationLargeNode with
        file = ?{
            reservationLargeFile with
            total_bytes = shrinkFromBytes;
        };
    },
);
Map.add(
    reservationMem.plain_nodes,
    Nat64.compare,
    reservationSmall.node_id,
    {
        reservationSmallNode with
        file = ?{
            reservationSmallFile with
            total_bytes = growFromBytes;
        };
    },
);
reservationMem.workspace_plaintext_bytes :=
    shrinkFromBytes + growFromBytes;
let shrinkBegin = writeOk(
    reservationService.writeBlock({
        workspaceRequest(
            "reservation-shrink",
            "/large.bin",
            null,
            0,
            2,
            shrinkToBytes,
            fullBlock,
            twoEtag,
            false,
        ) with
        expected_node_id = ?reservationLarge.node_id;
        expected_revision = ?reservationLarge.revision;
        if_match = ?zeroEtag;
        if_none_match = false;
    })
);
let ?shrinkStageId = shrinkBegin.stage_id else fail();
let growthRequest : Types.WriteBlockRequest = {
    workspaceRequest(
        "reservation-growth",
        "/small.bin",
        null,
        0,
        35,
        growToBytes,
        fullBlock,
        twoEtag,
        false,
    ) with
    expected_node_id = ?reservationSmall.node_id;
    expected_revision = ?reservationSmall.revision;
    if_match = ?oneEtag;
    if_none_match = false;
};
assertWriteReason(
    reservationService.writeBlock(growthRequest),
    #quota,
);
assert (Map.size(reservationMem.plain_stages) == 1);
switch (
    reservationService.abort({
        request_id = "reservation-shrink";
        space = ?#workspace;
        stage_id = ?shrinkStageId;
    }).outcome
) {
    case (?#ok(_)) {};
    case (_) assert false;
};
assertWriteReason(
    reservationService.writeBlock(growthRequest),
    #quota,
);
assert (
    reservationMem.workspace_plaintext_bytes ==
        Types.MAX_TOTAL_WORKSPACE_BYTES
);
assert (Map.size(reservationMem.plain_stages) == 0);

// Node identity closes delete/recreate ABA even when the replacement happens
// to have the same path, revision, and content tag as the entry the user saw.
let abaMem = Memory.init();
let abaMock = CertifiedAssetsMock.Mock(Fixtures.zeroUsage());
let abaService = PlainService.Service(
    abaMem,
    abaMock.handle(),
    func() { 1_000 },
);
ignore writeOk(
    abaService.writeBlock(
        workspaceRequest(
            "aba-create",
            "/aba.bin",
            null,
            0,
            1,
            1,
            "a",
            zeroEtag,
            false,
        )
    )
);
let abaOriginal = statOk(
    abaService.stat({ space = ?#workspace; path = "/aba.bin" })
);
let abaRemoveRequest : Types.RemoveRequest = {
    request_id = "aba-remove";
    space = ?#workspace;
    path = "/aba.bin";
    recursive = false;
    expected_node_id = abaOriginal.node_id;
    expected_revision = abaOriginal.revision;
    if_match = ?zeroEtag;
    delete_nonce = null;
};
switch (abaService.remove(abaRemoveRequest).outcome) {
    case (?#ok(_)) {};
    case (_) assert false;
};
ignore writeOk(
    abaService.writeBlock(
        workspaceRequest(
            "aba-recreate",
            "/aba.bin",
            null,
            0,
            1,
            1,
            "a",
            zeroEtag,
            false,
        )
    )
);
let abaReplacement = statOk(
    abaService.stat({ space = ?#workspace; path = "/aba.bin" })
);
assert (abaReplacement.node_id != abaOriginal.node_id);
assert (abaReplacement.revision == abaOriginal.revision);
switch (abaService.remove(abaRemoveRequest).outcome) {
    case (?#ok({ changed = 1 })) {};
    case (_) assert false;
};
assert (
    statOk(
        abaService.stat({
            space = ?#workspace;
            path = "/aba.bin";
        })
    ).node_id == abaReplacement.node_id
);
assertWriteReason(
    abaService.writeBlock({
        workspaceRequest(
            "aba-stale-write",
            "/aba.bin",
            null,
            0,
            1,
            1,
            "b",
            oneEtag,
            false,
        ) with
        expected_node_id = ?abaOriginal.node_id;
        expected_revision = ?abaOriginal.revision;
        if_match = ?zeroEtag;
        if_none_match = false;
    }),
    #stale_revision,
);
assertMutationReason(
    abaService.move({
        request_id = "aba-stale-move";
        space = ?#workspace;
        from = "/aba.bin";
        to = "/moved.bin";
        overwrite = false;
        expected_node_id = abaOriginal.node_id;
        expected_revision = abaOriginal.revision;
        if_match = ?zeroEtag;
    }),
    #stale_revision,
);
assertMutationReason(
    abaService.remove({
        abaRemoveRequest with request_id = "aba-stale-remove"
    }),
    #stale_revision,
);
assert (
    statOk(
        abaService.stat({
            space = ?#workspace;
            path = "/aba.bin";
        })
    ).node_id == abaReplacement.node_id
);

// Folder moves visit only the moved subtree and accept ordinary reparenting,
// while rejecting a destination that would push any descendant past 64 path
// segments.
let treeMem = Memory.init();
let treeMock = CertifiedAssetsMock.Mock(Fixtures.zeroUsage());
let treeService = PlainService.Service(
    treeMem,
    treeMock.handle(),
    func() { 1_100 },
);
switch (
    treeService.mkdir({
        request_id = "tree-a";
        space = ?#workspace;
        path = "/A/child";
        recursive = true;
    }).outcome
) {
    case (?#ok(_)) {};
    case (_) assert false;
};
switch (
    treeService.mkdir({
        request_id = "tree-b";
        space = ?#workspace;
        path = "/B";
        recursive = false;
    }).outcome
) {
    case (?#ok(_)) {};
    case (_) assert false;
};
let treeA = statOk(
    treeService.stat({ space = ?#workspace; path = "/A" })
);
switch (
    treeService.move({
        request_id = "tree-move";
        space = ?#workspace;
        from = "/A";
        to = "/B/A";
        overwrite = false;
        expected_node_id = treeA.node_id;
        expected_revision = treeA.revision;
        if_match = null;
    }).outcome
) {
    case (?#ok({ changed = 1 })) {};
    case (_) assert false;
};
assert (
    statOk(
        treeService.stat({
            space = ?#workspace;
            path = "/B/A/child";
        })
    ).kind == ?#folder
);

// Zero bytes and the exact 64 MiB/36-block ceiling both traverse the real
// Shared begin/chunk/commit geometry and structural content-tag checks.
let boundaryMem = Memory.init();
let boundaryMock = CertifiedAssetsMock.Mock(Fixtures.zeroUsage());
let boundaryService = PlainService.Service(
    boundaryMem,
    boundaryMock.handle(),
    func() { 1_200 },
);
let zeroTarget = target(21, 21, "zero.txt");
configureBegin(boundaryMock, 51, zeroTarget, [0], 0);
configurePut(
    boundaryMock,
    51,
    0,
    zeroTarget,
    "",
    true,
    publicationId(0),
);
boundaryMock.commit_batch_result := putReceipt(
    zeroTarget,
    1,
    [""],
);
let zeroCommitted = writeOk(
    boundaryService.writeBlock(
        sharedRequest(
            "boundary-zero",
            "/zero.txt",
            null,
            0,
            1,
            0,
            "",
            zeroEtag,
            null,
            "zero.txt",
        )
    )
);
let ?zeroEntry = zeroCommitted.entry else fail();
assert (zeroEntry.byte_length == ?0);
boundaryMock.usage_result := #ok(usage(1, 0));

let maxLastBytes =
    Types.MAX_FILE_BYTES -
    Types.BLOCK_BYTES *
    (Nat32.toNat(Types.MAX_BLOCKS) - 1);
let maxLastBlock = Blob.fromArray(
    Array.tabulate<Nat8>(maxLastBytes, func(_) { 8 })
);
let maxBodies = Array.tabulate<Blob>(
    Nat32.toNat(Types.MAX_BLOCKS),
    func(index) {
        if (index + 1 == Nat32.toNat(Types.MAX_BLOCKS)) {
            maxLastBlock
        } else fullBlock;
    },
);
let maxLengths = Array.map<Blob, Nat>(
    maxBodies,
    func(body) { body.size() },
);
let maxTarget = target(22, 22, "maximum.bin");
configureBegin(
    boundaryMock,
    52,
    maxTarget,
    maxLengths,
    Types.MAX_FILE_BYTES,
);
boundaryMock.commit_batch_result := putReceipt(
    maxTarget,
    1,
    maxBodies,
);
var maxStageId : ?Nat64 = null;
var maxIndex : Nat32 = 0;
var maxEntry : ?Types.Entry = null;
while (maxIndex < Types.MAX_BLOCKS) {
    let body = maxBodies[Nat32.toNat(maxIndex)];
    let final = maxIndex + 1 == Types.MAX_BLOCKS;
    configurePut(
        boundaryMock,
        52,
        maxIndex,
        maxTarget,
        body,
        final,
        publicationId(17),
    );
    let block = writeOk(
        boundaryService.writeBlock(
            sharedRequest(
                "boundary-maximum",
                "/maximum.bin",
                maxStageId,
                maxIndex,
                Types.MAX_BLOCKS,
                Types.MAX_FILE_BYTES,
                body,
                oneEtag,
                null,
                "maximum.bin",
            )
        )
    );
    switch (block.stage_id) {
        case (?stageId) maxStageId := ?stageId;
        case null {};
    };
    if (final) maxEntry := block.entry;
    maxIndex += 1;
};
let ?maximumEntry = maxEntry else fail();
assert (maximumEntry.byte_length == ?Nat64.fromNat(Types.MAX_FILE_BYTES));
assert (boundaryMem.shared_plaintext_bytes == Types.MAX_FILE_BYTES);

// At the invariant ceiling, cleanup converts an expired stage reservation into
// a tombstone receipt in place. It remains successful and does not allocate a
// separate receipt for its own convergent maintenance request.
let laneMem = Memory.init();
let laneMock = CertifiedAssetsMock.Mock(Fixtures.zeroUsage());
var laneNow : Nat64 = 2_000;
let laneService = PlainService.Service(
    laneMem,
    laneMock.handle(),
    func() { laneNow },
);
let lanePartial = writeOk(
    laneService.writeBlock(
        workspaceRequest(
            "lane-stage",
            "/lane.bin",
            null,
            0,
            2,
            Types.BLOCK_BYTES + 1,
            fullBlock,
            zeroEtag,
            false,
        )
    )
);
let ?laneStageId = lanePartial.stage_id else fail();
let ?laneStage = Map.get(
    laneMem.plain_stages,
    Nat64.compare,
    laneStageId,
) else fail();
var laneIndex = 0;
while (
    laneIndex + 1 < Types.MAX_PLAIN_TERMINAL_RECEIPTS
) {
    let receipt : Memory.PlainTerminalReceipt = {
        fingerprint = (1, 2, 3, Nat64.fromNat(laneIndex));
        outcome = #retired_stage;
        expires_at_ns = Nat64.maxValue;
    };
    Map.add(
        laneMem.plain_terminal_receipts,
        Text.compare,
        "lane-receipt-" # Nat64.toText(Nat64.fromNat(laneIndex)),
        receipt,
    );
    laneIndex += 1;
};
assert (
    Map.size(laneMem.plain_terminal_receipts) +
        Map.size(laneMem.plain_stages) ==
        Types.MAX_PLAIN_TERMINAL_RECEIPTS
);
laneNow :=
    laneStage.modified_at_ns + Types.PLAIN_STAGE_IDLE_NS;
switch (
    laneService.cleanup({
        request_id = "lane-cleanup";
        limit = 3;
    }).outcome
) {
    case (?#ok({ changed = 1 })) {};
    case (_) assert false;
};
assert (Map.size(laneMem.plain_stages) == 0);
assert (
    Map.size(laneMem.plain_terminal_receipts) ==
        Types.MAX_PLAIN_TERMINAL_RECEIPTS
);
assert (
    Map.get(
        laneMem.plain_terminal_receipts,
        Text.compare,
        "lane-stage",
    ) != null
);
assert (
    Map.get(
        laneMem.plain_terminal_receipts,
        Text.compare,
        "lane-cleanup",
    ) == null
);
assertStatReason(
    treeService.stat({ space = ?#workspace; path = "/A" }),
    #not_found,
);
var deepPath = "/depth-root";
var deepSegments = 1;
while (deepSegments < 64) {
    deepPath #= "/d";
    deepSegments += 1;
};
switch (
    treeService.mkdir({
        request_id = "tree-deep";
        space = ?#workspace;
        path = deepPath;
        recursive = true;
    }).outcome
) {
    case (?#ok(_)) {};
    case (_) assert false;
};
switch (
    treeService.mkdir({
        request_id = "tree-destination";
        space = ?#workspace;
        path = "/depth-destination";
        recursive = false;
    }).outcome
) {
    case (?#ok(_)) {};
    case (_) assert false;
};
let deepRoot = statOk(
    treeService.stat({
        space = ?#workspace;
        path = "/depth-root";
    })
);
assertMutationReason(
    treeService.move({
        request_id = "tree-too-deep";
        space = ?#workspace;
        from = "/depth-root";
        to = "/depth-destination/depth-root";
        overwrite = false;
        expected_node_id = deepRoot.node_id;
        expected_revision = deepRoot.revision;
        if_match = null;
    }),
    #invalid_request,
);
assert (
    statOk(
        treeService.stat({
            space = ?#workspace;
            path = deepPath;
        })
    ).kind == ?#folder
);

// A valid destination at the exact 240-scalar visible Workspace boundary
// cannot receive a subtree whose descendants would cross that same boundary.
var scalarName100 = "";
var scalarIndex = 0;
while (scalarIndex < 100) {
    scalarName100 #= "x";
    scalarIndex += 1;
};
var scalarName100B = "";
scalarIndex := 0;
while (scalarIndex < 100) {
    scalarName100B #= "y";
    scalarIndex += 1;
};
var scalarName27 = "";
scalarIndex := 0;
while (scalarIndex < 27) {
    scalarName27 #= "z";
    scalarIndex += 1;
};
let scalarDestinationParent =
    "/" # scalarName100 # "/" # scalarName100B;
let scalarDestination =
    scalarDestinationParent # "/" # scalarName27;
assert (
    scalarDestination.size() ==
        Types.MAX_WORKSPACE_RELATIVE_PATH_SCALARS
);
switch (
    treeService.mkdir({
        request_id = "tree-scalar-source";
        space = ?#workspace;
        path = "/scalar-source/child";
        recursive = true;
    }).outcome
) {
    case (?#ok(_)) {};
    case (_) assert false;
};
switch (
    treeService.mkdir({
        request_id = "tree-scalar-parent";
        space = ?#workspace;
        path = scalarDestinationParent;
        recursive = true;
    }).outcome
) {
    case (?#ok(_)) {};
    case (_) assert false;
};
assertStatReason(
    treeService.stat({
        space = ?#workspace;
        path = scalarDestination;
    }),
    #not_found,
);
let scalarSource = statOk(
    treeService.stat({
        space = ?#workspace;
        path = "/scalar-source";
    })
);
assertMutationReason(
    treeService.move({
        request_id = "tree-scalar-overflow";
        space = ?#workspace;
        from = "/scalar-source";
        to = scalarDestination;
        overwrite = false;
        expected_node_id = scalarSource.node_id;
        expected_revision = scalarSource.revision;
        if_match = null;
    }),
    #invalid_request,
);
assert (
    statOk(
        treeService.stat({
            space = ?#workspace;
            path = "/scalar-source/child";
        })
    ).kind == ?#folder
);
assertStatReason(
    treeService.stat({
        space = ?#workspace;
        path = scalarDestination;
    }),
    #not_found,
);
assertStatReason(
    treeService.stat({
        space = ?#workspace;
        path = scalarDestination # "/child";
    }),
    #invalid_request,
);

// Shared has the corresponding 233-scalar backend-relative allowance.
let sharedScalarBoundary =
    "/" # scalarName100 # "/" # scalarName100B # "/" #
    scalarName27 # "zzz";
assert (
    sharedScalarBoundary.size() ==
        Types.MAX_SHARED_RELATIVE_PATH_SCALARS
);
assertStatReason(
    treeService.stat({
        space = ?#shared_;
        path = sharedScalarBoundary;
    }),
    #not_found,
);
assertStatReason(
    treeService.stat({
        space = ?#shared_;
        path = sharedScalarBoundary # "x";
    }),
    #invalid_request,
);

// Durable plain-space path identity is pinned to Unicode 16 NPSS and exact
// NFC. Invalid names fail before lookup; valid international names reach it.
assertStatReason(
    treeService.stat({
        space = ?#workspace;
        path = "/" # codePointText([0x0065, 0x0301]);
    }),
    #invalid_request,
);
assertStatReason(
    treeService.stat({
        space = ?#workspace;
        path = "/" # codePointText([0x1E0A, 0x0323]);
    }),
    #invalid_request,
);
assertStatReason(
    treeService.stat({
        space = ?#workspace;
        path = "/" # codePointText([0x105D2, 0x0307]);
    }),
    #invalid_request,
);
assertStatReason(
    treeService.stat({
        space = ?#workspace;
        path = "/" # codePointText([0x0085]);
    }),
    #invalid_request,
);
assertStatReason(
    treeService.stat({
        space = ?#workspace;
        path = "/" # codePointText([0x00A0, 0x0061]);
    }),
    #invalid_request,
);
assertStatReason(
    treeService.stat({
        space = ?#workspace;
        path = "/" # codePointText([0x0061, 0x2003]);
    }),
    #invalid_request,
);
assertStatReason(
    treeService.stat({
        space = ?#workspace;
        path = "/" # codePointText([0x0378]);
    }),
    #invalid_request,
);
assertStatReason(
    treeService.stat({
        space = ?#workspace;
        path = "/" # codePointText([0xFDD0]);
    }),
    #invalid_request,
);

assertStatReason(
    treeService.stat({
        space = ?#workspace;
        path = "/" # codePointText([0x00E9]);
    }),
    #not_found,
);
assertStatReason(
    treeService.stat({
        space = ?#workspace;
        path = "/" # codePointText([0x03A9]);
    }),
    #not_found,
);
assertStatReason(
    treeService.stat({
        space = ?#workspace;
        path = "/" # codePointText([0xAC00]);
    }),
    #not_found,
);
assertStatReason(
    treeService.stat({
        space = ?#workspace;
        path = "/" # codePointText([0x105C9]);
    }),
    #not_found,
);
assertStatReason(
    treeService.stat({
        space = ?#workspace;
        path = "/" # codePointText([0x0041, 0x0305, 0x0301]);
    }),
    #not_found,
);
assertStatReason(
    treeService.stat({
        space = ?#workspace;
        path = "/" # codePointText([0x0061, 0x00A0, 0x0062]);
    }),
    #not_found,
);
assertStatReason(
    treeService.stat({
        space = ?#workspace;
        path = "/" # codePointText([0xE000]);
    }),
    #not_found,
);
