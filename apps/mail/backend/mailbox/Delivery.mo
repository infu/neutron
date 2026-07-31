import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Int "mo:core/Int";
import Int64 "mo:core/Int64";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat16 "mo:core/Nat16";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Set "mo:core/Set";
import Text "mo:core/Text";
import Capabilities "../capabilities/Types";
import Memory "../memory/mail/v1";
import DeliveryHash "../protocol/DeliveryHash";
import Envelope "../protocol/Envelope";
import KeyInfo "../protocol/KeyInfo";
import RemoteWire "../protocol/RemoteWire";
import Accounting "./Accounting";
import Store "./Store";

module {
    public let MAX_LIVE_PERMITS = 64;
    public let PERMIT_REQUEST_ID_BYTES = 16;
    public let PERMIT_ID_BYTES = 32;
    public let COMMAND_ID_BYTES = 16;
    public let RETRY_REQUEST_ID_BYTES = 16;
    public let PUBLIC_INFO_HASH_BYTES = 32;
    // Frozen V1 recovery boundary. A durable #sending record can outlive its
    // await continuation across an upgrade. Before this age a distinct retry
    // click coalesces with the genuinely in-flight attempt; at or after it a
    // new retry request id may dispatch the exact stored envelope again.
    public let SENDING_RECOVERY_TIMEOUT_NS : Int = 300_000_000_000;

    // One compiler-owned endpoint carries Mail's closed V1 protocol. The
    // target kernel still admits, meters, and audits each route independently.
    let MAIL_INGRESS_METHOD = "app_mail__mail_v1_update";
    let KEY_INFO_ROUTE = "key_info";
    let RECEIVE_ROUTE = "receive";
    // Frozen Mail V1 protocol prices. Keep these exact values aligned with
    // the recipient routes' `required_cycles` declarations. The kernel-owned
    // backend-call broker bounds and accounts each transfer; Mail never gains
    // access to a raw cycle primitive.
    public let KEY_INFO_REQUIRED_CYCLES : Nat = 50_000_000;
    public let RECEIVE_REQUIRED_CYCLES : Nat = 250_000_000;
    let PERMIT_TTL_NS : Int = 300_000_000_000;
    let OUTBOX_COUNT_LIMIT = 1_000;
    let OUTBOX_BYTE_LIMIT = 12_582_912;
    let RETRY_TOMBSTONE_LIMIT = 2_048;
    let MAX_TIMESTAMP : Int = 9_223_372_036_854_775_807;

    public type ContactMatch = {
        contact_id : Nat;
        contact_revision : Nat;
        principal : Principal;
    };

    public type ContactLookup = {
        book_revision : Nat;
        integrity_ok : Bool;
        match : ?ContactMatch;
    };

    public type Recipient = {
        #direct : { principal : Principal };
        #contact : {
            principal : Principal;
            contact_id : Nat;
            expected_contact_revision : Nat;
        };
    };

    // The browser supplies this CSPRNG-generated request id because application
    // backends do not have app-local randomness. It is owner-call input only
    // and exactly 16 bytes. The backend mixes it with a durable monotonic
    // generation to issue a distinct opaque permit id.
    public type PrepareRequest = {
        recipient : Recipient;
        permit_request_id : Blob;
    };

    public type MailKeyInfoV1 = RemoteWire.MailKeyInfoV1;
    public type MailKeyInfoResultV1 = RemoteWire.MailKeyInfoResultV1;

    public type PreparedRecipient = {
        permit_id : Blob;
        recipient : Principal;
        contact_id : ?Nat;
        contact_revision : ?Nat;
        book_revision : Nat;
        expires_at_ns : Int;
        public_info_hash : Blob;
        key_info : MailKeyInfoV1;
    };

    public type SendEncryptedRequest = {
        command_id : Blob;
        permit_id : Blob;
        recipient : Principal;
        public_info_hash : Blob;
        envelope : Blob;
        local_wrap_epoch : Nat64;
        local_wrap_fingerprint : Blob;
        local_wrapped_cek : Blob;
    };

    public type RetryRequest = {
        local_id : Nat;
        retry_request_id : Blob;
    };

    public type DeliveryView = {
        local_id : Nat;
        mail_revision : Nat;
        cleanup_epoch : Nat;
        attempt_no : Nat;
        state : Memory.OutboxState;
        updated_at_ns : Int;
    };

    public type DeliveryError = {
        #invalid_request;
        #permission_required;
        #recipient_unavailable;
        #recipient_changed;
        #permit_capacity;
        #permit_request_reused;
        #permit_missing;
        #permit_expired;
        #permit_mismatch;
        #mailbox_full;
        #crypto_unavailable;
        #command_conflict;
        #command_deleted : { local_id : Nat };
        #not_found;
        #not_retryable;
        #retry_deleted;
        #attempt_superseded;
        #clock_invalid;
        #corrupt_state;
    };

    public type Result<T> = {
        #ok : T;
        #err : DeliveryError;
    };

    public type Binding = {
        recipient : Principal;
        contact_id : ?Nat;
        contact_revision : ?Nat;
        book_revision : Nat;
    };

    public type AttemptOrigin = {
        #command : Blob;
        #retry : Blob;
    };

    type PermitPlan = {
        discard_keys : [Text];
        live_count : Nat;
    };

    // These bounded dispatch records split state commit from transport. The
    // production wrappers immediately execute them; deterministic Motoko tests
    // can exercise the same pre/post-await transitions without an IC runtime.
    public type PrepareDispatch = {
        call : Capabilities.CallRequest;
        binding : Binding;
        permit_request_id : Blob;
        permit_id : Blob;
        started_at_ns : Int;
        cleanup_epoch : Nat;
    };

    public type DeliveryDispatch = {
        call : Capabilities.CallRequest;
        local_id : Nat;
        message_id : Blob;
        cleanup_epoch : Nat;
        attempt_no : Nat;
        origin : AttemptOrigin;
    };

    public type StartDelivery = {
        #complete : DeliveryView;
        #dispatch : DeliveryDispatch;
    };

    public class Service(
        mem : Memory.Mem,
        selfCanister : Principal,
        calls : Capabilities.BackendCalls,
        lookupContact : Principal -> ContactLookup,
        now : () -> Int,
    ) {
        public func prepareRecipient(request : PrepareRequest) : async* Result<PreparedRecipient> {
            let dispatch = switch (prepareStart(request)) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            let remote = await* calls.call(dispatch.call);
            prepareFinish(dispatch, remote);
        };

        public func prepareStart(request : PrepareRequest) : Result<PrepareDispatch> {
            if (
                request.permit_request_id.size() != PERMIT_REQUEST_ID_BYTES or
                isZero(request.permit_request_id)
            ) {
                return #err(#invalid_request);
            };
            if (not Store.validMemory(mem)) return #err(#corrupt_state);
            let binding = switch (resolveBinding(request.recipient)) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            if (not validRecipient(binding.recipient, selfCanister)) {
                return #err(#invalid_request);
            };
            if (not reservationsReady(binding.recipient)) {
                return #err(#permission_required);
            };

            let startedAt = now();
            if (not validTimestamp(startedAt)) return #err(#clock_invalid);
            let initialPlan = switch (planPermits(startedAt)) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            applyPermitPlan(initialPlan);
            let permitId = generatedPermitId(
                request.permit_request_id,
                mem.next_permit_generation,
                selfCanister,
            );
            let permitKey = hex(permitId);
            if (Map.containsKey(mem.permits, Text.compare, permitKey)) {
                return #err(#permit_request_reused);
            };
            if (initialPlan.live_count >= MAX_LIVE_PERMITS) {
                return #err(#permit_capacity);
            };
            let startingCleanupEpoch = mem.cleanup_epoch;
            // Allocate before the await. Failed or superseded preparations burn
            // a generation, which is intentional: no later preparation can
            // recreate a permit id that an old encrypted command referenced.
            mem.next_permit_generation += 1;
            #ok({
                call = {
                    canister = binding.recipient;
                    method = MAIL_INGRESS_METHOD;
                    // `mail_key_info_v1` has one explicit unit parameter.
                    // A bare `to_candid ()` encodes an empty argument list,
                    // which the real Neutron endpoint rejects before Mail can
                    // read its public key. The singleton tuple preserves the
                    // endpoint's exact Candid shape.
                    args = publicIngressArgs(KEY_INFO_ROUTE, to_candid ((),));
                    cycles = KEY_INFO_REQUIRED_CYCLES;
                };
                binding;
                permit_request_id = request.permit_request_id;
                permit_id = permitId;
                started_at_ns = startedAt;
                cleanup_epoch = startingCleanupEpoch;
            });
        };

        public func prepareFinish(
            dispatch : PrepareDispatch,
            remote : Capabilities.CallResult,
        ) : Result<PreparedRecipient> {
            let keyInfo = switch (decodeKeyInfo(remote)) {
                case null return #err(#recipient_unavailable);
                case (?value) value;
            };
            let finishedAt = now();
            if (
                not validTimestamp(finishedAt) or
                finishedAt < dispatch.started_at_ns or
                finishedAt > MAX_TIMESTAMP - PERMIT_TTL_NS
            ) return #err(#clock_invalid);
            if (
                mem.cleanup_epoch != dispatch.cleanup_epoch or
                not bindingStillExact(dispatch.binding)
            ) return #err(#recipient_changed);
            if (not reservationsReady(dispatch.binding.recipient)) {
                return #err(#permission_required);
            };

            let finalPlan = switch (planPermits(finishedAt)) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            let permitKey = hex(dispatch.permit_id);
            if (Map.containsKey(mem.permits, Text.compare, permitKey)) {
                return #err(#permit_request_reused);
            };
            if (finalPlan.live_count >= MAX_LIVE_PERMITS) {
                return #err(#permit_capacity);
            };
            let infoHash = publicInfoHash(dispatch.binding.recipient, keyInfo);
            let expiresAt = finishedAt + PERMIT_TTL_NS;
            let permit : Memory.RecipientPermit = {
                permit_id = dispatch.permit_id;
                target = dispatch.binding.recipient;
                contact_id = dispatch.binding.contact_id;
                contact_revision = dispatch.binding.contact_revision;
                book_revision = dispatch.binding.book_revision;
                suite = keyInfo.suite;
                delivery_key_epoch = keyInfo.delivery_key_epoch;
                delivery_key_fingerprint = keyInfo.recipient_key_fingerprint;
                public_info_hash = infoHash;
                cleanup_epoch = dispatch.cleanup_epoch;
                expires_at_ns = expiresAt;
            };

            // Pruning and insertion are one post-await commit. Failed remote or
            // post-await checks do not partially mutate permit state.
            applyPermitPlan(finalPlan);
            Map.add(mem.permits, Text.compare, permitKey, permit);
            #ok({
                permit_id = permit.permit_id;
                recipient = permit.target;
                contact_id = permit.contact_id;
                contact_revision = permit.contact_revision;
                book_revision = permit.book_revision;
                expires_at_ns = permit.expires_at_ns;
                public_info_hash = permit.public_info_hash;
                key_info = keyInfo;
            });
        };

        public func sendEncrypted(request : SendEncryptedRequest) : async* Result<DeliveryView> {
            let dispatch = switch (sendStart(request)) {
                case (#err(error)) return #err(error);
                case (#ok(#complete(value))) return #ok(value);
                case (#ok(#dispatch(value))) value;
            };
            let remote = await* calls.call(dispatch.call);
            finishDelivery(dispatch, remote);
        };

        public func sendStart(request : SendEncryptedRequest) : Result<StartDelivery> {
            let decoded = switch (validateSendShape(request)) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            let requestFingerprint = commandFingerprint(request);
            let commandKey = hex(request.command_id);

            // Command replay deliberately precedes permits, cleanup epoch,
            // Contacts, reservation, and quota checks.
            switch (Map.get(mem.commands, Text.compare, commandKey)) {
                case (?command) {
                    if (
                        not Blob.equal(command.command_id, request.command_id) or
                        not Blob.equal(command.request_fingerprint, requestFingerprint)
                    ) return #err(#command_conflict);
                    let ?record = Map.get(mem.outbox, Nat.compare, command.local_id) else {
                        return #err(#corrupt_state);
                    };
                    if (
                        record.local_id != command.local_id or
                        not Blob.equal(record.command_id, request.command_id) or
                        not Blob.equal(record.command_fingerprint, requestFingerprint)
                    ) return #err(#corrupt_state);
                    return #ok(#complete(view(record, mem.revision)));
                };
                case null {};
            };
            for (tombstone in mem.command_tombstones.vals()) {
                if (Blob.equal(tombstone.command_id, request.command_id)) {
                    if (Blob.equal(tombstone.request_fingerprint, requestFingerprint)) {
                        return #err(#command_deleted({ local_id = tombstone.local_id }));
                    };
                    return #err(#command_conflict);
                };
            };

            let current = now();
            if (not validTimestamp(current)) return #err(#clock_invalid);
            let permitPlan = switch (validateOutboundState(current)) {
                case (#err(error)) return #err(error);
                case (#ok(plan)) plan;
            };
            applyPermitPlan(permitPlan);
            let permitKey = hex(request.permit_id);
            let ?permit = Map.get(mem.permits, Text.compare, permitKey) else {
                return #err(#permit_missing);
            };
            if (permit.expires_at_ns <= current) return #err(#permit_expired);
            if (not permitMatches(permit, request, decoded)) {
                return #err(#permit_mismatch);
            };
            if (not bindingForPermitStillExact(permit)) {
                return #err(#recipient_changed);
            };
            if (not reservationsReady(request.recipient)) {
                return #err(#permission_required);
            };
            if (not validLocalWrapAgainst(request, mem.key_info)) {
                return #err(#crypto_unavailable);
            };

            let retainedBytes = Accounting.outboxRetainedBytes(request.envelope);
            if (
                not fitsOutboxQuota(mem.outbox_count, mem.outbox_bytes, request.envelope) or
                Map.size(mem.outbox) >= OUTBOX_COUNT_LIMIT or
                mem.outbox_order.size() >= OUTBOX_COUNT_LIMIT
            ) return #err(#mailbox_full);
            let localId = mem.next_local_id;
            if (
                localId == 0 or
                Map.containsKey(mem.inbox, Nat.compare, localId) or
                Map.containsKey(mem.outbox, Nat.compare, localId)
            ) return #err(#corrupt_state);
            let record : Memory.OutboxRecord = {
                local_id = localId;
                command_id = request.command_id;
                command_fingerprint = requestFingerprint;
                recipient = request.recipient;
                contact_id = permit.contact_id;
                contact_revision = permit.contact_revision;
                message_id = decoded.message_id;
                delivery_key_epoch = decoded.delivery_key_epoch;
                delivery_key_fingerprint = decoded.recipient_key_fingerprint;
                local_wrap_epoch = request.local_wrap_epoch;
                local_wrap_fingerprint = request.local_wrap_fingerprint;
                local_wrapped_cek = request.local_wrapped_cek;
                envelope = request.envelope;
                created_at_ns = current;
                updated_at_ns = current;
                cleanup_epoch = mem.cleanup_epoch;
                attempt_no = 1;
                attempt_request_id = null;
                state = #sending;
                retained_bytes = retainedBytes;
            };
            let ledger : Memory.CommandLedgerEntry = {
                command_id = request.command_id;
                request_fingerprint = requestFingerprint;
                local_id = localId;
                cleanup_epoch = mem.cleanup_epoch;
                created_at_ns = current;
            };

            // Consume the one-use permit and durably establish the command and
            // Outbox state before the remote call can execute.
            Map.remove(mem.permits, Text.compare, permitKey);
            Map.add(mem.commands, Text.compare, commandKey, ledger);
            Map.add(mem.outbox, Nat.compare, localId, record);
            let previousOrder = mem.outbox_order;
            mem.outbox_order := Array.tabulate<Nat>(
                previousOrder.size() + 1,
                func(index) {
                    if (index == 0) localId else previousOrder[index - 1];
                },
            );
            mem.next_local_id += 1;
            mem.outbox_count += 1;
            mem.outbox_bytes += retainedBytes;
            mem.revision += 1;

            #ok(#dispatch({
                call = receiveRequest(record.recipient, record.envelope);
                local_id = record.local_id;
                message_id = record.message_id;
                cleanup_epoch = record.cleanup_epoch;
                attempt_no = record.attempt_no;
                origin = #command(record.command_id);
            }));
        };

        public func retry(request : RetryRequest) : async* Result<DeliveryView> {
            let dispatch = switch (retryStart(request)) {
                case (#err(error)) return #err(error);
                case (#ok(#complete(value))) return #ok(value);
                case (#ok(#dispatch(value))) value;
            };
            let remote = await* calls.call(dispatch.call);
            finishDelivery(dispatch, remote);
        };

        public func retryStart(request : RetryRequest) : Result<StartDelivery> {
            if (
                request.local_id == 0 or
                request.retry_request_id.size() != RETRY_REQUEST_ID_BYTES or
                isZero(request.retry_request_id)
            ) return #err(#invalid_request);
            let current = now();
            if (not validTimestamp(current)) return #err(#clock_invalid);
            let permitPlan = switch (validateOutboundState(current)) {
                case (#err(error)) return #err(error);
                case (#ok(plan)) plan;
            };
            applyPermitPlan(permitPlan);
            let ?stored = Map.get(mem.outbox, Nat.compare, request.local_id) else {
                if (hasRetryTombstone(request.local_id, request.retry_request_id)) {
                    return #err(#retry_deleted);
                };
                return #err(#not_found);
            };
            switch (stored.attempt_request_id) {
                case (?existing) if (Blob.equal(existing, request.retry_request_id)) {
                    return #ok(#complete(view(stored, mem.revision)));
                };
                case (_) {};
            };
            if (hasRetryTombstone(request.local_id, request.retry_request_id)) {
                return #ok(#complete(view(stored, mem.revision)));
            };
            // Exact active/tombstoned request replays above remain idempotent
            // even if the local clock regresses. A fresh attempt in any state
            // must never move updated_at_ns backwards or age a sending record.
            if (current < stored.updated_at_ns) return #err(#clock_invalid);
            switch (stored.state) {
                case (#sending) {
                    if (current - stored.updated_at_ns < SENDING_RECOVERY_TIMEOUT_NS) {
                        // A second click/request while the remote attempt is
                        // genuinely in flight is durably bound to that attempt.
                        // It can never become a later dispatch after this
                        // callback completes. Recovery requires a fresh id.
                        rememberRetry({
                            local_id = stored.local_id;
                            retry_request_id = request.retry_request_id;
                            attempt_no = stored.attempt_no;
                            deleted_at_ns = current;
                        });
                        mem.revision += 1;
                        return #ok(#complete(view(stored, mem.revision)));
                    };
                    // The continuation may have been lost during an upgrade.
                    // Continue through the ordinary retry commit below. It
                    // preserves target, message id and exact envelope; receiver
                    // dedupe makes a remote commit by the old attempt harmless.
                };
                case (state) if (not retryable(state)) return #err(#not_retryable);
                case (_) {};
            };
            if (not contactBindingStillExact(stored)) return #err(#recipient_changed);
            if (not calls.can_call(stored.recipient, MAIL_INGRESS_METHOD)) {
                return #err(#permission_required);
            };

            let nextAttempt = stored.attempt_no + 1;
            switch (stored.attempt_request_id) {
                case (?previous) {
                    rememberRetry({
                        local_id = stored.local_id;
                        retry_request_id = previous;
                        attempt_no = stored.attempt_no;
                        deleted_at_ns = current;
                    });
                };
                case null {};
            };
            let sending : Memory.OutboxRecord = {
                stored with
                updated_at_ns = current;
                attempt_no = nextAttempt;
                attempt_request_id = ?request.retry_request_id;
                state = #sending;
            };
            Map.add(mem.outbox, Nat.compare, stored.local_id, sending);
            mem.revision += 1;

            #ok(#dispatch({
                call = receiveRequest(sending.recipient, sending.envelope);
                local_id = sending.local_id;
                message_id = sending.message_id;
                cleanup_epoch = sending.cleanup_epoch;
                attempt_no = sending.attempt_no;
                origin = #retry(request.retry_request_id);
            }));
        };

        public func finishDelivery(
            dispatch : DeliveryDispatch,
            remote : Capabilities.CallResult,
        ) : Result<DeliveryView> {
            reconcile(
                dispatch.local_id,
                dispatch.message_id,
                dispatch.cleanup_epoch,
                dispatch.attempt_no,
                dispatch.origin,
                remote,
            );
        };

        func resolveBinding(recipient : Recipient) : Result<Binding> {
            switch (recipient) {
                case (#direct({ principal })) #ok({
                    recipient = principal;
                    contact_id = null;
                    contact_revision = null;
                    book_revision = 0;
                });
                case (#contact(selected)) {
                    if (selected.contact_id == 0 or selected.expected_contact_revision == 0) {
                        return #err(#invalid_request);
                    };
                    let lookup = lookupContact(selected.principal);
                    if (not lookup.integrity_ok) return #err(#recipient_changed);
                    let ?match = lookup.match else return #err(#recipient_changed);
                    if (
                        match.contact_id != selected.contact_id or
                        match.contact_revision != selected.expected_contact_revision or
                        not Principal.equal(match.principal, selected.principal)
                    ) return #err(#recipient_changed);
                    #ok({
                        recipient = selected.principal;
                        contact_id = ?selected.contact_id;
                        contact_revision = ?selected.expected_contact_revision;
                        book_revision = lookup.book_revision;
                    });
                };
            };
        };

        func bindingStillExact(binding : Binding) : Bool {
            switch (binding.contact_id, binding.contact_revision) {
                case (null, null) true;
                case (?contactId, ?contactRevision) {
                    let lookup = lookupContact(binding.recipient);
                    if (not lookup.integrity_ok) return false;
                    if (lookup.book_revision != binding.book_revision) return false;
                    let ?match = lookup.match else return false;
                    match.contact_id == contactId and
                    match.contact_revision == contactRevision and
                    Principal.equal(match.principal, binding.recipient);
                };
                case (_) false;
            };
        };

        func bindingForPermitStillExact(permit : Memory.RecipientPermit) : Bool {
            switch (permit.contact_id, permit.contact_revision) {
                case (null, null) permit.book_revision == 0;
                case (?contactId, ?contactRevision) {
                    let lookup = lookupContact(permit.target);
                    if (not lookup.integrity_ok) return false;
                    if (lookup.book_revision != permit.book_revision) return false;
                    let ?match = lookup.match else return false;
                    match.contact_id == contactId and
                    match.contact_revision == contactRevision and
                    Principal.equal(match.principal, permit.target);
                };
                case (_) false;
            };
        };

        func contactBindingStillExact(record : Memory.OutboxRecord) : Bool {
            switch (record.contact_id, record.contact_revision) {
                case (null, null) true;
                case (?contactId, ?contactRevision) {
                    let lookup = lookupContact(record.recipient);
                    if (not lookup.integrity_ok) return false;
                    let ?match = lookup.match else return false;
                    match.contact_id == contactId and
                    match.contact_revision == contactRevision and
                    Principal.equal(match.principal, record.recipient);
                };
                case (_) false;
            };
        };

        func reservationsReady(recipient : Principal) : Bool {
            calls.can_call(recipient, MAIL_INGRESS_METHOD);
        };

        func planPermits(current : Int) : Result<PermitPlan> {
            if (Map.size(mem.permits) > MAX_LIVE_PERMITS) return #err(#corrupt_state);
            let discarded = List.empty<Text>();
            var live = 0;
            for ((key, permit) in Map.entries(mem.permits)) {
                if (not validPermitShape(key, permit, mem.cleanup_epoch)) {
                    return #err(#corrupt_state);
                };
                if (
                    permit.expires_at_ns <= current or
                    permit.expires_at_ns > current + PERMIT_TTL_NS
                ) {
                    // Permits are ephemeral and never user-authored data. An
                    // otherwise-valid expiry more than one TTL ahead can only
                    // survive a stable-state clock rollback; discard it just
                    // like an expired permit instead of freezing all delivery.
                    List.add(discarded, key);
                } else {
                    live += 1;
                };
            };
            #ok({ discard_keys = List.toArray(discarded); live_count = live });
        };

        func applyPermitPlan(plan : PermitPlan) {
            for (key in plan.discard_keys.vals()) {
                Map.remove(mem.permits, Text.compare, key);
            };
        };

        func validateOutboundState(current : Int) : Result<PermitPlan> {
            if (not Store.validMemory(mem)) return #err(#corrupt_state);
            if (
                mem.outbox_count != Map.size(mem.outbox) or
                mem.outbox_order.size() != Map.size(mem.outbox) or
                Map.size(mem.commands) != Map.size(mem.outbox) or
                mem.outbox_count > OUTBOX_COUNT_LIMIT or
                mem.outbox_bytes > OUTBOX_BYTE_LIMIT or
                mem.retry_tombstones.size() > RETRY_TOMBSTONE_LIMIT
            ) return #err(#corrupt_state);
            let permitPlan = switch (planPermits(current)) {
                case (#err(error)) return #err(error);
                case (#ok(plan)) plan;
            };
            let seen = Set.empty<Nat>();
            var exactBytes = 0;
            for (id in mem.outbox_order.vals()) {
                if (not Set.insert(seen, Nat.compare, id)) return #err(#corrupt_state);
                let ?record = Map.get(mem.outbox, Nat.compare, id) else return #err(#corrupt_state);
                if (not validStoredOutbox(record, id, mem.cleanup_epoch)) {
                    return #err(#corrupt_state);
                };
                let key = hex(record.command_id);
                let ?command = Map.get(mem.commands, Text.compare, key) else {
                    return #err(#corrupt_state);
                };
                if (
                    command.local_id != id or
                    command.cleanup_epoch != record.cleanup_epoch or
                    not Blob.equal(command.command_id, record.command_id) or
                    not Blob.equal(command.request_fingerprint, record.command_fingerprint)
                ) return #err(#corrupt_state);
                exactBytes += record.retained_bytes;
            };
            if (exactBytes != mem.outbox_bytes) return #err(#corrupt_state);
            #ok(permitPlan);
        };

        func reconcile(
            localId : Nat,
            messageId : Blob,
            cleanupEpoch : Nat,
            attemptNo : Nat,
            origin : AttemptOrigin,
            remote : Capabilities.CallResult,
        ) : Result<DeliveryView> {
            let ?record = Map.get(mem.outbox, Nat.compare, localId) else {
                return #err(#attempt_superseded);
            };
            if (
                record.local_id != localId or
                mem.cleanup_epoch != cleanupEpoch or
                record.cleanup_epoch != cleanupEpoch or
                record.attempt_no != attemptNo or
                not Blob.equal(record.message_id, messageId) or
                not isSending(record.state) or
                not originMatches(record, origin)
            ) return #err(#attempt_superseded);

            let callbackTime = now();
            if (not validTimestamp(callbackTime) or callbackTime < record.updated_at_ns) {
                let uncertain : Memory.OutboxRecord = {
                    record with state = #delivery_uncertain
                };
                Map.add(mem.outbox, Nat.compare, localId, uncertain);
                mem.revision += 1;
                return #ok(view(uncertain, mem.revision));
            };
            let stillAuthorized = calls.can_call(record.recipient, MAIL_INGRESS_METHOD);
            let contactExact = contactBindingStillExact(record);
            let nextState = if (not stillAuthorized or not contactExact) {
                #delivery_uncertain;
            } else {
                classifyRemote(remote, callbackTime);
            };
            let next : Memory.OutboxRecord = {
                record with
                updated_at_ns = callbackTime;
                state = nextState;
            };
            Map.add(mem.outbox, Nat.compare, localId, next);
            mem.revision += 1;
            #ok(view(next, mem.revision));
        };

        func originMatches(record : Memory.OutboxRecord, origin : AttemptOrigin) : Bool {
            switch (origin) {
                case (#command(commandId)) {
                    record.attempt_no == 1 and
                    record.attempt_request_id == null and
                    Blob.equal(record.command_id, commandId);
                };
                case (#retry(requestId)) {
                    switch (record.attempt_request_id) {
                        case (?stored) Blob.equal(stored, requestId);
                        case null false;
                    };
                };
            };
        };

        func rememberRetry(tombstone : Memory.RetryTombstone) : () {
            let filtered = Array.filter<Memory.RetryTombstone>(
                mem.retry_tombstones,
                func(existing) {
                    not (
                        existing.local_id == tombstone.local_id and
                        Blob.equal(existing.retry_request_id, tombstone.retry_request_id)
                    );
                },
            );
            let all = Array.concat<Memory.RetryTombstone>(filtered, [tombstone]);
            let sorted = Array.sort<Memory.RetryTombstone>(all, compareRetryTombstones);
            let excess = if (sorted.size() > RETRY_TOMBSTONE_LIMIT) {
                sorted.size() - RETRY_TOMBSTONE_LIMIT;
            } else 0;
            mem.retry_tombstones := Array.tabulate<Memory.RetryTombstone>(
                sorted.size() - excess,
                func(index) { sorted[index + excess] },
            );
        };

        func hasRetryTombstone(localId : Nat, requestId : Blob) : Bool {
            for (tombstone in mem.retry_tombstones.vals()) {
                if (
                    tombstone.local_id == localId and
                    Blob.equal(tombstone.retry_request_id, requestId)
                ) return true;
            };
            false;
        };
    };

    public func publicInfoHash(recipient : Principal, info : MailKeyInfoV1) : Blob {
        DeliveryHash.publicInfo(
            recipient,
            info.protocol_version,
            info.suite,
            info.delivery_key_epoch,
            info.context_public_key,
            info.effective_ibe_identity,
            info.recipient_key_fingerprint,
            info.max_envelope_bytes,
        );
    };

    public func commandFingerprint(request : SendEncryptedRequest) : Blob {
        DeliveryHash.command(
            request.command_id,
            request.permit_id,
            request.recipient,
            request.public_info_hash,
            request.envelope,
            request.local_wrap_epoch,
            request.local_wrap_fingerprint,
            request.local_wrapped_cek,
        );
    };

    func generatedPermitId(
        requestId : Blob,
        generation : Nat,
        selfCanister : Principal,
    ) : Blob {
        DeliveryHash.permit(requestId, generation, selfCanister);
    };

    public func fitsOutboxQuota(
        currentCount : Nat,
        currentBytes : Nat,
        envelope : Blob,
    ) : Bool {
        currentCount < OUTBOX_COUNT_LIMIT and
        currentBytes + Accounting.outboxRetainedBytes(envelope) <= OUTBOX_BYTE_LIMIT;
    };

    public func keyFingerprint(
        suite : Nat16,
        epoch : Nat64,
        contextPublicKey : Blob,
        effectiveIbeIdentity : Blob,
    ) : Blob {
        KeyInfo.fingerprint(
            suite,
            epoch,
            contextPublicKey,
            effectiveIbeIdentity,
        );
    };

    func decodeKeyInfo(result : Capabilities.CallResult) : ?MailKeyInfoV1 {
        let reply = switch (publicIngressReply(result)) {
            case (?value) value;
            case null return null;
        };
        let decoded = RemoteWire.decodeKeyInfoReply(reply);
        switch (decoded) {
            case (?#ok(info)) {
                if (validRemoteKeyInfo(info)) ?info else null;
            };
            case (_) null;
        };
    };

    func validRemoteKeyInfo(info : MailKeyInfoV1) : Bool {
        KeyInfo.validPublished(
            info.protocol_version,
            info.suite,
            info.delivery_key_epoch,
            info.context_public_key,
            info.effective_ibe_identity,
            info.recipient_key_fingerprint,
            info.max_envelope_bytes,
        );
    };

    func validConfiguredKeyInfo(info : Memory.PublicKeyInfo) : Bool {
        KeyInfo.validConfigured(info);
    };

    func validateSendShape(request : SendEncryptedRequest) : Result<Envelope.EnvelopeV1> {
        if (
            request.command_id.size() != COMMAND_ID_BYTES or
            isZero(request.command_id) or
            request.permit_id.size() != PERMIT_ID_BYTES or
            isZero(request.permit_id) or
            request.public_info_hash.size() != PUBLIC_INFO_HASH_BYTES or
            isZero(request.public_info_hash) or
            not Principal.isCanister(request.recipient) or
            request.local_wrap_epoch == 0 or
            request.local_wrap_fingerprint.size() != Envelope.FINGERPRINT_BYTES or
            isZero(request.local_wrap_fingerprint) or
            request.local_wrapped_cek.size() != Envelope.WRAPPED_CEK_BYTES or
            isZero(request.local_wrapped_cek)
        ) return #err(#invalid_request);
        switch (Envelope.decode(request.envelope)) {
            case (#err) #err(#invalid_request);
            case (#ok(decoded)) {
                if (
                    isZero(decoded.message_id) or
                    isZero(decoded.recipient_key_fingerprint) or
                    isZero(decoded.recipient_wrapped_cek)
                ) #err(#invalid_request) else #ok(decoded);
            };
        };
    };

    func validLocalWrapAgainst(
        request : SendEncryptedRequest,
        info : ?Memory.PublicKeyInfo,
    ) : Bool {
        let ?keyInfo = info else return false;
        validConfiguredKeyInfo(keyInfo) and
        request.local_wrapped_cek.size() == Envelope.WRAPPED_CEK_BYTES and
        not isZero(request.local_wrapped_cek) and
        request.local_wrap_epoch == keyInfo.current_epoch and
        Blob.equal(request.local_wrap_fingerprint, keyInfo.current_fingerprint);
    };

    func permitMatches(
        permit : Memory.RecipientPermit,
        request : SendEncryptedRequest,
        decoded : Envelope.EnvelopeV1,
    ) : Bool {
        Blob.equal(permit.permit_id, request.permit_id) and
        Principal.equal(permit.target, request.recipient) and
        permit.suite == 1 and
        permit.delivery_key_epoch == decoded.delivery_key_epoch and
        Blob.equal(permit.delivery_key_fingerprint, decoded.recipient_key_fingerprint) and
        Blob.equal(permit.public_info_hash, request.public_info_hash);
    };

    func validPermitShape(
        key : Text,
        permit : Memory.RecipientPermit,
        cleanupEpoch : Nat,
    ) : Bool {
        permit.permit_id.size() == PERMIT_ID_BYTES and
        not isZero(permit.permit_id) and
        key == hex(permit.permit_id) and
        Principal.isCanister(permit.target) and
        permit.suite == 1 and
        permit.delivery_key_epoch > 0 and
        permit.delivery_key_fingerprint.size() == Envelope.FINGERPRINT_BYTES and
        not isZero(permit.delivery_key_fingerprint) and
        permit.public_info_hash.size() == PUBLIC_INFO_HASH_BYTES and
        not isZero(permit.public_info_hash) and
        permit.cleanup_epoch == cleanupEpoch and
        validTimestamp(permit.expires_at_ns) and
        validOptionalContact(permit.contact_id, permit.contact_revision, permit.book_revision);
    };

    func validOptionalContact(contactId : ?Nat, revision : ?Nat, bookRevision : Nat) : Bool {
        switch (contactId, revision) {
            case (null, null) bookRevision == 0;
            case (?id, ?value) id > 0 and value > 0 and bookRevision > 0;
            case (_) false;
        };
    };

    func validContactPair(contactId : ?Nat, revision : ?Nat) : Bool {
        switch (contactId, revision) {
            case (null, null) true;
            case (?id, ?value) id > 0 and value > 0;
            case (_) false;
        };
    };

    func validStoredOutbox(record : Memory.OutboxRecord, id : Nat, cleanupEpoch : Nat) : Bool {
        record.local_id == id and
        record.command_id.size() == COMMAND_ID_BYTES and
        not isZero(record.command_id) and
        record.command_fingerprint.size() == 32 and
        not isZero(record.command_fingerprint) and
        validRecipient(record.recipient, Principal.anonymous()) and
        validContactPair(record.contact_id, record.contact_revision) and
        record.message_id.size() == Envelope.MESSAGE_ID_BYTES and
        not isZero(record.message_id) and
        record.delivery_key_epoch > 0 and
        record.delivery_key_fingerprint.size() == Envelope.FINGERPRINT_BYTES and
        not isZero(record.delivery_key_fingerprint) and
        record.local_wrap_epoch > 0 and
        record.local_wrap_fingerprint.size() == Envelope.FINGERPRINT_BYTES and
        not isZero(record.local_wrap_fingerprint) and
        record.local_wrapped_cek.size() == Envelope.WRAPPED_CEK_BYTES and
        not isZero(record.local_wrapped_cek) and
        validTimestamp(record.created_at_ns) and
        validTimestamp(record.updated_at_ns) and
        record.updated_at_ns >= record.created_at_ns and
        record.cleanup_epoch == cleanupEpoch and
        record.attempt_no > 0 and
        validAttemptRequest(record.attempt_no, record.attempt_request_id) and
        record.envelope.size() > 0 and
        record.envelope.size() <= Envelope.MAX_ENVELOPE_BYTES and
        record.retained_bytes == Accounting.outboxRetainedBytes(record.envelope);
    };

    func validAttemptRequest(attemptNo : Nat, requestId : ?Blob) : Bool {
        if (attemptNo == 1) return requestId == null;
        switch (requestId) {
            case (?value) {
                value.size() == RETRY_REQUEST_ID_BYTES and not isZero(value);
            };
            case null false;
        };
    };

    func validRecipient(recipient : Principal, selfCanister : Principal) : Bool {
        Principal.isCanister(recipient) and not Principal.equal(recipient, selfCanister);
    };

    func classifyRemote(
        result : Capabilities.CallResult,
        callbackTime : Int,
    ) : Memory.OutboxState {
        let reply = switch (publicIngressReply(result)) {
            case (?value) value;
            case null return #delivery_uncertain;
        };
        let decoded = RemoteWire.decodeReceiveReply(reply);
        switch (decoded) {
            case (?#accepted({ received_at_ns })) {
                if (receivedAtValid(received_at_ns, callbackTime)) {
                    #accepted({ received_at_ns = Int64.toInt(received_at_ns) });
                } else #delivery_uncertain;
            };
            case (?#duplicate({ received_at_ns })) {
                if (receivedAtValid(received_at_ns, callbackTime)) {
                    #accepted({ received_at_ns = Int64.toInt(received_at_ns) });
                } else #delivery_uncertain;
            };
            case (?#rejected(#invalid)) #not_sent(#invalid);
            case (?#rejected(#mailbox_full)) #not_sent(#mailbox_full);
            case (?#rejected(#crypto_unavailable)) #not_sent(#crypto_unavailable);
            case (?#rejected(#rate_limited({ retry_after_seconds }))) {
                if (retry_after_seconds > 0 and Nat32.toNat(retry_after_seconds) % 300 == 0) {
                    #not_sent(#rate_limited);
                } else #delivery_uncertain;
            };
            case (?#rejected(#stale_key(stale))) {
                if (
                    stale.current_epoch > 0 and
                    stale.current_fingerprint.size() == Envelope.FINGERPRINT_BYTES and
                    not isZero(stale.current_fingerprint)
                ) {
                    #not_sent(#stale_key);
                } else #delivery_uncertain;
            };
            case null #delivery_uncertain;
        };
    };

    func retryable(state : Memory.OutboxState) : Bool {
        switch (state) {
            case (#delivery_uncertain) true;
            case (#not_sent(#rate_limited)) true;
            case (#not_sent(#mailbox_full)) true;
            case (#not_sent(#crypto_unavailable)) true;
            case (#not_sent(#permission_required)) true;
            case (_) false;
        };
    };

    func isSending(state : Memory.OutboxState) : Bool {
        switch (state) {
            case (#sending) true;
            case (_) false;
        };
    };

    func receivedAtValid(value : Int64, callbackTime : Int) : Bool {
        let timestamp = Int64.toInt(value);
        validTimestamp(timestamp) and timestamp <= callbackTime;
    };

    func receiveRequest(recipient : Principal, envelope : Blob) : Capabilities.CallRequest {
        {
            canister = recipient;
            method = MAIL_INGRESS_METHOD;
            args = publicIngressArgs(RECEIVE_ROUTE, to_candid (envelope));
            cycles = RECEIVE_REQUIRED_CYCLES;
        };
    };

    func publicIngressArgs(route : Text, payload : Blob) : Blob {
        let request : Capabilities.PublicIngressRequest = {
            method = route;
            payload;
        };
        to_candid (request);
    };

    func publicIngressReply(result : Capabilities.CallResult) : ?Blob {
        let raw = switch (result) {
            case (#ok(value)) value;
            case (#err(_)) return null;
        };
        RemoteWire.unwrapPublicIngressOkReply(
            raw,
            RemoteWire.MAX_KEY_INFO_PAYLOAD_BYTES + 32,
        );
    };

    func view(record : Memory.OutboxRecord, mailRevision : Nat) : DeliveryView {
        {
            local_id = record.local_id;
            mail_revision = mailRevision;
            cleanup_epoch = record.cleanup_epoch;
            attempt_no = record.attempt_no;
            state = record.state;
            updated_at_ns = record.updated_at_ns;
        };
    };

    func validTimestamp(value : Int) : Bool {
        value >= 0 and value <= MAX_TIMESTAMP;
    };

    func isZero(value : Blob) : Bool {
        for (byte in value.values()) if (byte != 0) return false;
        true;
    };

    func compareRetryTombstones(
        left : Memory.RetryTombstone,
        right : Memory.RetryTombstone,
    ) : { #less; #equal; #greater } {
        switch (Int.compare(left.deleted_at_ns, right.deleted_at_ns)) {
            case (#equal) {
                switch (Nat.compare(left.local_id, right.local_id)) {
                    case (#equal) {
                        switch (Nat.compare(left.attempt_no, right.attempt_no)) {
                            case (#equal) Text.compare(hex(left.retry_request_id), hex(right.retry_request_id));
                            case order order;
                        };
                    };
                    case order order;
                };
            };
            case order order;
        };
    };

    let HEX_DIGITS : [Text] = [
        "0", "1", "2", "3", "4", "5", "6", "7",
        "8", "9", "a", "b", "c", "d", "e", "f",
    ];

    func hex(value : Blob) : Text {
        var result = "";
        for (byte in value.values()) {
            let natural = Nat8.toNat(byte);
            result #= HEX_DIGITS[natural / 16] # HEX_DIGITS[natural % 16];
        };
        result;
    };
};
