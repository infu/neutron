import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Char "mo:core/Char";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat8 "mo:core/Nat8";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Time "mo:core/Time";
import Catalog "../Catalog";
import Capabilities "../capabilities/Types";
import Memory "../memory/wallet_bridge/v1";
import Types "Types";
import Minter "Minter";
import Ledger "Ledger";
module {
    public type Result<T> = Types.Result<T>;
    public type Quote = Types.Quote;
    public type Intent = Types.Intent;
    public type PrepareRequest = Types.PrepareRequest;
    public type ClaimRequest = Types.ClaimRequest;
    public type RecordStepRequest = Types.RecordStepRequest;
    public type RefreshRequest = Types.RefreshRequest;
    public type ListRequest = Types.ListRequest;
    public type Page = Types.Page;

    public class Service(mem : Memory.Mem, calls : Capabilities.BackendCalls) {
        public func quote(ledger : Principal) : async* Result<Quote> {
            let route = switch (Catalog.find(ledger)) {
                case null return #err("This ledger has no supported Ethereum deposit route");
                case (?value) switch (value.native_route) {
                    case (?#cketh(value)) ({ minter = Principal.fromText(value.minter); token = null });
                    case (?#ckerc20(value)) ({ minter = Principal.fromText(value.minter); token = ?lower(value.contract) });
                    case (_) return #err("This ledger has no supported Ethereum deposit route");
                };
            };
            let info = switch (Minter.decodeInfo(await* calls.call(Minter.infoRequest(route.minter)))) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            let minterAddress = switch (info.minter_address) {
                case (?value) if (validHex(value, 20)) lower(value) else return #err("The minter has no valid Ethereum address");
                case null return #err("The minter's Ethereum address is unavailable");
            };
            let token = switch (route.token) {
                case null {
                    if (info.cketh_ledger_id != ?ledger) return #err("The minter's ckETH ledger does not match the selected asset");
                    null;
                };
                case (?expected) {
                    var found : ?Text = null;
                    for (candidate in (switch (info.supported_ckerc20_tokens) { case null []; case (?value) value }).vals()) {
                        if (candidate.ledger_canister_id == ledger) {
                            if (not validHex(candidate.erc20_contract_address, 20) or lower(candidate.erc20_contract_address) != expected) {
                                return #err("The minter's ERC-20 mapping does not match the selected asset");
                            };
                            found := ?expected;
                        };
                    };
                    if (found == null) return #err("The minter does not currently support the selected token");
                    found;
                };
            };
            let helper = switch (info.deposit_with_subaccount_helper_contract_address) {
                case (?address) ({ address; mode = #subaccount });
                case null {
                    let current = if (token == null) info.eth_helper_contract_address else info.erc20_helper_contract_address;
                    // The deprecated smart_contract_address is an ETH helper,
                    // never a fallback for an unsupported ERC-20 helper.
                    let fallback = if (token != null) current else switch (current) { case null info.smart_contract_address; case (_) current };
                    switch (fallback) {
                        case null return #err("The minter has no deposit helper");
                        case (?address) ({ address; mode = #legacy });
                    };
                };
            };
            if (not validHex(helper.address, 20)) return #err("The minter returned an invalid helper address");
            #ok({
                chain_id = 1;
                ledger;
                minter = route.minter;
                helper_address = lower(helper.address);
                helper_mode = helper.mode;
                minter_address = minterAddress;
                token_address = token;
                recipient = calls.canister_principal;
                principal_word = principalWord(calls.canister_principal);
                subaccount_word = hex(Blob.fromArray(Array.tabulate<Nat8>(32, func(_) { 0 })));
            });
        };

        public func prepare(request : PrepareRequest) : async* Result<Intent> {
            if (request.id.size() != 16) return #err("Bridge request ID must contain exactly 16 bytes");
            if (request.amount == 0 or request.amount >= 2 ** 256) return #err("Deposit amount must be a positive Ethereum uint256");
            if (not validHex(request.account, 20)) return #err("Invalid Ethereum source account");
            switch (request.subaccount) {
                case (?value) if (value.size() != 32) return #err("IC subaccount must contain exactly 32 bytes");
                case (_) {};
            };
            switch (existing(request)) { case (#err(error)) return #err(error); case (#ok(?value)) return #ok(value); case (_) {} };
            let discovered = switch (await* quote(request.ledger)) { case (#err(error)) return #err(error); case (#ok(value)) value };
            let subaccountWord = switch (request.subaccount) { case null discovered.subaccount_word; case (?value) hex(value) };
            if (discovered.helper_mode == #legacy and not Ledger.sameSubaccount(request.subaccount, null)) {
                return #err("This legacy helper cannot deposit into an IC subaccount");
            };
            // Capture the event tail before any transaction may be sent. It is
            // persisted with the first intent and retained through all retries.
            let tip = switch (Minter.decodeEvents(await* calls.call(Minter.eventsRequest(discovered.minter, 0, 0)))) {
                case (#err(error)) return #err(error);
                case (#ok(value)) {
                    if (value.events.size() != 0) return #err("Minter returned events for a zero-length request");
                    value.total_event_count;
                };
            };
            // Another tile can finish preparing the same ID across these reads.
            switch (existing(request)) { case (#err(error)) return #err(error); case (#ok(?value)) return #ok(value); case (_) {} };
            let now = Time.now();
            let intent : Intent = {
                id = request.id;
                quote = { discovered with subaccount_word = subaccountWord };
                source = request.source;
                account = lower(request.account);
                amount = request.amount;
                subaccount = request.subaccount;
                steps = Array.map<Memory.StepKind, Memory.Step>([#reset_approval, #approval, #deposit], func(kind) {
                    { kind; state = #ready; operation_id = null; transaction_hash = null; error = null };
                });
                revision = 0;
                created_at = now;
                updated_at = now;
                event_cursor = tip;
                accepted_deposit = null;
                mint = null;
                error = null;
            };
            Map.add(mem.intents, Blob.compare, request.id, intent);
            #ok(intent);
        };

        public func status(id : Blob) : Result<Intent> {
            switch (Map.get(mem.intents, Blob.compare, id)) { case null #err("Bridge intent not found"); case (?intent) #ok(intent) };
        };
        public func list(request : ListRequest) : Page {
            let records = List.empty<Intent>();
            var last : ?Blob = null;
            for ((id, intent) in Map.entries(mem.intents)) {
                let past = switch (request.after) { case null true; case (?after) Blob.compare(id, after) == #greater };
                let matches = switch (request.ledger) { case null true; case (?ledger) intent.quote.ledger == ledger };
                if (past and matches) {
                    if (List.size(records) == request.limit) return { records = List.toArray(records); next = last };
                    List.add(records, intent);
                    last := ?id;
                };
            };
            { records = List.toArray(records); next = null };
        };
        public func claim(request : ClaimRequest) : Result<Intent> {
            let intent = switch (current(request.id, request.revision)) { case (#err(error)) return #err(error); case (#ok(value)) value };
            let selected = intent.steps[stepIndex(request.step)];
            if (selected.state != #ready) return #err("This bridge step was already claimed; reconcile its saved operation before continuing");
            if (intent.steps[2].state != #ready and request.step != #deposit) return #err("The deposit was already submitted; approvals cannot be restarted");
            for (step in intent.steps.vals()) {
                if (stepIndex(step.kind) < stepIndex(request.step) and step.state != #ready and step.state != #confirmed) {
                    return #err("An earlier bridge step must be reconciled before continuing");
                };
            };
            if (intent.source != #external and request.operation_id == null) return #err("EVM Wallet steps require a stable operation ID");
            // CAS and durable unknown status happen synchronously BEFORE the
            // browser/provider transaction await. A second tile cannot claim it.
            let step : Memory.Step = { selected with state = #unknown; operation_id = request.operation_id; error = null };
            #ok(saveStep(intent, step));
        };
        public func recordStep(request : RecordStepRequest) : Result<Intent> {
            let intent = switch (current(request.id, request.revision)) { case (#err(error)) return #err(error); case (#ok(value)) value };
            let prior = intent.steps[stepIndex(request.step)];
            if (prior.state == #ready) return #err("Claim the bridge step before submitting it");
            let hash = switch (request.transaction_hash) {
                case null prior.transaction_hash;
                case (?value) {
                    if (not validHex(value, 32)) return #err("Invalid Ethereum transaction hash");
                    let normalized = lower(value);
                    switch (prior.transaction_hash) { case (?old) if (old != normalized) return #err("A bridge step cannot switch to another transaction"); case (_) {} };
                    ?normalized;
                };
            };
            if ((request.state == #submitted or request.state == #confirmed) and hash == null) return #err("Submitted transactions require their hash");
            switch (hash) {
                case null {};
                case (?transactionHash) {
                    // A transaction identifies one execution, including a
                    // manually recovered external-wallet hash. Check and save
                    // atomically so two intents cannot claim the same deposit,
                    // or count one approval as both reset and approval.
                    for ((id, savedIntent) in Map.entries(mem.intents)) {
                        for (savedStep in savedIntent.steps.vals()) {
                            if (
                                (id != request.id or savedStep.kind != request.step) and
                                savedStep.transaction_hash == ?transactionHash
                            ) {
                                return #err("This transaction is already recorded for another bridge intent or step; resume its original saved operation");
                            };
                        };
                    };
                };
            };
            if (prior.state == #confirmed or prior.state == #failed) {
                if (prior.state == request.state and prior.transaction_hash == hash) return #ok(intent);
                return #err("A completed bridge step cannot change outcome");
            };
            let step : Memory.Step = { prior with state = request.state; transaction_hash = hash; error = request.error };
            #ok(saveStep(intent, step));
        };

        public func refresh(request : RefreshRequest) : async* Result<Intent> {
            let captured = switch (status(request.id)) { case (#err(error)) return #err(error); case (#ok(value)) value };
            let hash = switch (captured.steps[2].transaction_hash) { case null return #ok(captured); case (?value) value };
            switch (captured.mint) { case (?mint) if (mint.verified_ledger) return #ok(captured); case (_) {} };
            if (request.event_page_length == 0) return #err("Event page length must be greater than zero");
            let events = switch (Minter.decodeEvents(await* calls.call(Minter.eventsRequest(captured.quote.minter, captured.event_cursor, request.event_page_length)))) {
                case (#err(error)) return saveError(request.id, error);
                case (#ok(value)) value;
            };
            let currentIntent = switch (status(request.id)) { case (#err(error)) return #err(error); case (#ok(value)) value };
            // Overlapping refreshes never rewind the cursor or overwrite newer
            // transaction state. A later refresh resumes from the stored cursor.
            if (currentIntent.event_cursor != captured.event_cursor) return #ok(currentIntent);
            if (currentIntent.steps[2].transaction_hash != ?hash) return #ok(currentIntent);
            let next = Nat64.toNat(captured.event_cursor) + events.events.size();
            if (next > Nat64.toNat(events.total_event_count) or events.events.size() > Nat64.toNat(request.event_page_length)) {
                return saveError(request.id, "Minter returned an inconsistent event page");
            };
            if (events.events.size() == 0 and captured.event_cursor < events.total_event_count) {
                return saveError(request.id, "Minter returned no progress before the event tail");
            };
            let scanned = applyEvents(currentIntent, events.events);
            let updated = store({ scanned with event_cursor = Nat64.fromNat(next) });
            switch (updated.mint) {
                case null #ok(updated);
                case (?mint) {
                    if (mint.verified_ledger) return #ok(updated);
                    let ledgerReply = await* calls.call(Ledger.request(updated, mint.ledger_block_index));
                    let verification = if (Ledger.isArchived(ledgerReply, mint.ledger_block_index)) {
                        switch (Ledger.indexRequest(updated, mint.ledger_block_index)) {
                            case null Ledger.verify(ledgerReply, updated, mint.ledger_block_index);
                            case (?indexRequest) Ledger.verifyIndex(await* calls.call(indexRequest), updated, mint.ledger_block_index);
                        };
                    } else Ledger.verify(ledgerReply, updated, mint.ledger_block_index);
                    let latest = switch (status(request.id)) { case (#err(error)) return #err(error); case (#ok(value)) value };
                    if (latest.mint != ?mint) return #ok(latest);
                    switch (verification) {
                        case (#err(error)) saveError(request.id, error);
                        case (#ok(())) #ok(store({ latest with mint = ?{ mint with verified_ledger = true }; error = null }));
                    };
                };
            };
        };

        func existing(request : PrepareRequest) : Result<?Intent> {
            switch (Map.get(mem.intents, Blob.compare, request.id)) {
                case null #ok(null);
                case (?intent) {
                    if (intent.quote.ledger != request.ledger or intent.source != request.source or intent.account != lower(request.account) or intent.amount != request.amount or not Ledger.sameSubaccount(intent.subaccount, request.subaccount)) {
                        #err("This bridge request ID belongs to different deposit details");
                    } else #ok(?intent);
                };
            };
        };
        func current(id : Blob, revision : Nat) : Result<Intent> {
            switch (status(id)) {
                case (#err(error)) #err(error);
                case (#ok(intent)) if (intent.revision != revision) #err("Bridge intent changed; reload its saved status before continuing") else #ok(intent);
            };
        };
        func saveStep(intent : Intent, step : Memory.Step) : Intent {
            store({ intent with steps = Array.map<Memory.Step, Memory.Step>(intent.steps, func(old) { if (old.kind == step.kind) step else old }) });
        };
        func saveError(id : Blob, error : Text) : Result<Intent> {
            switch (status(id)) {
                case (#err(message)) #err(message);
                case (#ok(intent)) #ok(store({ intent with error = ?error }));
            };
        };
        func store(intent : Intent) : Intent {
            let updated = { intent with revision = intent.revision + 1; updated_at = Time.now() };
            Map.add(mem.intents, Blob.compare, intent.id, updated);
            updated;
        };
    };

    // Pure reconciliation is independently testable against real Candid event
    // shapes. Only this transaction + log + asset + amount + recipient can mint.
    public func applyEvents(intent : Intent, events : [Minter.Event]) : Intent {
        let hash = switch (intent.steps[2].transaction_hash) { case null return intent; case (?value) value };
        var accepted = intent.accepted_deposit;
        var mint = intent.mint;
        var error = intent.error;
        var index = intent.event_cursor;
        for (event in events.vals()) {
            switch (event.payload) {
                case (?#AcceptedDeposit(value)) {
                    if (intent.quote.token_address == null and matchingDeposit(intent, hash, value)) {
                        accepted := ?{ log_index = value.log_index; block_number = value.block_number; event_index = index };
                    };
                };
                case (?#AcceptedErc20Deposit(value)) {
                    if (intent.quote.token_address == ?lower(value.erc20_contract_address) and matchingDeposit(intent, hash, value)) {
                        accepted := ?{ log_index = value.log_index; block_number = value.block_number; event_index = index };
                    };
                };
                case (?#MintedCkEth(value)) {
                    if (intent.quote.token_address == null and matchingEvent(hash, accepted, value.event_source)) {
                        mint := ?{ ledger_block_index = value.mint_block_index; event_index = index; verified_ledger = false };
                        error := null;
                    };
                };
                case (?#MintedCkErc20(value)) {
                    if (intent.quote.token_address == ?lower(value.erc20_contract_address) and matchingEvent(hash, accepted, value.event_source)) {
                        mint := ?{ ledger_block_index = value.mint_block_index; event_index = index; verified_ledger = false };
                        error := null;
                    };
                };
                case (?#InvalidDeposit(value)) if (lower(value.event_source.transaction_hash) == hash) error := ?("Minter rejected this deposit: " # value.reason);
                case (?#QuarantinedDeposit(value)) if (lower(value.event_source.transaction_hash) == hash) error := ?"Minter quarantined this deposit; it has not completed";
                case (_) {};
            };
            index += 1;
        };
        { intent with accepted_deposit = accepted; mint; error };
    };
    func matchingDeposit(intent : Intent, hash : Text, deposit : Minter.Deposit) : Bool {
        lower(deposit.transaction_hash) == hash and lower(deposit.from_address) == intent.account and deposit.value == intent.amount and deposit.principal == intent.quote.recipient and Ledger.sameSubaccount(deposit.subaccount, intent.subaccount);
    };
    func matchingEvent(hash : Text, accepted : ?Memory.AcceptedDeposit, source : Minter.EventSource) : Bool {
        switch (accepted) { case null false; case (?deposit) lower(source.transaction_hash) == hash and source.log_index == deposit.log_index };
    };
    func stepIndex(kind : Memory.StepKind) : Nat { switch (kind) { case (#reset_approval) 0; case (#approval) 1; case (#deposit) 2 } };
    func lower(value : Text) : Text { Text.toLower(value) };
    func validHex(value : Text, bytes : Nat) : Bool {
        if (value.size() != 2 + bytes * 2) return false;
        let chars = value.chars();
        if (chars.next() != ?'0' or chars.next() != ?'x') return false;
        for (char in chars) if (not (char >= '0' and char <= '9') and not (char >= 'a' and char <= 'f') and not (char >= 'A' and char <= 'F')) return false;
        true;
    };
    func hex(bytes : Blob) : Text {
        let digits : [Char] = ['0','1','2','3','4','5','6','7','8','9','a','b','c','d','e','f'];
        var result = "0x";
        for (byte in bytes.values()) {
            let value = Nat8.toNat(byte);
            result #= Char.toText(digits[value / 16]) # Char.toText(digits[value % 16]);
        };
        result;
    };
    func principalWord(principal : Principal) : Text {
        let bytes = Blob.toArray(Principal.toBlob(principal));
        hex(Blob.fromArray(Array.tabulate<Nat8>(32, func(index) { if (index == 0) Nat8.fromNat(bytes.size()) else if (index <= bytes.size()) bytes[index - 1] else 0 })));
    };
};
