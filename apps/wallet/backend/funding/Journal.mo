import Blob "mo:core/Blob";
import Int "mo:core/Int";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat64 "mo:core/Nat64";
import Order "mo:core/Order";
import CommandMemory "../memory/wallet_commands/v1";

module {
    public type ExecutionAdmission = { #waiting; #dispatch };

    public type ActiveIcpRevokeMatch = {
        #none;
        #resume : {
            key : CommandMemory.CommandKey;
            command : CommandMemory.Command;
        };
        #blocked;
    };

    public type PendingIcpRevokeCandidate = {
        command : CommandMemory.Command;
        frozen_args : Blob;
        spender : Blob;
        var seen : Bool;
    };

    func validUntil(command : CommandMemory.Command) : Int {
        Int.fromNat(Nat64.toNat(command.valid_until));
    };

    // `retain_until` was originally calculated from `valid_until`. Preserve
    // that interval when a command reaches a terminal state after its original
    // deadline, without changing the released command-memory schema.
    func terminalRetainUntil(
        command : CommandMemory.Command,
        terminalAt : Int,
    ) : Int {
        let deadline = validUntil(command);
        let retention = if (command.retain_until > deadline) {
            command.retain_until - deadline;
        } else 0;
        let completedRetention = terminalAt + retention;
        if (completedRetention > command.retain_until) {
            completedRetention;
        } else command.retain_until;
    };

    public func pruneExpiredCommands(
        commands : Map.Map<CommandMemory.CommandKey, CommandMemory.Command>,
        compare : (CommandMemory.CommandKey, CommandMemory.CommandKey) -> Order.Order,
        now : Int,
        limit : Nat,
    ) : Nat {
        let discarded = List.empty<CommandMemory.CommandKey>();
        label entries for ((key, command) in Map.entries(commands)) {
            if (List.size(discarded) >= limit) break entries;
            let removable = switch (command.status) {
                case (#prepared) now > validUntil(command);
                case (#succeeded(receipt)) {
                    now >= terminalRetainUntil(command, receipt.completed_at);
                };
                case (#rejected(error)) {
                    now >= terminalRetainUntil(command, error.at);
                };
                // Accepting while another Wallet call owns the dispatch slot
                // creates pending work with no frozen args. It is still known
                // never to have executed, so it may expire like #prepared.
                // Once args are frozen, retain the ambiguous command forever.
                case (#pending(_)) {
                    command.call_args == null and now > validUntil(command);
                };
            };
            if (removable) List.add(discarded, key);
        };
        for (key in List.values(discarded)) {
            Map.remove(commands, compare, key);
        };
        List.size(discarded);
    };

    public func acceptForExecution(
        command : CommandMemory.Command,
        anotherInFlight : Bool,
        now : Int,
    ) : ExecutionAdmission {
        let attempts = switch (command.status) {
            case (#pending(value)) value.attempts + 1;
            case (_) 1;
        };
        let startedAt = switch (command.status) {
            case (#pending(value)) value.started_at;
            case (_) now;
        };
        let lastError = switch (command.status) {
            case (#pending(value)) value.last_error;
            case (_) null;
        };
        command.status := #pending({
            attempts;
            started_at = startedAt;
            last_error = lastError;
        });
        command.updated_at := now;
        if (anotherInFlight) #waiting else #dispatch;
    };

    public func requiresCurrentAuthority(
        command : CommandMemory.Command,
    ) : Bool {
        switch (command.status) {
            case (#prepared) true;
            case (#pending(_)) command.call_args == null;
            // Frozen pending work must remain replayable for reconciliation,
            // and terminal outcomes remain replayable until their tombstones
            // expire even if older state lacks frozen call arguments.
            case (#succeeded(_)) false;
            case (#rejected(_)) false;
        };
    };

    public func activeCommandCount(
        commands : Map.Map<CommandMemory.CommandKey, CommandMemory.Command>,
        callerAppId : Text,
    ) : Nat {
        var count = 0;
        for ((key, command) in Map.entries(commands)) {
            if (key.caller_app_id == callerAppId) {
                switch (command.status) {
                    case (#prepared) count += 1;
                    case (#pending(_)) count += 1;
                    case (_) {};
                };
            };
        };
        count;
    };

    // Legacy ICP remove_approval has no timestamp or atomic allowance CAS.
    // Both prepared and pending removals therefore fence every fresh command
    // for the same Wallet source, ledger, and spender. The exact caller/facts
    // may resume the old command; changed facts or another caller stay blocked.
    public func activeIcpRevoke(
        commands : Map.Map<CommandMemory.CommandKey, CommandMemory.Command>,
        caller : CommandMemory.Caller,
        ledger : Principal,
        spender : Blob,
        expectedAllowance : Nat,
        expectedExpiresAt : ?Nat64,
        now : Nat64,
    ) : ActiveIcpRevokeMatch {
        var resume : ?{
            key : CommandMemory.CommandKey;
            command : CommandMemory.Command;
        } = null;
        for ((key, command) in Map.entries(commands)) {
            if (command.ledger == ledger) {
                let active = switch (command.status) {
                    case (#prepared) now <= command.valid_until;
                    case (#pending(_)) switch (command.call_args) {
                        case null now <= command.valid_until;
                        case (?_) true;
                    };
                    case (_) false;
                };
                if (active) switch (command.operation) {
                    case (#revoke({
                        spender = #icp_account_identifier(candidate);
                        expected_allowance;
                        expected_expires_at;
                    })) {
                        if (candidate == spender) {
                            if (
                                command.caller != caller or
                                expected_allowance != expectedAllowance or
                                expected_expires_at != expectedExpiresAt
                            ) {
                                return #blocked;
                            };
                            switch (resume) {
                                case null resume := ?{ key; command };
                                case (?prior) if (prior.key != key) return #blocked;
                                case (_) {};
                            };
                        };
                    };
                    case (_) {};
                };
            };
        };
        switch (resume) {
            case null #none;
            case (?value) #resume(value);
        };
    };

    // Snapshot eligibility before the first read-only scan await. A command
    // prepared or dispatched while the scan is running must not be concluded
    // from an older absence observation.
    public func snapshotPendingIcpRevokes(
        commands : Map.Map<CommandMemory.CommandKey, CommandMemory.Command>,
        ledger : Principal,
    ) : [PendingIcpRevokeCandidate] {
        let candidates = List.empty<PendingIcpRevokeCandidate>();
        for (command in Map.values(commands)) {
            if (command.ledger == ledger) {
                switch (command.status, command.operation, command.call_args) {
                    case (
                        #pending(_),
                        #revoke({ spender = #icp_account_identifier(spender) }),
                        ?frozenArgs,
                    ) List.add(candidates, {
                        command;
                        frozen_args = frozenArgs;
                        spender;
                        var seen = false;
                    });
                    case (_) {};
                };
            };
        };
        List.toArray(candidates);
    };

    public func noteIcpSpender(
        candidates : [PendingIcpRevokeCandidate],
        spender : Blob,
    ) : () {
        for (candidate in candidates.vals()) {
            if (candidate.spender == spender) candidate.seen := true;
        };
    };

    // Call only after a bounded scan from the beginning reaches its validated
    // portable completion signal. Recheck the frozen args and pending status
    // so an interleaving terminal result always wins.
    public func reconcileIcpCompleteScan(
        candidates : [PendingIcpRevokeCandidate],
        ledger : Principal,
        completedAt : Int,
    ) : Nat {
        var reconciled = 0;
        for (candidate in candidates.vals()) {
            let command = candidate.command;
            if (not candidate.seen and command.ledger == ledger) {
                switch (command.status, command.operation, command.call_args) {
                    case (
                        #pending(_),
                        #revoke({ spender = #icp_account_identifier(spender) }),
                        ?frozenArgs,
                    ) {
                        if (
                            spender == candidate.spender and
                            frozenArgs == candidate.frozen_args
                        ) {
                            command.status := #succeeded({
                                block_index = null;
                                duplicate = false;
                                completed_at = completedAt;
                            });
                            command.updated_at := completedAt;
                            reconciled += 1;
                        };
                    };
                    case (_) {};
                };
            };
        };
        reconciled;
    };
};
