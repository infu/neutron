import Map "mo:core/Map";
import Principal "mo:core/Principal";
import HistoryStore "../backend/history/Store";
import Memory "../backend/memory/wallet/v1";

// Fresh installs use the released v1 defaults.
let fresh = Memory.init();
assert (fresh.next_id == 1);
assert (Map.size(fresh.ledgers) == 0);
assert (Map.size(fresh.activity_order) == 0);
assert (fresh.metadata_epoch == 0);
assert (fresh.balance_epoch == 0);
assert (fresh.native_epoch == 0);
assert not fresh.configured;

// Wallet 0.3.2 already runs v1. The archive transition test proves the
// license-only 0.3.3 release is #keep, so retain both root counters and a
// representative nested ledger/history record.
let ledgerPrincipal = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
let ledger : Memory.Ledger = {
    id = 7;
    principal = ledgerPrincipal;
    name = ?"Internet Computer";
    symbol = ?"ICP";
    decimals = ?8;
    fee = ?10_000;
    logo = null;
    balance = ?123_456_789;
    metadata_updated_at = ?100;
    balance_updated_at = ?200;
    metadata_error = null;
    balance_error = null;
    native_address = null;
    native_address_updated_at = null;
    native_address_error = null;
    native_refresh_updated_at = null;
    native_refresh_error = null;
    native_deposit_progress = null;
    enabled = true;
    history = HistoryStore.emptyHistory(#unavailable);
};
fresh.next_id := 8;
fresh.metadata_epoch := 11;
fresh.balance_epoch := 12;
fresh.native_epoch := 13;
fresh.configured := true;
Map.add(fresh.ledgers, Principal.compare, ledgerPrincipal, ledger);

let restored : Memory.Mem = fresh;
assert (restored.next_id == 8);
assert (restored.metadata_epoch == 11);
assert (restored.balance_epoch == 12);
assert (restored.native_epoch == 13);
assert restored.configured;
switch (Map.get(restored.ledgers, Principal.compare, ledgerPrincipal)) {
    case (?retained) {
        assert (retained.id == 7 and retained.symbol == ?"ICP");
        assert (retained.balance == ?123_456_789 and retained.enabled);
        assert (retained.history.state == #idle);
    };
    case null assert false;
};
