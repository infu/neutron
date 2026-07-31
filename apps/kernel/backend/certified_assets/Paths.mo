import Blob "mo:core/Blob";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Text "mo:core/Text";
import CapabilityScope "../capabilities/Scope";
import CertV2 "../certified_http_v2";
import RouteNamespace "../http_routes/Namespace";
import Codec "Codec";
import Types "Types";

module {
    public func validFilename(value : Text) : Bool {
        let length = value.size();
        if (length < 1 or length > 100 or value == "." or value == "..") {
            return false;
        };
        for (char in value.chars()) {
            if (not (
                (char >= 'a' and char <= 'z') or
                (char >= 'A' and char <= 'Z') or
                (char >= '0' and char <= '9') or
                char == '.' or char == '_' or char == '-'
            )) return false;
        };
        true;
    };

    public func validCollectionId(value : Text) : Bool {
        RouteNamespace.validMountId(value);
    };

    public func publicationId(
        salt : Blob,
        canisterId : Text,
        scope : Types.AppScope,
        collection : Text,
        collectionGeneration : Nat64,
        publicationGeneration : Nat64,
        beginNonce : Blob,
    ) : ?Blob {
        if (
            salt.size() != 32 or canisterId.size() < 1 or
            canisterId.size() > 100 or beginNonce.size() != 16 or
            collectionGeneration == 0 or publicationGeneration == 0 or
            not CapabilityScope.valid(scope) or not validCollectionId(collection)
        ) return null;
        ?Codec.sha256Chunks([
            Codec.lpText("neutron.certified-assets.publication-id.v1"),
            Codec.lpBlob(salt),
            Codec.lpText(canisterId),
            Codec.lpText(scope.app_id),
            Codec.u64be(scope.installation_uid),
            Codec.lpText(collection),
            Codec.u64be(collectionGeneration),
            Codec.u64be(publicationGeneration),
            Codec.lpBlob(beginNonce),
        ]);
    };

    public func targetPath(
        mount : Types.CommittedMount,
        collection : Types.CollectionPlan,
        target : Types.Target,
    ) : ?Text {
        if (
            target.collection != collection.id or
            target.collection_generation != collection.generation or
            collection.mount != mount.id or
            (
                collection.kind == #publication and
                mount.authority_mode != #exact_neutron_host_v1
            ) or
            (
                collection.kind != #publication and
                mount.authority_mode != #canister_gateway_v1
            )
        ) return null;
        let suffix = switch (collection.kind, target.locator) {
            case (#publication, #publication(locator)) {
                if (
                    locator.publication_id.size() != 32 or
                    not validFilename(locator.filename)
                ) return null;
                "/" # Codec.hex(locator.publication_id) # "/" # locator.filename;
            };
            case (#immutable_blob, #body_sha256(locator)) {
                if (locator.digest.size() != 32) return null;
                let ?prefix = collection.path_prefix else return null;
                prefix # Codec.hex(locator.digest);
            };
            case (#mutable_blob, #key32(locator)) {
                if (locator.key.size() != 32) return null;
                let ?prefix = collection.path_prefix else return null;
                prefix # Codec.hex(locator.key);
            };
            case (#mutable_blob, #exact_path) {
                let ?path = collection.exact_path else return null;
                path;
            };
            case (_) return null;
        };
        let path = mount.prefix # suffix;
        if (
            not RouteNamespace.validAbsolutePath(path) or
            not CertV2.validCanonicalPath(path)
        ) return null;
        ?path;
    };

    public func validCollection(
        storeLimits : Types.Limits,
        mount : Types.CommittedMount,
        authored : Types.CollectionDeclaration,
    ) : Bool {
        if (
            not validCollectionId(authored.id) or authored.mount != mount.id or
            authored.generation == 0 or authored.authority_epoch == 0 or
            authored.authority_epoch != mount.authority_epoch
        ) return false;
        let maximum = switch (authored.max_object_bytes) {
            case (?value) value;
            case null storeLimits.object_bytes;
        };
        if (maximum < 1 or maximum > storeLimits.object_bytes) return false;
        let validKind = switch (authored.kind) {
            case (#publication) {
                authored.path_prefix == null and authored.exact_path == null and
                mount.authority_mode == #exact_neutron_host_v1;
            };
            case (#immutable_blob) {
                validPrefix(authored.path_prefix) and authored.exact_path == null and
                mount.authority_mode == #canister_gateway_v1;
            };
            case (#mutable_blob) {
                (
                    (
                        validPrefix(authored.path_prefix) and
                        authored.exact_path == null
                    ) or (
                        authored.path_prefix == null and
                        validExact(authored.exact_path)
                    )
                ) and
                mount.authority_mode == #canister_gateway_v1;
            };
        };
        validKind and collectionFitsCertifiedProof(mount, authored);
    };

    public func collectionsOverlap(
        left : Types.CollectionDeclaration,
        right : Types.CollectionDeclaration,
    ) : Bool {
        if (left.mount != right.mount) return false;
        let leftRange = pathRange(left);
        let rightRange = pathRange(right);
        switch (leftRange, rightRange) {
            case (?(#prefix(a)), ?(#prefix(b))) prefixesOverlap(a, b);
            case (?(#prefix(a)), ?(#exact(b))) pathInPrefix(b, a);
            case (?(#exact(a)), ?(#prefix(b))) pathInPrefix(a, b);
            case (?(#exact(a)), ?(#exact(b))) a == b;
            case (_) false;
        };
    };

    public func collectionFingerprint(
        declaration : Types.CollectionDeclaration,
        storeObjectMaximum : Nat,
    ) : Blob {
        Codec.sha256Chunks([
            Codec.lpText("neutron.certified-assets.collection.v1"),
            Codec.lpText(declaration.id),
            Codec.lpText(declaration.mount),
            Codec.lpText(collectionKindText(declaration.kind)),
            Codec.lpText(optionText(declaration.path_prefix)),
            Codec.lpText(optionText(declaration.exact_path)),
            Codec.u64be(Nat64.fromNat(
                switch (declaration.max_object_bytes) {
                    case (?value) value;
                    case null storeObjectMaximum;
                }
            )),
            Codec.u64be(declaration.authority_epoch),
            Codec.u64be(declaration.generation),
        ]);
    };

    public func mountFingerprint(
        scope : Types.AppScope,
        id : Text,
        prefix : Text,
        authority : Types.AuthorityMode,
        authorityEpoch : Nat64,
    ) : Blob {
        Codec.sha256Chunks([
            Codec.lpText("neutron.certified-assets.mount.v1"),
            Codec.lpText(scope.app_id),
            Codec.u64be(scope.installation_uid),
            Codec.lpText(id),
            Codec.lpText(prefix),
            Codec.lpText(authorityText(authority)),
            Codec.u64be(authorityEpoch),
        ]);
    };

    func pathRange(
        declaration : Types.CollectionDeclaration,
    ) : ?{ #prefix : Text; #exact : Text } {
        switch (declaration.kind) {
            case (#publication) ?#prefix("/");
            case (#immutable_blob) {
                switch (declaration.path_prefix) {
                    case (?value) ?#prefix(value);
                    case null null;
                };
            };
            case (#mutable_blob) {
                switch (declaration.path_prefix, declaration.exact_path) {
                    case (?prefix, null) ?#prefix(prefix);
                    case (null, ?path) ?#exact(path);
                    case (_) null;
                };
            };
        };
    };

    func validPrefix(value : ?Text) : Bool {
        let ?path = value else return false;
        if (
            path.size() < 2 or path.size() > 256 or
            not Text.endsWith(path, #char '/')
        ) return false;
        let ?withoutSlash = Text.stripEnd(path, #char '/') else return false;
        validCollectionPath(withoutSlash);
    };

    func validExact(value : ?Text) : Bool {
        let ?path = value else return false;
        path.size() >= 2 and path.size() <= 256 and
        not Text.endsWith(path, #char '/') and validCollectionPath(path);
    };

    // This mirrors the compiler's closed certified-collection path grammar.
    // Keeping the authoritative backend check local avoids inheriting the
    // broader static-route grammar (uppercase and longer paths included).
    func validCollectionPath(path : Text) : Bool {
        if (
            not Text.startsWith(path, #char '/') or
            Text.endsWith(path, #char '/') or
            Text.contains(path, #text "//")
        ) return false;
        var segments = 0;
        for (segment in Text.split(path, #char '/')) {
            if (segment != "") {
                if (segment == "." or segment == "..") return false;
                for (char in segment.chars()) {
                    if (not (
                        (char >= 'a' and char <= 'z') or
                        (char >= '0' and char <= '9') or char == '.' or
                        char == '_' or char == '~' or char == '-'
                    )) return false;
                };
                segments += 1;
            };
        };
        segments > 0;
    };

    let SAMPLE_SHA256_HEX =
        "0000000000000000000000000000000000000000000000000000000000000000";

    // The response-certification witness has a fixed path-depth bound. Check
    // the derived route shape at install time, before any target can be stored.
    func collectionFitsCertifiedProof(
        mount : Types.CommittedMount,
        collection : Types.CollectionDeclaration,
    ) : Bool {
        let candidate = switch (collection.kind) {
            case (#publication) mount.prefix # "/" # SAMPLE_SHA256_HEX # "/x";
            case (#immutable_blob) {
                let ?prefix = collection.path_prefix else return false;
                mount.prefix # prefix # SAMPLE_SHA256_HEX;
            };
            case (#mutable_blob) {
                switch (collection.path_prefix, collection.exact_path) {
                    case (?prefix, null) {
                        mount.prefix # prefix # SAMPLE_SHA256_HEX;
                    };
                    case (null, ?path) mount.prefix # path;
                    case (_) return false;
                };
            };
        };
        CertV2.validCanonicalPath(candidate);
    };

    func prefixesOverlap(left : Text, right : Text) : Bool {
        pathInPrefix(left, right) or pathInPrefix(right, left);
    };

    func pathInPrefix(path : Text, prefix : Text) : Bool {
        prefix == "/" or path == prefix or Text.startsWith(path, #text prefix);
    };

    func collectionKindText(value : Types.CollectionKind) : Text {
        switch (value) {
            case (#publication) "publication";
            case (#immutable_blob) "immutable_blob";
            case (#mutable_blob) "mutable_blob";
        };
    };

    func authorityText(value : Types.AuthorityMode) : Text {
        switch (value) {
            case (#exact_neutron_host_v1) "exact_neutron_host_v1";
            case (#canister_gateway_v1) "canister_gateway_v1";
        };
    };

    func optionText(value : ?Text) : Text {
        switch (value) { case (?text) text; case null "" };
    };
};
