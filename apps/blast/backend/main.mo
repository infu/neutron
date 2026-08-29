import Blob "mo:core/Blob";
import Char "mo:core/Char";
import Int "mo:core/Int";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Sha256 "mo:sha2/Sha256";
import Text "mo:core/Text";
import Time "mo:core/Time";
import Memory "./memory/blast/v1";

module {
    // These bounds cap the complete stable source library at 16 MiB. Ten
    // maximally escaped summaries also remain below the private self-call
    // protocol's 64 KiB JSON-metadata ceiling.
    public let MAX_SCRIPTS_V1 : Nat = 128;
    public let MAX_PAGE_V1 : Nat = 10;
    public let MAX_NAME_SCALARS_V1 : Nat = 120;
    public let MAX_NAME_BYTES_V1 : Nat = 480;
    public let MAX_DESCRIPTION_BYTES_V1 : Nat = 1_024;
    public let MAX_SOURCE_BYTES_V1 : Nat = 131_072;

    let SHA256_BYTES : Nat = 32;
    let MAX_NAT64 : Nat64 = 18_446_744_073_709_551_615;

    // Public wire types are deliberately concrete. The method-schema generator
    // cannot safely expand an alias to an imported persistent-memory type.
    public type ScriptV1 = {
        id : Nat64;
        revision : Nat64;
        name : Text;
        description : ?Text;
        source_utf8 : Blob;
        source_sha256 : Blob;
        source_bytes : Nat32;
        created_at_ns : Nat64;
        updated_at_ns : Nat64;
    };

    public type ScriptSummaryV1 = {
        id : Nat64;
        revision : Nat64;
        name : Text;
        description : ?Text;
        source_sha256 : Blob;
        source_bytes : Nat32;
        created_at_ns : Nat64;
        updated_at_ns : Nat64;
    };

    public type ScriptCursorV1 = {
        after_id : Nat64;
        library_revision : Nat64;
    };

    public type ScriptListRequestV1 = {
        cursor : ?ScriptCursorV1;
        limit : Nat;
    };

    public type ScriptListPageV1 = {
        library_revision : Nat64;
        scripts : [ScriptSummaryV1];
        total : Nat32;
        total_source_bytes : Nat64;
        next_cursor : ?ScriptCursorV1;
    };

    public type ScriptIdRequestV1 = {
        id : Nat64;
    };

    // source_utf8 is a Candid binary sidecar and must contain exact UTF-8.
    public type ScriptSaveRequestV1 = {
        id : ?Nat64;
        expected_revision : ?Nat64;
        name : Text;
        description : ?Text;
        source_utf8 : Blob;
    };

    public type ScriptDeleteRequestV1 = {
        id : Nat64;
        expected_revision : Nat64;
    };

    public type ScriptSaveSuccessV1 = {
        library_revision : Nat64;
        total_source_bytes : Nat64;
        script : ScriptSummaryV1;
    };

    public type ScriptDeleteSuccessV1 = {
        id : Nat64;
        deleted_revision : Nat64;
        source_sha256 : Blob;
        library_revision : Nat64;
        total_source_bytes : Nat64;
    };

    // Rejections never echo caller-controlled text or source bytes.
    public type ScriptRejectionV1 = {
        #invalid_request;
        #invalid_name;
        #invalid_description;
        #invalid_source;
        #not_found;
        #revision_conflict : {
            expected : Nat64;
            actual : Nat64;
        };
        #cursor_stale : {
            expected_library_revision : Nat64;
            actual_library_revision : Nat64;
        };
        #script_limit;
        #capacity_exhausted;
        #clock_regressed;
        #corrupt_state;
    };

    // API-1 self calls interpret a top-level Candid #ok/#err as transport
    // status. Nesting the closed outcome in a record preserves domain errors as
    // ordinary fulfilled responses.
    public type ScriptListResponseV1 = {
        outcome : ?{
            #ok : ScriptListPageV1;
            #rejected : ScriptRejectionV1;
        };
    };

    public type ScriptGetResponseV1 = {
        outcome : ?{
            #ok : ScriptV1;
            #rejected : ScriptRejectionV1;
        };
    };

    public type ScriptSaveResponseV1 = {
        outcome : ?{
            #ok : ScriptSaveSuccessV1;
            #rejected : ScriptRejectionV1;
        };
    };

    public type ScriptDeleteResponseV1 = {
        outcome : ?{
            #ok : ScriptDeleteSuccessV1;
            #rejected : ScriptRejectionV1;
        };
    };

    public type AppBackendEnvironment = {
        stable_memory : {
            blast : Memory.Mem;
        };
    };

    type ScriptStoreApiV1 = {
        list : ScriptListRequestV1 -> ScriptListResponseV1;
        get : ScriptIdRequestV1 -> ScriptGetResponseV1;
        save : ScriptSaveRequestV1 -> ScriptSaveResponseV1;
        delete : ScriptDeleteRequestV1 -> ScriptDeleteResponseV1;
    };

    func hasUnsafeMetadataControls(value : Text) : Bool {
        for (char in value.chars()) {
            let code = Char.toNat32(char);
            if (
                code < 32 or
                (code >= 127 and code <= 159) or
                (code >= 0x200B and code <= 0x200F) or
                (code >= 0x202A and code <= 0x202E) or
                (code >= 0x2060 and code <= 0x206F) or
                code == 0xFEFF
            ) return true;
        };
        false;
    };

    // Match ECMAScript String.prototype.trim at the browser/backend boundary.
    // Controls that are unsafe anywhere remain covered above; the remaining
    // Unicode whitespace is rejected only at the two metadata boundaries.
    func isEcmaTrimWhitespace(char : Char) : Bool {
        let code = Char.toNat32(char);
        code == 0x0009 or
        code == 0x000A or
        code == 0x000B or
        code == 0x000C or
        code == 0x000D or
        code == 0x0020 or
        code == 0x00A0 or
        code == 0x1680 or
        (code >= 0x2000 and code <= 0x200A) or
        code == 0x2028 or
        code == 0x2029 or
        code == 0x202F or
        code == 0x205F or
        code == 0x3000 or
        code == 0xFEFF;
    };

    func hasTrimBoundaryWhitespace(value : Text) : Bool {
        var first = true;
        var trailingWhitespace = false;
        for (char in value.chars()) {
            let whitespace = isEcmaTrimWhitespace(char);
            if (first and whitespace) return true;
            first := false;
            trailingWhitespace := whitespace;
        };
        trailingWhitespace;
    };

    func validName(value : Text) : Bool {
        value.size() > 0 and
        value.size() <= MAX_NAME_SCALARS_V1 and
        Text.encodeUtf8(value).size() <= MAX_NAME_BYTES_V1 and
        not hasTrimBoundaryWhitespace(value) and
        not hasUnsafeMetadataControls(value);
    };

    func validOptionalDescription(value : ?Text) : Bool {
        switch (value) {
            case null true;
            case (?text) {
                text.size() > 0 and
                Text.encodeUtf8(text).size() <= MAX_DESCRIPTION_BYTES_V1 and
                not hasTrimBoundaryWhitespace(text) and
                not hasUnsafeMetadataControls(text);
            };
        };
    };

    func validSource(value : Blob) : Bool {
        if (value.size() == 0 or value.size() > MAX_SOURCE_BYTES_V1) return false;
        switch (Text.decodeUtf8(value)) {
            case null false;
            case (?_) true;
        };
    };

    func sourceDigest(source : Blob) : Blob {
        Sha256.fromBlob(#sha256, source);
    };

    func validStoredShape(script : Memory.Script) : Bool {
        validName(script.name) and
        validOptionalDescription(script.description) and
        script.source_utf8.size() > 0 and
        script.source_utf8.size() <= MAX_SOURCE_BYTES_V1 and
        Nat32.toNat(script.source_bytes) == script.source_utf8.size() and
        script.source_sha256.size() == SHA256_BYTES and
        script.created_at_ns > 0 and
        script.updated_at_ns >= script.created_at_ns;
    };

    func validStoredExact(script : Memory.Script) : Bool {
        validStoredShape(script) and
        validSource(script.source_utf8) and
        Blob.equal(script.source_sha256, sourceDigest(script.source_utf8));
    };

    func validateMemoryV1(mem : Memory.Mem) : Bool {
        if (
            mem.next_script_id == 0 or
            Map.size(mem.scripts) > MAX_SCRIPTS_V1 or
            mem.library_revision < mem.next_script_id - 1
        ) return false;
        var sourceBytes : Nat64 = 0;
        for ((id, script) in Map.entries(mem.scripts)) {
            if (
                id == 0 or
                id >= mem.next_script_id or
                id != script.id or
                script.revision == 0 or
                script.revision > mem.library_revision or
                not validStoredExact(script)
            ) return false;
            sourceBytes += Nat.toNat64(Nat32.toNat(script.source_bytes));
        };
        sourceBytes == mem.total_source_bytes;
    };

    // The injected clock makes the stable state machine deterministic in unit
    // tests. Only Init's four annotated methods become app actor methods.
    public class ScriptStoreV1(mem : Memory.Mem, nowNs : () -> Nat64) {
        // Managed memory is restored before this class is constructed. Validate
        // that retained root once, then preserve its invariants incrementally;
        // ordinary CRUD must not rehash the complete saved-source library.
        let restoredStateValid : Bool = validateMemoryV1(mem);

        public func list(request : ScriptListRequestV1) : ScriptListResponseV1 {
            if (request.limit == 0 or request.limit > MAX_PAGE_V1) {
                return listRejected(#invalid_request);
            };
            if (not restoredStateValid) return listRejected(#corrupt_state);

            switch (request.cursor) {
                case (?cursor) {
                    if (cursor.after_id == 0) return listRejected(#invalid_request);
                    if (cursor.library_revision != mem.library_revision) {
                        return listRejected(#cursor_stale({
                            expected_library_revision = cursor.library_revision;
                            actual_library_revision = mem.library_revision;
                        }));
                    };
                    switch (
                        Map.get(mem.scripts, Nat64.compare, cursor.after_id)
                    ) {
                        case null {
                            return listRejected(#cursor_stale({
                                expected_library_revision = cursor.library_revision;
                                actual_library_revision = mem.library_revision;
                            }));
                        };
                        case (?_) {};
                    };
                };
                case null {};
            };

            let iterator = switch (request.cursor) {
                case null Map.entries(mem.scripts);
                case (?cursor) {
                    Map.entriesFrom(
                        mem.scripts,
                        Nat64.compare,
                        cursor.after_id,
                    );
                };
            };
            let selected = List.empty<ScriptSummaryV1>();
            var skipInclusive = switch (request.cursor) {
                case null false;
                case (?_) true;
            };
            var hasMore = false;
            var lastId : ?Nat64 = null;

            label scan for ((id, script) in iterator) {
                if (skipInclusive) {
                    skipInclusive := false;
                    switch (request.cursor) {
                        case (?cursor) {
                            if (id == cursor.after_id) continue scan;
                            return listRejected(#corrupt_state);
                        };
                        case null return listRejected(#corrupt_state);
                    };
                };
                if (List.size(selected) >= request.limit) {
                    hasMore := true;
                    break scan;
                };
                List.add(selected, summarize(script));
                lastId := ?id;
            };

            let nextCursor = if (hasMore) {
                switch (lastId) {
                    case (?afterId) ?{
                        after_id = afterId;
                        library_revision = mem.library_revision;
                    };
                    case null return listRejected(#corrupt_state);
                };
            } else null;
            {
                outcome = ?#ok({
                    library_revision = mem.library_revision;
                    scripts = List.toArray(selected);
                    total = Nat.toNat32(Map.size(mem.scripts));
                    total_source_bytes = mem.total_source_bytes;
                    next_cursor = nextCursor;
                });
            };
        };

        public func get(request : ScriptIdRequestV1) : ScriptGetResponseV1 {
            if (request.id == 0) return getRejected(#invalid_request);
            if (not restoredStateValid) return getRejected(#corrupt_state);
            let ?script = Map.get(mem.scripts, Nat64.compare, request.id) else {
                return getRejected(#not_found);
            };
            { outcome = ?#ok(toWire(script)) };
        };

        public func save(request : ScriptSaveRequestV1) : ScriptSaveResponseV1 {
            if (not restoredStateValid) return saveRejected(#corrupt_state);
            let target = switch (request.id, request.expected_revision) {
                case (null, null) #create;
                case (?id, ?expectedRevision) {
                    if (id == 0 or expectedRevision == 0) {
                        return saveRejected(#invalid_request);
                    };
                    #replace({ id; expected_revision = expectedRevision });
                };
                case (_) return saveRejected(#invalid_request);
            };
            if (not validName(request.name)) return saveRejected(#invalid_name);
            if (not validOptionalDescription(request.description)) {
                return saveRejected(#invalid_description);
            };
            if (not validSource(request.source_utf8)) {
                return saveRejected(#invalid_source);
            };
            if (mem.library_revision == MAX_NAT64) {
                return saveRejected(#capacity_exhausted);
            };

            let current : ?Memory.Script = switch (target) {
                case (#create) null;
                case (#replace(replacement)) {
                    let ?existing = Map.get(
                        mem.scripts,
                        Nat64.compare,
                        replacement.id,
                    ) else {
                        return saveRejected(#not_found);
                    };
                    if (existing.revision != replacement.expected_revision) {
                        return saveRejected(#revision_conflict({
                            expected = replacement.expected_revision;
                            actual = existing.revision;
                        }));
                    };
                    ?existing;
                };
            };

            switch (target) {
                case (#create) {
                    if (Map.size(mem.scripts) >= MAX_SCRIPTS_V1) {
                        return saveRejected(#script_limit);
                    };
                };
                case (#replace(_)) {};
            };

            let id : Nat64 = switch (request.id) {
                case (?existingId) existingId;
                case null {
                    if (mem.next_script_id == MAX_NAT64) {
                        return saveRejected(#capacity_exhausted);
                    };
                    mem.next_script_id;
                };
            };
            let revision : Nat64 = switch (current) {
                case null 1 : Nat64;
                case (?existing) {
                    if (existing.revision == MAX_NAT64) {
                        return saveRejected(#capacity_exhausted);
                    };
                    existing.revision + 1;
                };
            };
            let now = currentTime(nowNs);
            let createdAt = switch (current) {
                case null now;
                case (?existing) existing.created_at_ns;
            };
            let updatedAt = switch (current) {
                case null now;
                case (?existing) {
                    if (now < existing.updated_at_ns) {
                        return saveRejected(#clock_regressed);
                    };
                    if (now > existing.updated_at_ns) {
                        now;
                    } else {
                        if (existing.updated_at_ns == MAX_NAT64) {
                            return saveRejected(#capacity_exhausted);
                        };
                        existing.updated_at_ns + 1;
                    };
                };
            };
            let sourceBytes = Nat.toNat32(request.source_utf8.size());
            let previousBytes : Nat64 = switch (current) {
                case null 0 : Nat64;
                case (?existing) Nat.toNat64(Nat32.toNat(existing.source_bytes));
            };
            if (previousBytes > mem.total_source_bytes) {
                return saveRejected(#corrupt_state);
            };
            let projectedSourceBytes : Nat64 = mem.total_source_bytes - previousBytes +
                Nat.toNat64(Nat32.toNat(sourceBytes));
            let sourceSha256 = sourceDigest(request.source_utf8);
            let script : Memory.Script = {
                id;
                revision;
                name = request.name;
                description = request.description;
                source_utf8 = request.source_utf8;
                source_sha256 = sourceSha256;
                source_bytes = sourceBytes;
                created_at_ns = createdAt;
                updated_at_ns = updatedAt;
            };

            Map.add(mem.scripts, Nat64.compare, id, script);
            switch (target) {
                case (#create) mem.next_script_id += 1;
                case (#replace(_)) {};
            };
            mem.total_source_bytes := projectedSourceBytes;
            mem.library_revision += 1;
            {
                outcome = ?#ok({
                    library_revision = mem.library_revision;
                    total_source_bytes = mem.total_source_bytes;
                    script = summarize(script);
                });
            };
        };

        public func delete(request : ScriptDeleteRequestV1) : ScriptDeleteResponseV1 {
            if (request.id == 0 or request.expected_revision == 0) {
                return deleteRejected(#invalid_request);
            };
            if (not restoredStateValid) return deleteRejected(#corrupt_state);
            let ?script = Map.get(mem.scripts, Nat64.compare, request.id) else {
                return deleteRejected(#not_found);
            };
            if (script.revision != request.expected_revision) {
                return deleteRejected(#revision_conflict({
                    expected = request.expected_revision;
                    actual = script.revision;
                }));
            };
            if (mem.library_revision == MAX_NAT64) {
                return deleteRejected(#capacity_exhausted);
            };
            let sourceBytes = Nat.toNat64(Nat32.toNat(script.source_bytes));
            if (sourceBytes > mem.total_source_bytes) {
                return deleteRejected(#corrupt_state);
            };

            Map.remove(mem.scripts, Nat64.compare, request.id);
            mem.total_source_bytes -= sourceBytes;
            mem.library_revision += 1;
            {
                outcome = ?#ok({
                    id = script.id;
                    deleted_revision = script.revision;
                    source_sha256 = script.source_sha256;
                    library_revision = mem.library_revision;
                    total_source_bytes = mem.total_source_bytes;
                });
            };
        };
    };

    public class Init(env : AppBackendEnvironment) {
        let scripts : ScriptStoreApiV1 = ScriptStoreV1(
            env.stable_memory.blast,
            systemTimeNs,
        );

        public func /*query*/blast_scripts_list_v1(
            request : ScriptListRequestV1
        ) : ScriptListResponseV1 {
            scripts.list(request);
        };

        public func /*query*/blast_script_get_v1(
            request : ScriptIdRequestV1
        ) : ScriptGetResponseV1 {
            scripts.get(request);
        };

        public func /*update*/blast_script_save_v1(
            request : ScriptSaveRequestV1
        ) : ScriptSaveResponseV1 {
            scripts.save(request);
        };

        public func /*update*/blast_script_delete_v1(
            request : ScriptDeleteRequestV1
        ) : ScriptDeleteResponseV1 {
            scripts.delete(request);
        };
    };

    public func validMemoryV1(mem : Memory.Mem) : Bool {
        validateMemoryV1(mem);
    };

    func summarize(script : Memory.Script) : ScriptSummaryV1 {
        {
            id = script.id;
            revision = script.revision;
            name = script.name;
            description = script.description;
            source_sha256 = script.source_sha256;
            source_bytes = script.source_bytes;
            created_at_ns = script.created_at_ns;
            updated_at_ns = script.updated_at_ns;
        };
    };

    func toWire(script : Memory.Script) : ScriptV1 {
        {
            id = script.id;
            revision = script.revision;
            name = script.name;
            description = script.description;
            source_utf8 = script.source_utf8;
            source_sha256 = script.source_sha256;
            source_bytes = script.source_bytes;
            created_at_ns = script.created_at_ns;
            updated_at_ns = script.updated_at_ns;
        };
    };

    func currentTime(nowNs : () -> Nat64) : Nat64 {
        let now = nowNs();
        if (now == 0) 1 else now;
    };

    func systemTimeNs() : Nat64 {
        Nat.toNat64(Int.abs(Time.now()));
    };

    func listRejected(reason : ScriptRejectionV1) : ScriptListResponseV1 {
        { outcome = ?#rejected(reason) };
    };

    func getRejected(reason : ScriptRejectionV1) : ScriptGetResponseV1 {
        { outcome = ?#rejected(reason) };
    };

    func saveRejected(reason : ScriptRejectionV1) : ScriptSaveResponseV1 {
        { outcome = ?#rejected(reason) };
    };

    func deleteRejected(reason : ScriptRejectionV1) : ScriptDeleteResponseV1 {
        { outcome = ?#rejected(reason) };
    };

/*---NEUTRON GENERATED BEGIN---*/

public type blast_scripts_list_v1_Input = (request : ScriptListRequestV1);
public type blast_scripts_list_v1_Output = ScriptListResponseV1;

public type blast_script_get_v1_Input = (request : ScriptIdRequestV1);
public type blast_script_get_v1_Output = ScriptGetResponseV1;

public type blast_script_save_v1_Input = (request : ScriptSaveRequestV1);
public type blast_script_save_v1_Output = ScriptSaveResponseV1;

public type blast_script_delete_v1_Input = (request : ScriptDeleteRequestV1);
public type blast_script_delete_v1_Output = ScriptDeleteResponseV1;

/*---NEUTRON GENERATED END---*/
};
