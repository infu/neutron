import Int "mo:core/Int";
import Iter "mo:core/Iter";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Nat64 "mo:core/Nat64";
import Order "mo:core/Order";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Time "mo:core/Time";
import Memory "../memory/wallet/v1";

module {
    public func emptyHistory(source : Memory.HistorySource) : Memory.LedgerHistory {
        {
            transactions = Map.empty<Nat, Memory.HistoryTransaction>();
            adjustments = Map.empty<Nat, Memory.HistoryAdjustment>();
            var next_adjustment_id = 1;
            var checkpoint = null;
            var scan = null;
            var config_epoch = 0;
            var last_attempt_at = null;
            var last_success_at = null;
            var last_error = null;
            var source;
            var state = #idle;
        };
    };

    public func compareOrderKey(
        left : Memory.HistoryOrderKey,
        right : Memory.HistoryOrderKey,
    ) : Order.Order {
        chain(
            Nat64.compare(left.timestamp_ns, right.timestamp_ns),
            func() {
                chain(
                    Principal.compare(left.ledger, right.ledger),
                    func() {
                        chain(
                            Nat8.compare(left.kind_order, right.kind_order),
                            func() { Nat.compare(left.id, right.id) },
                        );
                    },
                );
            },
        );
    };

    public func transactionOrderKey(
        ledger : Principal,
        transaction : Memory.HistoryTransaction,
    ) : Memory.HistoryOrderKey {
        {
            timestamp_ns = transaction.timestamp_ns;
            ledger;
            kind_order = 1;
            id = transaction.block_index;
        };
    };

    public func adjustmentOrderKey(
        adjustment : Memory.HistoryAdjustment,
    ) : Memory.HistoryOrderKey {
        {
            timestamp_ns = adjustment.timestamp_ns;
            ledger = adjustment.ledger;
            kind_order = 0;
            id = adjustment.id;
        };
    };

    public func putTransaction(
        mem : Memory.Mem,
        ledgerPrincipal : Principal,
        transaction : Memory.HistoryTransaction,
    ) : Bool {
        let ?ledger = Map.get(mem.ledgers, Principal.compare, ledgerPrincipal) else {
            return false;
        };
        switch (Map.get(ledger.history.transactions, Nat.compare, transaction.block_index)) {
            case (?previous) {
                Map.remove(
                    mem.activity_order,
                    compareOrderKey,
                    transactionOrderKey(ledgerPrincipal, previous),
                );
            };
            case null {};
        };
        Map.add(
            ledger.history.transactions,
            Nat.compare,
            transaction.block_index,
            transaction,
        );
        Map.add(
            mem.activity_order,
            compareOrderKey,
            transactionOrderKey(ledgerPrincipal, transaction),
            #transaction({ ledger = ledgerPrincipal; block_index = transaction.block_index }),
        );
        true;
    };

    public func addAdjustment(
        mem : Memory.Mem,
        ledgerPrincipal : Principal,
        kind : Memory.HistoryAdjustmentKind,
        effect : Int,
        previousBalance : Nat,
        observedBalance : Nat,
        fromTip : Nat,
        toTip : Nat,
        detail : Text,
    ) : ?Memory.HistoryAdjustment {
        let ?ledger = Map.get(mem.ledgers, Principal.compare, ledgerPrincipal) else {
            return null;
        };
        let id = ledger.history.next_adjustment_id;
        ledger.history.next_adjustment_id += 1;
        let adjustment : Memory.HistoryAdjustment = {
            id;
            kind;
            ledger = ledgerPrincipal;
            timestamp_ns = nowNanos();
            balance_effect = effect;
            previous_balance = previousBalance;
            observed_balance = observedBalance;
            from_tip_exclusive = fromTip;
            to_tip_exclusive = toTip;
            detail = boundedText(detail, 512);
        };
        Map.add(ledger.history.adjustments, Nat.compare, id, adjustment);
        Map.add(
            mem.activity_order,
            compareOrderKey,
            adjustmentOrderKey(adjustment),
            #adjustment({ ledger = ledgerPrincipal; adjustment_id = id }),
        );
        ?adjustment;
    };

    public func recordFor(
        mem : Memory.Mem,
        reference : Memory.HistoryRecordRef,
    ) : ?{
        #transaction : { ledger : Principal; value : Memory.HistoryTransaction };
        #adjustment : Memory.HistoryAdjustment;
    } {
        switch (reference) {
            case (#transaction(value)) {
                let ?ledger = Map.get(mem.ledgers, Principal.compare, value.ledger) else {
                    return null;
                };
                let ?transaction = Map.get(
                    ledger.history.transactions,
                    Nat.compare,
                    value.block_index,
                ) else return null;
                ?#transaction({ ledger = value.ledger; value = transaction });
            };
            case (#adjustment(value)) {
                let ?ledger = Map.get(mem.ledgers, Principal.compare, value.ledger) else {
                    return null;
                };
                let ?adjustment = Map.get(
                    ledger.history.adjustments,
                    Nat.compare,
                    value.adjustment_id,
                ) else return null;
                ?#adjustment(adjustment);
            };
        };
    };

    public func nowNanos() : Nat64 {
        Nat64.fromNat(Int.abs(Time.now()));
    };

    public func boundedText(value : Text, limit : Nat) : Text {
        if (value.size() <= limit) return value;
        Text.fromIter(Iter.take(value.chars(), limit));
    };

    func chain(order : Order.Order, next : () -> Order.Order) : Order.Order {
        switch (order) {
            case (#equal) next();
            case (_) order;
        };
    };
};
