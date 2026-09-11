import Cycles "mo:core/Cycles";
import Map "mo:core/Map";
import Principal "mo:core/Principal";

// Disposable PocketIC ledger: cycles are really attached and accepted. It
// deliberately has no deposit deduplication, like the cycles-ledger deposit
// method, so any accidental resend is visible in deposits and credited tokens.
persistent actor Self {
    type Account = { owner : Principal; subaccount : ?Blob };
    type Deposit = { to : Account; memo : ?Blob };
    type Receipt = { balance : Nat; block_index : Nat };
    let balances = Map.empty<Principal, Nat>();
    var deposits : Nat = 0;
    var accepted : Nat = 0;
    var paused = false;

    public shared func deposit(request : Deposit) : async Receipt {
        assert (request.to.subaccount == null);
        let cycles = Cycles.accept<system>(Cycles.available());
        assert (cycles >= 100_000_000);
        accepted += cycles;
        let block = deposits;
        deposits += 1;
        while (paused) await Self.pulse();
        let previous = switch (Map.get(balances, Principal.compare, request.to.owner)) {
            case (?value) value;
            case null 0;
        };
        let balance = previous + cycles - 100_000_000;
        Map.add(balances, Principal.compare, request.to.owner, balance);
        { balance; block_index = block };
    };

    public shared func pulse() : async () {};
    public shared func set_paused(value : Bool) : async () { paused := value };
    public query func snapshot(owner : Principal) : async { deposits : Nat; accepted : Nat; balance : Nat } {
        {
            deposits; accepted;
            balance = switch (Map.get(balances, Principal.compare, owner)) {
                case (?value) value;
                case null 0;
            };
        };
    };
};
