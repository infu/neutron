import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Text "mo:core/Text";

import OutboxTypes "../outbox/Types";
import Bounds "../protocol/Bounds";
import Hash "../protocol/Hash";
import ProtocolTypes "../protocol/Types";

module {
    public type Kind = {
        #original;
        #share;
        #tombstone;
        #tombstone_relay;
    };

    public type Bucket = {
        #active;
        #completed;
        #terminal;
        #uncertain;
    };

    public type Counters = {
        completed : Nat32;
        terminal : Nat32;
        uncertain : Nat32;
    };

    public type State = {
        #queued;
        #scanning;
        #sending;
        #complete;
        #partial;
        #paused;
        #failed;
    };

    public func terminalWithoutTargets(
        state : State,
        targetless : Bool,
    ) : Bool {
        if (not targetless) return false;
        switch (state) {
            case (#complete or #partial or #failed) true;
            case (_) false;
        };
    };

    let OPERATION_DOMAIN = "wagyu.fanout-deliver-operation.v1";
    let TARGET_PREFIX = "fanout-target:";

    public func targetKey(
        fanoutJobId : Nat64,
        registrationSequence : Nat64,
    ) : Text {
        TARGET_PREFIX #
        Nat64.toText(fanoutJobId) # ":" #
        Nat64.toText(registrationSequence);
    };

    public func operationId(
        networkId : Blob,
        fanoutJobId : Nat64,
        actionKey : Text,
        recipient : Principal,
        registrationSequence : Nat64,
    ) : ?Blob {
        if (
            networkId.size() != Bounds.HASH_BYTES or
            fanoutJobId == 0 or
            registrationSequence == 0
        ) return null;
        let ?digest = Hash.lpHash(
            OPERATION_DOMAIN,
            [
                networkId,
                Hash.u64be(fanoutJobId),
                Text.encodeUtf8(actionKey),
                Principal.toBlob(recipient),
                Hash.u64be(registrationSequence),
            ],
        ) else return null;
        let bytes = Blob.toArray(digest);
        if (bytes.size() < Bounds.OPERATION_ID_BYTES) return null;
        let operation = Blob.fromArray(
            Array.tabulate<Nat8>(
                Bounds.OPERATION_ID_BYTES,
                func(index) { bytes[index] },
            )
        );
        if (isZero(operation)) null else ?operation;
    };

    public func event(
        kind : Kind,
        exactEventCandid : Blob,
    ) : ProtocolTypes.DeliveryEventV1 {
        switch (kind) {
            case (#original) #original(exactEventCandid);
            case (#share) #share(exactEventCandid);
            case (#tombstone or #tombstone_relay) {
                #tombstone(exactEventCandid);
            };
        };
    };

    public func bucket(state : OutboxTypes.StateV1) : Bucket {
        switch (state) {
            case (#accepted or #duplicate) #completed;
            case (#paused or #failed or #superseded) #terminal;
            case (#uncertain) #uncertain;
            case (#queued or #sending) #active;
        };
    };

    public func transition(
        counters : Counters,
        previous : OutboxTypes.StateV1,
        next : OutboxTypes.StateV1,
    ) : ?Counters {
        let removed = decrement(counters, bucket(previous));
        switch (removed) {
            case null null;
            case (?value) increment(value, bucket(next));
        };
    };

    public func jobState(
        scanComplete : Bool,
        queued : Nat32,
        counters : Counters,
    ) : ?State {
        let accounted =
            Nat32.toNat(counters.completed) +
            Nat32.toNat(counters.terminal) +
            Nat32.toNat(counters.uncertain);
        let queuedNat = Nat32.toNat(queued);
        if (accounted > queuedNat) return null;
        if (not scanComplete) return ?#scanning;
        if (accounted < queuedNat) return ?#sending;
        if (counters.uncertain > 0) return ?#partial;
        if (counters.terminal > 0 and counters.completed > 0) {
            return ?#partial;
        };
        if (counters.terminal > 0) return ?#failed;
        ?#complete;
    };

    func increment(counters : Counters, value : Bucket) : ?Counters {
        switch (value) {
            case (#active) ?counters;
            case (#completed) {
                if (counters.completed == Nat32.maxValue) return null;
                ?{
                    counters with
                    completed = counters.completed + 1;
                };
            };
            case (#terminal) {
                if (counters.terminal == Nat32.maxValue) return null;
                ?{
                    counters with
                    terminal = counters.terminal + 1;
                };
            };
            case (#uncertain) {
                if (counters.uncertain == Nat32.maxValue) return null;
                ?{
                    counters with
                    uncertain = counters.uncertain + 1;
                };
            };
        };
    };

    func decrement(counters : Counters, value : Bucket) : ?Counters {
        switch (value) {
            case (#active) ?counters;
            case (#completed) {
                if (counters.completed == 0) return null;
                ?{
                    counters with
                    completed = counters.completed - 1;
                };
            };
            case (#terminal) {
                if (counters.terminal == 0) return null;
                ?{
                    counters with
                    terminal = counters.terminal - 1;
                };
            };
            case (#uncertain) {
                if (counters.uncertain == 0) return null;
                ?{
                    counters with
                    uncertain = counters.uncertain - 1;
                };
            };
        };
    };

    func isZero(value : Blob) : Bool {
        for (byte in Blob.toArray(value).vals()) {
            if (byte != 0) return false;
        };
        true;
    };
};
