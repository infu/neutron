import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Bridge "../../backend/bridge/Journal";
import Memory "../../backend/memory/wallet_bridge/v1";
import Capabilities "../../backend/capabilities/Types";
import Minter "../../backend/bridge/Minter";
import Ledger "../../backend/bridge/Ledger";

persistent actor {
public func run() : async () {
func ok<T>(result : Bridge.Result<T>) : T { switch (result) { case (#ok(value)) value; case (#err(error)) Runtime.trap(error) } };
func err<T>(result : Bridge.Result<T>) : Bool { switch (result) { case (#err(_)) true; case (_) false } };
let owner = Principal.fromText("aaaaa-aa");
let ledger = Principal.fromText("xevnm-gaaaa-aaaar-qafnq-cai");
let address = "0x1111111111111111111111111111111111111111";
let helper = "0x2222222222222222222222222222222222222222";
let token = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
let hash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
let otherHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
let info : Minter.Info = {
    minter_address = ?address;
    smart_contract_address = null;
    eth_helper_contract_address = null;
    erc20_helper_contract_address = null;
    deposit_with_subaccount_helper_contract_address = ?helper;
    supported_ckerc20_tokens = ?[{ erc20_contract_address = token; ledger_canister_id = ledger }];
    cketh_ledger_id = ?Principal.fromText("ss2fx-dyaaa-aaaar-qacoq-cai");
};
let memory = Memory.init();
var queries = 0;
var eventFeed : [Minter.Event] = [];
var ledgerFeed : ?Ledger.Reply = null;
let calls : Capabilities.BackendCalls = {
    canister_principal = owner;
    can_call = func(_ : Principal, _ : Text) { true };
    call = func(request : Capabilities.CallRequest) : async* Capabilities.CallResult {
        queries += 1;
        switch (request.method) {
            case ("get_minter_info") #ok(to_candid (info));
            case ("get_events") {
                let args : { start : Nat64; length : Nat64 } = switch (from_candid request.args : ?{ start : Nat64; length : Nat64 }) { case (?value) value; case null Runtime.trap("Invalid events arguments") };
                let offset = if (args.start >= 50) Nat64.toNat(args.start - 50) else 0;
                let selected = Array.tabulate<Minter.Event>(if (args.length == 0 or offset >= eventFeed.size()) 0 else eventFeed.size() - offset, func(index) { eventFeed[offset + index] });
                let events : Minter.Events = { events = selected; total_event_count = Nat64.fromNat(50 + eventFeed.size()) };
                #ok(to_candid (events));
            };
            case ("icrc3_get_blocks") switch (ledgerFeed) { case null Runtime.trap("No ledger fixture"); case (?reply) #ok(to_candid (reply)) };
            case (_) Runtime.trap("Unexpected call");
        };
    };
    call_batch = func(_ : [Capabilities.CallRequest]) : async* [Capabilities.CallResult] { Runtime.trap("Unexpected batch") };
};
let service = Bridge.Service(memory, calls);
let id = Blob.fromArray(Array.tabulate<Nat8>(16, func(_) { 7 }));
let prepared = ok(await* service.prepare({ id; ledger; source = #external; account = address; amount = 42; subaccount = null }));
assert queries == 2;
assert prepared.event_cursor == 50;
assert prepared.quote.token_address == ?token;
assert prepared.quote.chain_id == 1;
assert prepared.quote.recipient == owner;
assert prepared.quote.principal_word == "0x0000000000000000000000000000000000000000000000000000000000000000";
let replay = ok(await* service.prepare({ id; ledger; source = #external; account = address; amount = 42; subaccount = null }));
assert replay == prepared;
assert queries == 2;
assert err(await* service.prepare({ id; ledger; source = #external; account = address; amount = 43; subaccount = null }));
// Both intents predate the same mint events. Recovering a lost browser hash
// must attach that execution to exactly one intent, rather than minting twice.
let competingId = Blob.fromArray(Array.tabulate<Nat8>(16, func(_) { 9 }));
let competingPrepared = ok(await* service.prepare({ id = competingId; ledger; source = #external; account = address; amount = 42; subaccount = null }));
let competingClaim = ok(service.claim({ id = competingId; revision = competingPrepared.revision; step = #deposit; operation_id = null }));
assert err(service.recordStep({ id; revision = 0; step = #deposit; state = #submitted; transaction_hash = ?hash; error = null }));
let claimed = ok(service.claim({ id; revision = 0; step = #deposit; operation_id = null }));
assert claimed.steps[2].state == #unknown;
assert err(service.claim({ id; revision = 0; step = #deposit; operation_id = null }));
assert err(service.claim({ id; revision = claimed.revision; step = #deposit; operation_id = null }));
let restoredService = Bridge.Service(memory, calls);
assert ok(restoredService.status(id)).steps[2].state == #unknown;
let submitted = ok(restoredService.recordStep({ id; revision = claimed.revision; step = #deposit; state = #submitted; transaction_hash = ?hash; error = null }));
assert err(service.recordStep({ id = competingId; revision = competingClaim.revision; step = #deposit; state = #submitted; transaction_hash = ?hash; error = null }));
// Canonicalization also catches manual input with uppercase hash digits.
assert err(service.recordStep({ id = competingId; revision = competingClaim.revision; step = #deposit; state = #confirmed; transaction_hash = ?"0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; error = null }));
assert ok(service.status(competingId)).steps[2].transaction_hash == null;
assert err(service.recordStep({ id; revision = submitted.revision; step = #deposit; state = #submitted; transaction_hash = ?otherHash; error = null }));
let confirmed = ok(service.recordStep({ id; revision = submitted.revision; step = #deposit; state = #confirmed; transaction_hash = ?hash; error = null }));
assert ok(service.recordStep({ id; revision = confirmed.revision; step = #deposit; state = #confirmed; transaction_hash = ?hash; error = null })) == confirmed;
assert err(service.recordStep({ id; revision = confirmed.revision; step = #deposit; state = #unknown; transaction_hash = null; error = ?"late timeout" }));
assert confirmed.mint == null;
let accepted : Minter.Erc20Deposit = { transaction_hash = hash; block_number = 100; log_index = 3; from_address = address; value = 42; principal = owner; subaccount = null; erc20_contract_address = token };
let acceptedEvent : Minter.Event = { timestamp = 0; payload = ?#AcceptedErc20Deposit(accepted) };
let mintedEvent : Minter.Event = { timestamp = 1; payload = ?#MintedCkErc20({ event_source = { transaction_hash = hash; log_index = 3 }; erc20_contract_address = token; mint_block_index = 999 }) };
let unrelated : Minter.Event = { timestamp = 0; payload = ?#AcceptedErc20Deposit({ accepted with transaction_hash = otherHash }) };
assert Bridge.applyEvents(confirmed, [unrelated, mintedEvent]).mint == null;
assert Bridge.applyEvents(confirmed, [mintedEvent]).mint == null;
assert Bridge.applyEvents(confirmed, [{ acceptedEvent with payload = ?#AcceptedErc20Deposit({ accepted with value = 43 }) }, mintedEvent]).mint == null;
assert Bridge.applyEvents(confirmed, [{ acceptedEvent with payload = ?#AcceptedErc20Deposit({ accepted with erc20_contract_address = helper }) }, mintedEvent]).mint == null;
let scanned = Bridge.applyEvents(confirmed, [acceptedEvent, mintedEvent]);
assert scanned.mint == ?{ ledger_block_index = 999; event_index = 51; verified_ledger = false };
let firstPage = Bridge.applyEvents(confirmed, [acceptedEvent]);
assert Bridge.applyEvents({ firstPage with event_cursor = 51 }, [mintedEvent]).mint == scanned.mint;
let block : Ledger.Value = #Map([
    ("btype", #Text("1mint")),
    ("tx", #Map([("amt", #Nat(42)), ("to", #Array([#Blob(Principal.toBlob(owner))]))])),
]);
let reply : Ledger.Reply = { blocks = [{ id = 999; block }]; archived_blocks = [] };
assert ok(Ledger.verify(#ok(to_candid (reply)), scanned, 999)) == ();
assert err(Ledger.verify(#ok(to_candid (reply)), scanned, 1000));
let transferBlock : Ledger.Value = #Map([
    ("btype", #Text("1xfer")),
    ("tx", #Map([("amt", #Nat(42)), ("to", #Array([#Blob(Principal.toBlob(owner))]))])),
]);
assert err(Ledger.verify(#ok(to_candid ({ reply with blocks = [{ id = 999; block = transferBlock }] })), scanned, 999));
assert err(Ledger.verify(#ok(to_candid (reply)), { scanned with amount = 43 }, 999));
// Real wire payloads are non-optional and can add variants in later releases.
let wire : { events : [{ timestamp : Nat64; payload : { #FutureAddedVariant : { extra : [Text] }; #AcceptedErc20Deposit : Minter.Erc20Deposit } }]; total_event_count : Nat64 } = {
    events = [
        { timestamp = 0; payload = #FutureAddedVariant({ extra = ["new"] }) },
        { timestamp = 0; payload = #AcceptedErc20Deposit(accepted) },
    ];
    total_event_count = 52;
};
let decoded = ok(Minter.decodeEvents(#ok(to_candid (wire))));
assert decoded.events[0].payload == null;
assert decoded.events[1].payload == ?#AcceptedErc20Deposit(accepted);
assert service.list({ ledger = ?ledger; after = null; limit = 10 }).records.size() == 2;
assert service.list({ ledger = ?ledger; after = ?id; limit = 10 }).records.size() == 1;
// An ETH-only legacy helper cannot silently be advertised for ERC-20.
let legacyInfo = { info with deposit_with_subaccount_helper_contract_address = null; smart_contract_address = ?helper };
let legacyCalls : Capabilities.BackendCalls = { calls with call = func(request : Capabilities.CallRequest) : async* Capabilities.CallResult {
    if (request.method == "get_minter_info") #ok(to_candid (legacyInfo)) else await* calls.call(request);
} };
let legacyService = Bridge.Service(Memory.init(), legacyCalls);
assert err(await* legacyService.quote(ledger));
let ethQuote = ok(await* legacyService.quote(Principal.fromText("ss2fx-dyaaa-aaaar-qacoq-cai")));
assert ethQuote.helper_mode == #legacy and ethQuote.token_address == null;
let wrongLedgerInfo = { info with cketh_ledger_id = ?ledger };
let wrongLedgerCalls : Capabilities.BackendCalls = { calls with call = func(request : Capabilities.CallRequest) : async* Capabilities.CallResult {
    if (request.method == "get_minter_info") #ok(to_candid (wrongLedgerInfo)) else await* calls.call(request);
} };
assert err(await* Bridge.Service(Memory.init(), wrongLedgerCalls).quote(Principal.fromText("ss2fx-dyaaa-aaaar-qacoq-cai")));
// Wrong recipient, source account, subaccount and event log cannot complete it.
let wrongRecipient = { accepted with principal = Principal.fromText("2vxsx-fae") };
let wrongSender = { accepted with from_address = helper };
let nonDefault = Blob.fromArray(Array.tabulate<Nat8>(32, func(_) { 9 }));
let wrongSubaccount = { accepted with subaccount = ?nonDefault };
for (deposit in [wrongRecipient, wrongSender, wrongSubaccount].vals()) {
    assert Bridge.applyEvents(confirmed, [{ acceptedEvent with payload = ?#AcceptedErc20Deposit(deposit) }, mintedEvent]).mint == null;
};
let wrongLog : Minter.Event = { timestamp = 1; payload = ?#MintedCkErc20({ event_source = { transaction_hash = hash; log_index = 4 }; erc20_contract_address = token; mint_block_index = 999 }) };
assert Bridge.applyEvents(confirmed, [acceptedEvent, wrongLog]).mint == null;
let wrongMintToken : Minter.Event = { timestamp = 1; payload = ?#MintedCkErc20({ event_source = { transaction_hash = hash; log_index = 3 }; erc20_contract_address = helper; mint_block_index = 999 }) };
assert Bridge.applyEvents(confirmed, [acceptedEvent, wrongMintToken]).mint == null;
let ethIntent = { confirmed with quote = { confirmed.quote with token_address = null } };
let ethEvents : [Minter.Event] = [
    { timestamp = 0; payload = ?#AcceptedDeposit(accepted) },
    { timestamp = 1; payload = ?#MintedCkEth({ event_source = { transaction_hash = hash; log_index = 3 }; mint_block_index = 999 }) },
];
assert Bridge.applyEvents(ethIntent, ethEvents).mint != null;
assert Bridge.applyEvents(confirmed, ethEvents).mint == null;
// An archived mint can be verified by the catalog-bound index, at exactly the
// minter's block ID. An unrelated transfer, mint or lagging index never proves it.
let archived : Ledger.Reply = { blocks = []; archived_blocks = [{ args = [{ start = 999; length = 1 }] }] };
assert Ledger.isArchived(#ok(to_candid (archived)), 999);
assert not Ledger.isArchived(#ok(to_candid (archived)), 1000);
let indexed : Ledger.IndexReply = #Ok({ transactions = [{ id = 999; transaction = { kind = "mint"; mint = ?{ amount = 42; to = { owner; subaccount = null } } } }] });
assert ok(Ledger.verifyIndex(#ok(to_candid (indexed)), scanned, 999)) == ();
assert err(Ledger.verifyIndex(#ok(to_candid (indexed)), scanned, 998));
assert err(Ledger.verifyIndex(#ok(to_candid (indexed)), { scanned with amount = 43 }, 999));
let indexedTransfer : Ledger.IndexReply = #Ok({ transactions = [{ id = 999; transaction = { kind = "transfer"; mint = ?{ amount = 42; to = { owner; subaccount = null } } } }] });
assert err(Ledger.verifyIndex(#ok(to_candid (indexedTransfer)), scanned, 999));
// Real service refresh resumes its durable cursor, records accepted/minted
// evidence, then proves the exact ledger block before reporting completion.
eventFeed := [acceptedEvent];
let awaiting = ok(await* restoredService.refresh({ id; event_page_length = 100 }));
assert awaiting.event_cursor == 51;
assert awaiting.accepted_deposit != null and awaiting.mint == null;
eventFeed := [acceptedEvent, mintedEvent];
ledgerFeed := ?reply;
let complete = ok(await* restoredService.refresh({ id; event_page_length = 100 }));
assert complete.event_cursor == 52;
assert complete.mint == ?{ ledger_block_index = 999; event_index = 51; verified_ledger = true };
let callsAtCompletion = queries;
assert ok(await* service.refresh({ id; event_page_length = 100 })) == complete;
assert queries == callsAtCompletion;
let competingUnresolved = ok(await* restoredService.refresh({ id = competingId; event_page_length = 100 }));
assert competingUnresolved.steps[2].state == #unknown;
assert competingUnresolved.mint == null and competingUnresolved.accepted_deposit == null;
assert err(service.recordStep({ id = competingId; revision = competingUnresolved.revision; step = #deposit; state = #confirmed; transaction_hash = ?hash; error = null }));
// EVM operations need a saved operation ID; external unknown steps retain their
// missing hash through restoration and cannot be silently returned to ready.
let evmId = Blob.fromArray(Array.tabulate<Nat8>(16, func(_) { 8 }));
let evmIntent = ok(await* service.prepare({ id = evmId; ledger; source = #evm; account = address; amount = 42; subaccount = null }));
assert err(service.claim({ id = evmId; revision = evmIntent.revision; step = #approval; operation_id = null }));
let evmClaim = ok(service.claim({ id = evmId; revision = evmIntent.revision; step = #approval; operation_id = ?"deposit-id:approval" }));
assert evmClaim.steps[1].operation_id == ?"deposit-id:approval";
assert err(service.claim({ id = evmId; revision = evmClaim.revision; step = #deposit; operation_id = ?"deposit-id:deposit" }));
assert err(await* service.prepare({ id = evmId; ledger; source = #evm; account = address; amount = 2 ** 256; subaccount = null }));
// One confirmed approval/reset transaction cannot authorize two steps or be
// reused by another intent, even when the first transaction has completed.
let approvalId = Blob.fromArray(Array.tabulate<Nat8>(16, func(_) { 10 }));
let approvalIntent = ok(await* service.prepare({ id = approvalId; ledger; source = #external; account = address; amount = 42; subaccount = null }));
let resetClaim = ok(service.claim({ id = approvalId; revision = approvalIntent.revision; step = #reset_approval; operation_id = null }));
let resetConfirmed = ok(service.recordStep({ id = approvalId; revision = resetClaim.revision; step = #reset_approval; state = #confirmed; transaction_hash = ?otherHash; error = null }));
let approvalClaim = ok(service.claim({ id = approvalId; revision = resetConfirmed.revision; step = #approval; operation_id = null }));
assert err(service.recordStep({ id = approvalId; revision = approvalClaim.revision; step = #approval; state = #confirmed; transaction_hash = ?otherHash; error = null }));
assert err(service.recordStep({ id = evmId; revision = evmClaim.revision; step = #approval; state = #submitted; transaction_hash = ?otherHash; error = null }));
assert ok(service.status(approvalId)).steps[1].state == #unknown;


};
};
