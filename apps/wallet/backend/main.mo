import Array "mo:core/Array";
import Int "mo:core/Int";
import Iter "mo:core/Iter";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Set "mo:core/Set";
import Text "mo:core/Text";
import Time "mo:core/Time";
import NeutronCapabilities "mo:neutron-capabilities";
import Catalog "./Catalog";
import Capabilities "./capabilities/Types";
import ChainKey "./chainkey/Client";
import Withdrawals "./chainkey/Withdrawals";
import History "./history/Reconcile";
import HistoryStore "./history/Store";
import HistoryTypes "./history/Types";
import Icrc "./icrc1/Client";
import IcrcTypes "./icrc1/Types";
import Memory "./memory/wallet/v1";

module {
    let BATCH_SIZE = 20;
    let DEPOSIT_PROGRESS_LIMIT = 64;
    let MAX_RETAINED_CUSTOM_LEDGERS = 64;
    let MAX_SELECTED_LEDGERS = 16;
    let RECENT_MINTED_LIMIT = 20;

    public type CatalogLedger = {
        principal : Principal;
        index : ?Principal;
        history_kind : Text;
        name : Text;
        symbol : Text;
        price_asset : ?Text;
        networks : [Text];
        native_route : ?CatalogNativeRoute;
    };

    public type CatalogNativeRoute = {
        kind : Text;
        origin_network : Text;
        minter : Principal;
        contract : ?Text;
        gas_ledger : ?Principal;
        native_actions_available : Bool;
    };

    public type NativePendingDeposit = {
        txid : Text;
        vout : Nat;
        value : Nat;
        confirmations : Nat;
        required_confirmations : Nat;
    };

    public type NativeProcessingDeposit = {
        txid : Text;
        vout : Nat;
        value : Nat;
    };

    public type NativeMintedDeposit = {
        txid : Text;
        vout : Nat;
        value : Nat;
        minted_amount : Nat;
        block_index : Nat;
        minted_at : Int;
    };

    public type NativeDepositIssueKind = {
        #value_too_small;
        #tainted;
        #quarantined;
    };

    public type NativeDepositIssue = {
        txid : Text;
        vout : Nat;
        value : Nat;
        kind : NativeDepositIssueKind;
        earliest_retry : ?Nat;
    };

    public type NativeDepositProgress = {
        checked_at : Int;
        current_confirmations : ?Nat;
        required_confirmations : ?Nat;
        pending : [NativePendingDeposit];
        processing : [NativeProcessingDeposit];
        recent_minted : [NativeMintedDeposit];
        issues : [NativeDepositIssue];
    };

    public type LedgerView = {
        id : Nat;
        principal : Principal;
        name : ?Text;
        symbol : ?Text;
        decimals : ?Nat;
        fee : ?Nat;
        logo : ?Text;
        balance : ?Nat;
        metadata_updated_at : ?Int;
        balance_updated_at : ?Int;
        metadata_error : ?Text;
        balance_error : ?Text;
        native_address : ?Text;
        native_address_updated_at : ?Int;
        native_address_error : ?Text;
        native_refresh_updated_at : ?Int;
        native_refresh_error : ?Text;
        native_deposit_progress : ?NativeDepositProgress;
    };

    public type WalletSnapshot = {
        owner : Principal;
        configured : Bool;
        ledgers : [LedgerView];
    };

    public type RefreshReport = {
        attempted : Nat;
        succeeded : Nat;
        failed : Nat;
        stale : Nat;
        snapshot : WalletSnapshot;
    };

    public type DepositRefreshReport = {
        attempted : Nat;
        succeeded : Nat;
        failed : Nat;
        stale : Nat;
        snapshot : WalletSnapshot;
    };

    type NativeCall = {
        ledger : Memory.Ledger;
        request : Capabilities.CallRequest;
        route : Catalog.NativeRoute;
    };

    type NativeCounts = {
        attempted : Nat;
        succeeded : Nat;
        failed : Nat;
        stale : Nat;
    };

    public type ContactKindV1 = {
        #person;
        #self;
    };

    public type DestinationKindV1 = {
        #internet_computer;
        #bitcoin_mainnet;
        #dogecoin_mainnet;
        #ethereum_mainnet;
        #solana_mainnet;
    };

    public type DestinationV1 = {
        #internet_computer : {
            owner : Principal;
            subaccount : ?Blob;
        };
        #bitcoin_mainnet : Text;
        #dogecoin_mainnet : Text;
        #ethereum_mainnet : Text;
        #solana_mainnet : Text;
    };

    public type ContactAddressV1 = {
        id : Nat;
        address_label : ?Text;
        destination : DestinationV1;
        preferred : Bool;
    };

    public type ContactErrorV1 = {
        #validation : Text;
        #not_found : Nat;
        #conflict : { expected : Nat; actual : Nat };
        #limit : Text;
    };

    public type DiscoverContactsRequestV1 = {
        contact_id : ?Nat;
        search_text : Text;
        destination_kinds : [DestinationKindV1];
        offset : Nat;
        limit : Nat;
    };

    public type ContactDestinationV1 = {
        contact_id : Nat;
        contact_revision : Nat;
        contact_kind : ContactKindV1;
        contact_name : Text;
        address : ContactAddressV1;
    };

    public type DiscoverContactsPageV1 = {
        book_revision : Nat;
        destinations : [ContactDestinationV1];
        total : Nat;
        next_offset : ?Nat;
    };

    public type DiscoverContactsResultV1 = {
        #ok : DiscoverContactsPageV1;
        #err : ContactErrorV1;
    };

    public type AppCalls = {
        contacts : {
            contacts_discover_v1 : DiscoverContactsRequestV1 -> DiscoverContactsResultV1;
        };
    };

    public type WalletContactDestinationsRequest = {
        ledger : Principal;
        network : DestinationKindV1;
        search_text : Text;
        offset : Nat;
        limit : Nat;
    };

    public type WalletContactRoute = {
        #icrc;
        #native;
    };

    public type WalletContactDestination = {
        contact_id : Nat;
        contact_revision : Nat;
        contact_kind : ContactKindV1;
        contact_name : Text;
        address : ContactAddressV1;
        route : WalletContactRoute;
    };

    public type WalletContactDestinationsPage = {
        ledger : Principal;
        book_revision : Nat;
        destinations : [WalletContactDestination];
        total : Nat;
        next_offset : ?Nat;
    };

    public type WalletContactDestinationsResult = {
        #ok : WalletContactDestinationsPage;
        #err : Text;
    };

    public type WalletTransferRequest = {
        ledger : Principal;
        network : DestinationKindV1;
        contact_id : Nat;
        contact_revision : Nat;
        address_id : Nat;
        expected_destination : DestinationV1;
        amount : Nat;
    };

    public type WalletTransferReceipt = {
        ledger : Principal;
        native : Bool;
        contact_id : Nat;
        address_id : Nat;
        amount : Nat;
        fee : Nat;
        block_index : Nat;
        secondary_block_index : ?Nat;
        duplicate : Bool;
    };

    public type WalletTransferResult = {
        #ok : WalletTransferReceipt;
        #err : Text;
    };

    public type WalletHistoryOperation = {
        #transfer;
        #mint;
        #burn;
        #approve;
        #authorized_mint;
        #authorized_burn;
    };
    public type WalletHistoryAddress = {
        #icrc : { owner : Principal; subaccount : ?Blob };
        #icp_account_identifier : Blob;
    };
    public type WalletTransferIntent = {
        contact_id : Nat;
        address_id : Nat;
        contact_name : Text;
        address_label : ?Text;
        network : Text;
        destination : Text;
        native : Bool;
    };
    public type WalletNativeHistoryContext = {
        network : Text;
        transaction_id : ?Text;
        output_index : ?Nat;
        related_ledger : ?Principal;
        related_block_index : ?Nat;
    };
    public type WalletHistoryVerification = {
        #pending;
        #verified;
        #prebaseline;
        #unverified_scan_limit;
    };
    public type WalletHistoryTransaction = {
        block_index : Nat;
        operation : WalletHistoryOperation;
        timestamp_ns : Nat64;
        amount : Nat;
        fee : ?Nat;
        balance_effect : Int;
        from : ?WalletHistoryAddress;
        to : ?WalletHistoryAddress;
        spender : ?WalletHistoryAddress;
        memo : ?Blob;
        intent : ?WalletTransferIntent;
        native : ?WalletNativeHistoryContext;
        provenance : { #local_pending; #index; #ledger };
        verification : WalletHistoryVerification;
    };
    public type WalletHistoryAdjustmentKind = {
        #opening_balance;
        #unexplained_balance;
        #scan_limit;
        #unsupported_operation;
    };
    public type WalletHistoryAdjustment = {
        id : Nat;
        kind : WalletHistoryAdjustmentKind;
        ledger : Principal;
        timestamp_ns : Nat64;
        balance_effect : Int;
        previous_balance : Nat;
        observed_balance : Nat;
        from_tip_exclusive : Nat;
        to_tip_exclusive : Nat;
        detail : Text;
    };
    public type WalletHistoryOrderKey = {
        timestamp_ns : Nat64;
        ledger : Principal;
        kind_order : Nat8;
        id : Nat;
    };
    public type WalletHistoryCheckpoint = {
        tip_exclusive : Nat;
        balance : Nat;
        checked_at : Int;
    };
    public type WalletHistorySource = {
        #index : Principal;
        #ledger;
        #unavailable;
    };
    public type WalletHistoryState = {
        #idle;
        #syncing;
        #catching_up;
        #waiting_for_index;
        #permission_required;
        #degraded;
    };
    public type WalletHistoryPageRequest = {
        ledger : ?Principal;
        before : ?WalletHistoryOrderKey;
        limit : Nat;
    };
    public type WalletHistoryRecord = {
        #transaction : {
            ledger : Principal;
            symbol : ?Text;
            decimals : ?Nat;
            logo : ?Text;
            value : WalletHistoryTransaction;
        };
        #adjustment : {
            symbol : ?Text;
            decimals : ?Nat;
            logo : ?Text;
            value : WalletHistoryAdjustment;
        };
    };
    public type WalletHistoryPage = {
        records : [WalletHistoryRecord];
        next : ?WalletHistoryOrderKey;
        inspected : Nat;
        has_more : Bool;
        warning : ?Text;
    };
    public type WalletHistoryLedgerStatus = {
        ledger : Principal;
        symbol : ?Text;
        enabled : Bool;
        source : WalletHistorySource;
        state : WalletHistoryState;
        checkpoint : ?WalletHistoryCheckpoint;
        last_attempt_at : ?Int;
        last_success_at : ?Int;
        last_error : ?Text;
        transaction_count : Nat;
        adjustment_count : Nat;
    };
    public type WalletHistoryStatus = {
        running : Bool;
        ledgers : [WalletHistoryLedgerStatus];
    };
    public type WalletHistorySyncLedgerResult = {
        ledger : Principal;
        status : Text;
        records_added : Nat;
        checkpoint : ?WalletHistoryCheckpoint;
        error : ?Text;
    };
    public type WalletHistorySyncReport = {
        started_at : Int;
        finished_at : Int;
        skipped_overlap : Bool;
        ledgers : [WalletHistorySyncLedgerResult];
    };
    public type WalletHistorySourceStatus = {
        ledger : Principal;
        index : ?Principal;
        ready : Bool;
        missing_methods : [Text];
    };

    type ResolvedTransferDestination = {
        destination : DestinationV1;
        contact_name : Text;
        address_label : ?Text;
    };

    type ParsedMetadata = {
        name : ?Text;
        symbol : ?Text;
        decimals : ?Nat;
        fee : ?Nat;
        logo : ?Text;
    };

    public type AppBackendEnvironment = {
        stable_memory : {
            wallet : Memory.Mem;
        };
        app_calls : AppCalls;
        capabilities : {
            backend_calls : NeutronCapabilities.BackendCallsV1;
        };
    };

    public class Init(env : AppBackendEnvironment) {
        let mem = env.stable_memory.wallet;
        let appCalls = env.app_calls;
        let calls = env.capabilities.backend_calls;
        let history = History.Service(mem, calls);
        var transferInFlight = false;

        public func /*query*/wallet_snapshot(()) : WalletSnapshot {
            snapshot();
        };

        public func /*query*/wallet_catalog(()) : [CatalogLedger] {
            Array.map<Catalog.Ledger, CatalogLedger>(
                Catalog.ledgers,
                func(ledger) {
                    {
                        principal = Principal.fromText(ledger.principal);
                        index = switch (ledger.index) {
                            case null null;
                            case (?value) ?Principal.fromText(value);
                        };
                        history_kind = switch (ledger.history_kind) {
                            case (#icp) "icp";
                            case (#icrc) "icrc";
                        };
                        name = ledger.name;
                        symbol = ledger.symbol;
                        price_asset = switch (ledger.price_asset) {
                            case null null;
                            case (?asset) ?Catalog.priceAssetText(asset);
                        };
                        networks = Array.map<Catalog.Network, Text>(
                            ledger.networks,
                            Catalog.networkText,
                        );
                        native_route = switch (ledger.native_route) {
                            case null null;
                            case (?route) ?catalogRoute(route);
                        };
                    };
                },
            );
        };

        public func /*query*/wallet_history_page(
            request : WalletHistoryPageRequest,
        ) : WalletHistoryPage {
            history.page(request);
        };

        public func /*query*/wallet_history_status(()) : WalletHistoryStatus {
            history.status();
        };

        public func /*query*/wallet_history_sources(()) : [WalletHistorySourceStatus] {
            history.sources();
        };

        public func /*update*/wallet_history_sync(()) : async* WalletHistorySyncReport {
            await* history.sync(true);
        };

        public func /*internal*/wallet_history_tick(
            (),
            /*task_capabilities*/ taskCapabilities : Capabilities.TaskCapabilities,
        ) : async* () {
            await* history.tick(taskCapabilities.backend_calls);
        };

        public func /*query*/wallet_contact_destinations(
            request : WalletContactDestinationsRequest,
        ) : WalletContactDestinationsResult {
            switch (Map.get(mem.ledgers, Principal.compare, request.ledger)) {
                case (?ledger) if (ledger.enabled) {};
                case (_) return #err("Ledger is not selected");
            };
            if (not supportsNetwork(request.ledger, request.network)) {
                return #err("Network is not enabled for this ledger");
            };
            switch (appCalls.contacts.contacts_discover_v1({
                contact_id = null;
                search_text = request.search_text;
                destination_kinds = [request.network];
                offset = request.offset;
                limit = request.limit;
            })) {
                case (#err(error)) #err(contactErrorText(error));
                case (#ok(page)) {
                    #ok({
                        ledger = request.ledger;
                        book_revision = page.book_revision;
                        destinations = Array.map<ContactDestinationV1, WalletContactDestination>(
                            page.destinations,
                            func(destination) {
                                {
                                    contact_id = destination.contact_id;
                                    contact_revision = destination.contact_revision;
                                    contact_kind = destination.contact_kind;
                                    contact_name = destination.contact_name;
                                    address = destination.address;
                                    route = switch (destination.address.destination) {
                                        case (#internet_computer(_)) #icrc;
                                        case (_) #native;
                                    };
                                };
                            },
                        );
                        total = page.total;
                        next_offset = page.next_offset;
                    });
                };
            };
        };

        public func /*update*/wallet_transfer(
            request : WalletTransferRequest,
        ) : async* WalletTransferResult {
            if (request.amount == 0) return #err("Transfer amount must be greater than zero");
            if (transferInFlight) return #err("Another Wallet transfer is in progress");
            let resolved = switch (resolveTransferDestination(request)) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            let catalogLedger = Catalog.find(request.ledger);
            switch (preflightTransfer(request, catalogLedger)) {
                case (#err(error)) return #err(error);
                case (#ok(())) {};
            };

            transferInFlight := true;
            let feeResult = Icrc.decodeFee(await* calls.call(Icrc.feeRequest(request.ledger)));
            let result : WalletTransferResult = switch (feeResult) {
                case (#err(error)) #err("Could not read the current ledger fee: " # error);
                case (#ok(fee)) {
                    switch (validateTransferDestination(request, resolved.destination)) {
                        case (#err(error)) #err(error);
                        case (#ok(())) {
                            switch (request.network) {
                                case (#internet_computer) {
                                    await* transferIcrc(request, resolved, fee);
                                };
                                case (_) {
                                    switch (catalogLedger) {
                                        case null #err("Ledger has no native withdrawal route");
                                        case (?catalog) {
                                            switch (catalog.native_route) {
                                                case null #err("Ledger has no native withdrawal route");
                                                case (?route) {
                                                    await* transferNative(
                                                        request,
                                                        resolved,
                                                        route,
                                                        fee,
                                                    );
                                                };
                                            };
                                        };
                                    };
                                };
                            };
                        };
                    };
                };
            };
            transferInFlight := false;
            result;
        };

        func transferIcrc(
            request : WalletTransferRequest,
            resolved : ResolvedTransferDestination,
            fee : Nat,
        ) : async* WalletTransferResult {
            let account = switch (resolved.destination) {
                case (#internet_computer(value)) value;
                case (_) return #err("Contact destination is not an ICRC account");
            };
            let transfer = Icrc.decodeTransfer(await* calls.call(
                Icrc.transferRequest(
                    request.ledger,
                    account,
                    request.amount,
                    fee,
                    Nat64.fromNat(Int.abs(Time.now())),
                ),
            ));
            switch (transfer) {
                case (#err(error)) #err(error);
                case (#ok(#Ok(blockIndex))) {
                    transferSucceeded(request, resolved, fee, blockIndex, false, null, null);
                    #ok(transferReceipt(request, fee, blockIndex, null, false, false));
                };
                case (#ok(#Err(#Duplicate(value)))) {
                    transferSucceeded(
                        request,
                        resolved,
                        fee,
                        value.duplicate_of,
                        false,
                        null,
                        null,
                    );
                    #ok(transferReceipt(
                        request,
                        fee,
                        value.duplicate_of,
                        null,
                        false,
                        true,
                    ));
                };
                case (#ok(#Err(error))) #err(Icrc.transferErrorText(error));
            };
        };

        func transferNative(
            request : WalletTransferRequest,
            resolved : ResolvedTransferDestination,
            route : Catalog.NativeRoute,
            fee : Nat,
        ) : async* WalletTransferResult {
            let address = switch (nativeAddress(resolved.destination)) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            let withdrawal = await* Withdrawals.withdraw(
                route,
                request.ledger,
                address,
                request.amount,
                fee,
                Nat64.fromNat(Int.abs(Time.now())),
                calls,
                func() { validateTransferDestination(request, resolved.destination) },
            );
            switch (withdrawal) {
                case (#err(error)) #err(error);
                case (#ok(receipt)) {
                    let relatedLedger = switch (receipt.gas_burn) {
                        case null null;
                        case (?gas) ?gas.ledger;
                    };
                    let relatedBlock = switch (receipt.gas_burn) {
                        case null null;
                        case (?gas) ?gas.block_index;
                    };
                    transferSucceeded(
                        request,
                        resolved,
                        fee,
                        receipt.asset_burn.block_index,
                        true,
                        relatedLedger,
                        relatedBlock,
                    );
                    switch (receipt.gas_burn) {
                        case null {};
                        case (?gas) recordSecondaryNativeBurn(
                            request,
                            resolved,
                            receipt.asset_burn,
                            gas,
                        );
                    };
                    #ok(transferReceipt(
                        request,
                        fee,
                        receipt.asset_burn.block_index,
                        relatedBlock,
                        true,
                        false,
                    ));
                };
            };
        };

        public func /*update*/wallet_set_ledgers(
            principals : [Principal],
        ) : async* WalletSnapshot {
            if (principals.size() > MAX_SELECTED_LEDGERS) {
                Runtime.trap("Too many selected ledgers");
            };
            let requested = Set.empty<Principal>();
            var newCustomLedgers = 0;
            var index = 0;
            while (index < principals.size()) {
                let principal = principals[index];
                if (Principal.isAnonymous(principal)) {
                    Runtime.trap("Anonymous is not a ledger principal");
                };
                if (Principal.toText(principal) == "aaaaa-aa") {
                    Runtime.trap("Management canister is not a ledger principal");
                };
                if (principal == calls.canister_principal) {
                    Runtime.trap("Wallet canister is not a ledger principal");
                };
                if (not Set.insert(requested, Principal.compare, principal)) {
                    Runtime.trap("Ledger selection contains a duplicate");
                };
                if (
                    not calls.can_call(principal, "icrc1_metadata") or
                    not calls.can_call(principal, "icrc1_balance_of") or
                    not calls.can_call(principal, "icrc1_fee") or
                    not calls.can_call(principal, "icrc1_transfer")
                ) {
                    Runtime.trap("Ledger is not reserved for Wallet");
                };
                switch (Catalog.find(principal)) {
                    case null {
                        if (not calls.can_call(principal, "icrc3_get_blocks")) {
                            Runtime.trap("Ledger history access is not reserved for Wallet");
                        };
                        switch (Map.get(mem.ledgers, Principal.compare, principal)) {
                            case null newCustomLedgers += 1;
                            case (?_) {};
                        };
                    };
                    case (?catalogLedger) {
                        switch (catalogLedger.index) {
                            case null {
                                switch (catalogLedger.history_kind) {
                                    case (#icp) Runtime.trap(
                                        "Direct ICP ledger history is not supported"
                                    );
                                    case (#icrc) {};
                                };
                                if (not calls.can_call(principal, "icrc3_get_blocks")) {
                                    Runtime.trap("Ledger history access is not reserved for Wallet");
                                };
                            };
                            case (?indexText) {
                                let indexPrincipal = Principal.fromText(indexText);
                                if (not calls.can_call(indexPrincipal, "get_account_transactions")) {
                                    Runtime.trap("Ledger index access is not reserved for Wallet");
                                };
                            };
                        };
                        switch (catalogLedger.native_route) {
                            case null {};
                            case (?route) {
                                if (not calls.can_call(principal, "icrc2_approve")) {
                                    Runtime.trap("Ledger approval access is not reserved for Wallet");
                                };
                                for (required in ChainKey.requiredCalls(route).vals()) {
                                    if (not calls.can_call(required.principal, required.method)) {
                                        Runtime.trap("Native token access is not reserved for Wallet");
                                    };
                                };
                            };
                        };
                    };
                };
                index += 1;
            };
            if (
                retainedCustomLedgerCountAfter(requested) + newCustomLedgers >
                MAX_RETAINED_CUSTOM_LEDGERS
            ) {
                Runtime.trap("Too many retained custom ledgers");
            };

            mem.metadata_epoch += 1;
            mem.balance_epoch += 1;
            mem.native_epoch += 1;
            let nativeEpoch = mem.native_epoch;
            for (principal in principals.vals()) {
                switch (Map.get(mem.ledgers, Principal.compare, principal)) {
                    case (?ledger) setLedgerEnabled(ledger, true);
                    case null {
                        Map.add(
                            mem.ledgers,
                            Principal.compare,
                            principal,
                            newLedger(principal, Catalog.find(principal)),
                        );
                        mem.next_id += 1;
                    };
                };
            };
            let disabled = List.empty<Memory.Ledger>();
            for (ledger in Map.values(mem.ledgers)) {
                if (
                    ledger.enabled and
                    not Set.contains(requested, Principal.compare, ledger.principal)
                ) {
                    List.add(disabled, ledger);
                };
            };
            for (ledger in List.values(disabled)) {
                setLedgerEnabled(ledger, false);
            };
            discardEmptyUnselectedCustomLedgers(requested);
            mem.configured := true;

            let enabled = enabledLedgers();
            if (enabled.size() > 0) {
                ignore await* discoverNativeAddresses(
                    enabled,
                    nativeEpoch,
                );
                ignore await* refreshMetadata(enabled);
                ignore await* history.sync(true);
            };
            snapshot();
        };

        func resolveTransferDestination(
            request : WalletTransferRequest,
        ) : IcrcTypes.Result<ResolvedTransferDestination> {
            switch (Map.get(mem.ledgers, Principal.compare, request.ledger)) {
                case (?ledger) if (ledger.enabled) {};
                case (_) return #err("Ledger is not selected");
            };
            if (not supportsNetwork(request.ledger, request.network)) {
                return #err("Network is not enabled for this ledger");
            };
            if (not destinationMatchesNetwork(request.expected_destination, request.network)) {
                return #err("Approved destination does not match the selected network");
            };
            switch (appCalls.contacts.contacts_discover_v1({
                contact_id = ?request.contact_id;
                search_text = "";
                destination_kinds = [request.network];
                offset = 0;
                limit = 20;
            })) {
                case (#err(error)) #err(contactErrorText(error));
                case (#ok(page)) {
                    var found : ?ContactDestinationV1 = null;
                    for (candidate in page.destinations.vals()) {
                        if (
                            candidate.contact_id == request.contact_id and
                            candidate.address.id == request.address_id
                        ) {
                            found := ?candidate;
                        };
                    };
                    let ?candidate = found else {
                        return #err("Contact destination was not found");
                    };
                    if (candidate.contact_revision != request.contact_revision) {
                        return #err("Contact changed; review the destination again");
                    };
                    if (
                        not destinationsEqual(
                            request.expected_destination,
                            candidate.address.destination,
                        )
                    ) {
                        return #err("Contact destination no longer matches the approved destination");
                    };
                    #ok({
                        destination = candidate.address.destination;
                        contact_name = candidate.contact_name;
                        address_label = candidate.address.address_label;
                    });
                };
            };
        };

        func preflightTransfer(
            request : WalletTransferRequest,
            catalogLedger : ?Catalog.Ledger,
        ) : IcrcTypes.Result<()> {
            let ?selected = Map.get(mem.ledgers, Principal.compare, request.ledger) else {
                return #err("Ledger is not selected");
            };
            if (not selected.enabled) return #err("Ledger is not selected");
            if (selected.decimals == null) {
                return #err("Ledger token decimals are not available");
            };
            if (not calls.can_call(request.ledger, "icrc1_fee")) {
                return #err("Ledger fee access is not reserved for Wallet");
            };
            switch (request.network) {
                case (#internet_computer) {
                    if (not calls.can_call(request.ledger, "icrc1_transfer")) {
                        return #err("Ledger transfer access is not reserved for Wallet");
                    };
                };
                case (_) {
                    let ?catalog = catalogLedger else {
                        return #err("Ledger has no native withdrawal route");
                    };
                    let ?route = catalog.native_route else {
                        return #err("Ledger has no native withdrawal route");
                    };
                    if (not calls.can_call(request.ledger, "icrc2_approve")) {
                        return #err("Ledger approval access is not reserved for Wallet");
                    };
                    for (required in ChainKey.requiredCalls(route).vals()) {
                        if (not calls.can_call(required.principal, required.method)) {
                            return #err("Native withdrawal access is not reserved for Wallet");
                        };
                    };
                };
            };
            #ok(());
        };

        func validateTransferDestination(
            request : WalletTransferRequest,
            expected : DestinationV1,
        ) : Withdrawals.Result<()> {
            switch (resolveTransferDestination(request)) {
                case (#err(error)) #err(error);
                case (#ok(current)) {
                    if (destinationsEqual(expected, current.destination)) #ok(()) else {
                        #err("Contact destination changed before the transfer");
                    };
                };
            };
        };

        func transferSucceeded(
            request : WalletTransferRequest,
            resolved : ResolvedTransferDestination,
            fee : Nat,
            blockIndex : Nat,
            native : Bool,
            relatedLedger : ?Principal,
            relatedBlockIndex : ?Nat,
        ) : () {
            let destination = switch (resolved.destination) {
                case (#internet_computer(account)) ?#icrc(account);
                case (_) null;
            };
            let intent = transferIntent(request, resolved, native);
            let nativeContext : ?Memory.NativeHistoryContext = if (native) {
                ?{
                    network = intent.network;
                    transaction_id = null;
                    output_index = null;
                    related_ledger = relatedLedger;
                    related_block_index = relatedBlockIndex;
                };
            } else null;
            ignore history.recordTransfer(
                request.ledger,
                blockIndex,
                if (native) #burn else #transfer,
                request.amount,
                if (native) null else ?fee,
                destination,
                intent,
                nativeContext,
            );
            mem.balance_epoch += 1;
            let ?current = Map.get(mem.ledgers, Principal.compare, request.ledger) else {
                return;
            };
            Map.add(mem.ledgers, Principal.compare, request.ledger, {
                current with
                fee = ?fee;
                balance_error = null;
            });
        };

        func recordSecondaryNativeBurn(
            request : WalletTransferRequest,
            resolved : ResolvedTransferDestination,
            asset : Withdrawals.BurnReceipt,
            gas : Withdrawals.BurnReceipt,
        ) : () {
            ensureRetainedLedger(gas.ledger);
            let intent = transferIntent(request, resolved, true);
            ignore history.recordTransfer(
                gas.ledger,
                gas.block_index,
                #burn,
                gas.amount,
                null,
                null,
                intent,
                ?{
                    network = intent.network;
                    transaction_id = null;
                    output_index = null;
                    related_ledger = ?asset.ledger;
                    related_block_index = ?asset.block_index;
                },
            );
        };

        func transferIntent(
            request : WalletTransferRequest,
            resolved : ResolvedTransferDestination,
            native : Bool,
        ) : Memory.TransferIntent {
            {
                contact_id = request.contact_id;
                address_id = request.address_id;
                contact_name = boundedText(resolved.contact_name, 128);
                address_label = switch (resolved.address_label) {
                    case null null;
                    case (?value) ?boundedText(value, 128);
                };
                network = Catalog.networkText(toCatalogNetwork(request.network));
                destination = boundedText(destinationText(resolved.destination), 256);
                native;
            };
        };

        func ensureRetainedLedger(principal : Principal) : () {
            switch (Map.get(mem.ledgers, Principal.compare, principal)) {
                case (?_) return;
                case null {};
            };
            let ?catalogLedger = Catalog.find(principal) else return;
            let source : Memory.HistorySource = switch (catalogLedger.index) {
                case null #unavailable;
                case (?value) #index(Principal.fromText(value));
            };
            Map.add(mem.ledgers, Principal.compare, principal, {
                id = mem.next_id;
                principal;
                name = ?catalogLedger.name;
                symbol = ?catalogLedger.symbol;
                decimals = null;
                fee = null;
                logo = null;
                balance = null;
                metadata_updated_at = null;
                balance_updated_at = null;
                metadata_error = null;
                balance_error = null;
                native_address = null;
                native_address_updated_at = null;
                native_address_error = null;
                native_refresh_updated_at = null;
                native_refresh_error = null;
                native_deposit_progress = null;
                enabled = false;
                history = HistoryStore.emptyHistory(source);
            });
            mem.next_id += 1;
        };

        func transferReceipt(
            request : WalletTransferRequest,
            fee : Nat,
            blockIndex : Nat,
            secondaryBlockIndex : ?Nat,
            native : Bool,
            duplicate : Bool,
        ) : WalletTransferReceipt {
            {
                ledger = request.ledger;
                native;
                contact_id = request.contact_id;
                address_id = request.address_id;
                amount = request.amount;
                fee;
                block_index = blockIndex;
                secondary_block_index = secondaryBlockIndex;
                duplicate;
            };
        };

        public func /*update*/wallet_refresh_metadata(()) : async* RefreshReport {
            await* refreshMetadata(enabledLedgers());
        };

        public func /*update*/wallet_refresh_balances(()) : async* RefreshReport {
            await* refreshBalances(enabledLedgers());
        };

        public func /*update*/wallet_refresh_deposits(()) : async* DepositRefreshReport {
            mem.native_epoch += 1;
            let epoch = mem.native_epoch;
            let ledgers = enabledLedgers();
            let discovered = await* discoverNativeAddresses(ledgers, epoch);
            if (mem.native_epoch != epoch) {
                return depositReport(discovered);
            };
            let refreshed = await* refreshNativeDeposits(ledgers, epoch);
            if (mem.native_epoch == epoch) {
                ignore await* history.sync(true);
            };
            depositReport(addNativeCounts(discovered, refreshed));
        };

        func discoverNativeAddresses(
            ledgers : [Memory.Ledger],
            epoch : Nat,
        ) : async* NativeCounts {
            let pending = List.empty<NativeCall>();
            for (ledger in ledgers.vals()) {
                switch (Catalog.find(ledger.principal)) {
                    case null clearNativeAddressError(ledger);
                    case (?catalogLedger) {
                        switch (catalogLedger.native_route) {
                            case null clearNativeAddressError(ledger);
                            case (?route) {
                                switch (ChainKey.addressRequest(
                                    route,
                                    calls.canister_principal,
                                )) {
                                    case null clearNativeAddressError(ledger);
                                    case (?request) {
                                        switch (ledger.native_address) {
                                            case null List.add(pending, { ledger; request; route });
                                            case (?_) clearNativeAddressError(ledger);
                                        };
                                    };
                                };
                            };
                        };
                    };
                };
            };
            let operations = List.toArray(pending);
            if (operations.size() == 0) return emptyNativeCounts();
            let results = await* calls.call_batch(
                Array.map<NativeCall, Capabilities.CallRequest>(
                    operations,
                    func(operation) { operation.request },
                ),
            );
            if (mem.native_epoch != epoch) {
                return {
                    attempted = operations.size();
                    succeeded = 0;
                    failed = 0;
                    stale = operations.size();
                };
            };
            var succeeded = 0;
            var failed = 0;
            var index = 0;
            while (index < operations.size()) {
                let operation = operations[index];
                switch (ChainKey.decodeAddress(results[index])) {
                    case (#ok(address)) {
                        succeeded += 1;
                        updateNativeAddress(operation.ledger, address);
                    };
                    case (#err(error)) {
                        failed += 1;
                        updateNativeAddressError(operation.ledger, error);
                    };
                };
                index += 1;
            };
            {
                attempted = operations.size();
                succeeded;
                failed;
                stale = 0;
            };
        };

        func refreshNativeDeposits(
            ledgers : [Memory.Ledger],
            epoch : Nat,
        ) : async* NativeCounts {
            let pending = List.empty<NativeCall>();
            for (ledger in ledgers.vals()) {
                switch (Catalog.find(ledger.principal)) {
                    case null clearNativeRefreshError(ledger);
                    case (?catalogLedger) {
                        switch (catalogLedger.native_route) {
                            case null clearNativeRefreshError(ledger);
                            case (?route) {
                                switch (ChainKey.refreshRequest(
                                    route,
                                    calls.canister_principal,
                                )) {
                                    case null clearNativeRefreshError(ledger);
                                    case (?request) List.add(pending, { ledger; request; route });
                                };
                            };
                        };
                    };
                };
            };
            let operations = List.toArray(pending);
            if (operations.size() == 0) return emptyNativeCounts();
            let results = await* calls.call_batch(
                Array.map<NativeCall, Capabilities.CallRequest>(
                    operations,
                    func(operation) { operation.request },
                ),
            );
            if (mem.native_epoch != epoch) {
                return {
                    attempted = operations.size();
                    succeeded = 0;
                    failed = 0;
                    stale = operations.size();
                };
            };
            var succeeded = 0;
            var failed = 0;
            var index = 0;
            while (index < operations.size()) {
                let operation = operations[index];
                switch (ChainKey.decodeRefresh(operation.route, results[index])) {
                    case (#ok(progress)) {
                        succeeded += 1;
                        updateNativeRefresh(operation.ledger, operation.route, progress);
                    };
                    case (#err(error)) {
                        failed += 1;
                        updateNativeRefreshError(operation.ledger, error);
                    };
                };
                index += 1;
            };
            {
                attempted = operations.size();
                succeeded;
                failed;
                stale = 0;
            };
        };

        func refreshMetadata(ledgers : [Memory.Ledger]) : async* RefreshReport {
            mem.metadata_epoch += 1;
            let epoch = mem.metadata_epoch;
            var succeeded = 0;
            var failed = 0;
            var stale = 0;
            var offset = 0;
            label batches while (offset < ledgers.size()) {
                let size = min(BATCH_SIZE, ledgers.size() - offset);
                let batch = Array.tabulate<Memory.Ledger>(
                    size,
                    func(index) { ledgers[offset + index] },
                );
                let requests = Array.map<Memory.Ledger, Capabilities.CallRequest>(
                    batch,
                    func(ledger) { Icrc.metadataRequest(ledger.principal) },
                );
                let results = await* calls.call_batch(requests);
                if (mem.metadata_epoch != epoch) {
                    stale := ledgers.size() - offset;
                    break batches;
                };
                var index = 0;
                while (index < batch.size()) {
                    let ledger = batch[index];
                    switch (Icrc.decodeMetadata(results[index])) {
                        case (#err(error)) {
                            failed += 1;
                            updateMetadataError(ledger, error);
                        };
                        case (#ok(metadata)) {
                            switch (parseMetadata(metadata)) {
                                case (#err(error)) {
                                    failed += 1;
                                    updateMetadataError(ledger, error);
                                };
                                case (#ok(parsed)) {
                                    succeeded += 1;
                                    updateMetadata(ledger, parsed);
                                };
                            };
                        };
                    };
                    index += 1;
                };
                offset += size;
            };
            {
                attempted = ledgers.size();
                succeeded;
                failed;
                stale;
                snapshot = snapshot();
            };
        };

        func refreshBalances(ledgers : [Memory.Ledger]) : async* RefreshReport {
            mem.balance_epoch += 1;
            let epoch = mem.balance_epoch;
            var succeeded = 0;
            var failed = 0;
            var stale = 0;
            var offset = 0;
            label batches while (offset < ledgers.size()) {
                let size = min(BATCH_SIZE, ledgers.size() - offset);
                let batch = Array.tabulate<Memory.Ledger>(
                    size,
                    func(index) { ledgers[offset + index] },
                );
                let requests = Array.map<Memory.Ledger, Capabilities.CallRequest>(
                    batch,
                    func(ledger) {
                        Icrc.balanceRequest(ledger.principal, calls.canister_principal);
                    },
                );
                let results = await* calls.call_batch(requests);
                if (mem.balance_epoch != epoch) {
                    stale := ledgers.size() - offset;
                    break batches;
                };
                var index = 0;
                while (index < batch.size()) {
                    let ledger = batch[index];
                    switch (Icrc.decodeBalance(results[index])) {
                        case (#err(error)) {
                            failed += 1;
                            updateBalanceError(ledger, error);
                        };
                        case (#ok(balance)) {
                            succeeded += 1;
                            updateBalance(ledger, balance);
                        };
                    };
                    index += 1;
                };
                offset += size;
            };
            {
                attempted = ledgers.size();
                succeeded;
                failed;
                stale;
                snapshot = snapshot();
            };
        };

        func updateMetadata(ledger : Memory.Ledger, parsed : ParsedMetadata) : () {
            replaceLedger(ledger.id, ledger.principal, func(current) {
                {
                    current with
                    name = prefer(parsed.name, current.name);
                    symbol = prefer(parsed.symbol, current.symbol);
                    decimals = prefer(parsed.decimals, current.decimals);
                    fee = prefer(parsed.fee, current.fee);
                    logo = prefer(parsed.logo, current.logo);
                    metadata_updated_at = ?Time.now();
                    metadata_error = null;
                };
            });
        };

        func updateMetadataError(ledger : Memory.Ledger, error : Text) : () {
            replaceLedger(ledger.id, ledger.principal, func(current) {
                {
                    current with
                    metadata_error = ?boundedText(error, 512);
                };
            });
        };

        func updateBalance(ledger : Memory.Ledger, balance : Nat) : () {
            replaceLedger(ledger.id, ledger.principal, func(current) {
                {
                    current with
                    balance = ?balance;
                    balance_updated_at = ?Time.now();
                    balance_error = null;
                };
            });
        };

        func updateBalanceError(ledger : Memory.Ledger, error : Text) : () {
            replaceLedger(ledger.id, ledger.principal, func(current) {
                {
                    current with
                    balance_error = ?boundedText(error, 512);
                };
            });
        };

        func updateNativeAddress(ledger : Memory.Ledger, address : Text) : () {
            replaceLedger(ledger.id, ledger.principal, func(current) {
                {
                    current with
                    native_address = ?address;
                    native_address_updated_at = ?Time.now();
                    native_address_error = null;
                };
            });
        };

        func updateNativeAddressError(ledger : Memory.Ledger, error : Text) : () {
            replaceLedger(ledger.id, ledger.principal, func(current) {
                {
                    current with
                    native_address_error = ?boundedText(error, 512);
                };
            });
        };

        func clearNativeAddressError(ledger : Memory.Ledger) : () {
            if (ledger.native_address_error == null) return;
            replaceLedger(ledger.id, ledger.principal, func(current) {
                {
                    current with
                    native_address_error = null;
                };
            });
        };

        func nativeDepositProgress(
            value : ChainKey.UtxoRefreshProgress,
            previous : ?Memory.NativeDepositProgress,
            now : Int,
        ) : Memory.NativeDepositProgress {
            {
                checked_at = now;
                current_confirmations = if (value.pending_complete) {
                    value.current_confirmations;
                } else switch (previous) {
                    case null value.current_confirmations;
                    case (?old) old.current_confirmations;
                };
                required_confirmations = if (value.pending_complete) {
                    value.required_confirmations;
                } else switch (previous) {
                    case null value.required_confirmations;
                    case (?old) old.required_confirmations;
                };
                pending = mergePendingDeposits(value, previous);
                processing = Array.map<ChainKey.ProcessingDeposit, Memory.NativeProcessingDeposit>(
                    value.processing,
                    func(deposit) {
                        {
                            txid = deposit.txid;
                            vout = deposit.vout;
                            value = deposit.value;
                        };
                    },
                );
                recent_minted = mergeRecentMinted(value.minted, previous, now);
                issues = Array.map<ChainKey.DepositIssue, Memory.NativeDepositIssue>(
                    value.issues,
                    func(issue) {
                        {
                            txid = issue.txid;
                            vout = issue.vout;
                            value = issue.value;
                            kind = switch (issue.kind) {
                                case (#value_too_small) #value_too_small;
                                case (#tainted) #tainted;
                                case (#quarantined) #quarantined;
                            };
                            earliest_retry = issue.earliest_retry;
                        };
                    },
                );
            };
        };

        func mergePendingDeposits(
            value : ChainKey.UtxoRefreshProgress,
            previous : ?Memory.NativeDepositProgress,
        ) : [Memory.NativePendingDeposit] {
            let result = List.empty<Memory.NativePendingDeposit>();
            let replaced = Set.empty<Text>();
            for (deposit in value.processing.vals()) {
                Set.add(replaced, Text.compare, depositKey(deposit.txid, deposit.vout));
            };
            for (deposit in value.minted.vals()) {
                Set.add(replaced, Text.compare, depositKey(deposit.txid, deposit.vout));
            };
            for (issue in value.issues.vals()) {
                Set.add(replaced, Text.compare, depositKey(issue.txid, issue.vout));
            };
            for (deposit in value.pending.vals()) {
                if (List.size(result) < DEPOSIT_PROGRESS_LIMIT) {
                    let next : Memory.NativePendingDeposit = {
                        txid = deposit.txid;
                        vout = deposit.vout;
                        value = deposit.value;
                        confirmations = deposit.confirmations;
                        required_confirmations = deposit.required_confirmations;
                    };
                    List.add(result, next);
                    Set.add(replaced, Text.compare, depositKey(deposit.txid, deposit.vout));
                };
            };
            if (not value.pending_complete) {
                switch (previous) {
                    case null {};
                    case (?old) {
                        for (deposit in old.pending.vals()) {
                            if (
                                List.size(result) < DEPOSIT_PROGRESS_LIMIT and
                                not Set.contains(
                                    replaced,
                                    Text.compare,
                                    depositKey(deposit.txid, deposit.vout),
                                )
                            ) {
                                List.add(result, deposit);
                            };
                        };
                    };
                };
            };
            List.toArray(result);
        };

        func mergeRecentMinted(
            minted : [ChainKey.MintedDeposit],
            previous : ?Memory.NativeDepositProgress,
            now : Int,
        ) : [Memory.NativeMintedDeposit] {
            let result = List.empty<Memory.NativeMintedDeposit>();
            let seen = Set.empty<Text>();
            for (deposit in minted.vals()) {
                if (List.size(result) < RECENT_MINTED_LIMIT) {
                    let key = depositKey(deposit.txid, deposit.vout);
                    if (Set.insert(seen, Text.compare, key)) {
                        List.add(result, {
                            txid = deposit.txid;
                            vout = deposit.vout;
                            value = deposit.value;
                            minted_amount = deposit.minted_amount;
                            block_index = deposit.block_index;
                            minted_at = now;
                        });
                    };
                };
            };
            switch (previous) {
                case null {};
                case (?old) {
                    for (deposit in old.recent_minted.vals()) {
                        if (List.size(result) < RECENT_MINTED_LIMIT) {
                            let key = depositKey(deposit.txid, deposit.vout);
                            if (Set.insert(seen, Text.compare, key)) {
                                List.add(result, deposit);
                            };
                        };
                    };
                };
            };
            List.toArray(result);
        };

        func depositKey(txid : Text, vout : Nat) : Text {
            txid # ":" # Nat.toText(vout);
        };

        func updateNativeRefresh(
            ledger : Memory.Ledger,
            route : Catalog.NativeRoute,
            progress : ?ChainKey.UtxoRefreshProgress,
        ) : () {
            let now = Time.now();
            switch (progress) {
                case null {};
                case (?value) {
                    for (deposit in value.minted.vals()) {
                        history.recordNativeMint(
                            ledger.principal,
                            deposit.block_index,
                            deposit.minted_amount,
                            {
                                network = Catalog.networkText(nativeRouteNetwork(route));
                                transaction_id = ?boundedText(deposit.txid, 128);
                                output_index = ?deposit.vout;
                                related_ledger = ?ledger.principal;
                                related_block_index = ?deposit.block_index;
                            },
                        );
                    };
                };
            };
            replaceLedger(ledger.id, ledger.principal, func(current) {
                let nextProgress = switch (progress) {
                    case null current.native_deposit_progress;
                    case (?value) ?nativeDepositProgress(
                        value,
                        current.native_deposit_progress,
                        now,
                    );
                };
                {
                    current with
                    native_refresh_updated_at = ?now;
                    native_refresh_error = null;
                    native_deposit_progress = nextProgress;
                };
            });
        };

        func updateNativeRefreshError(ledger : Memory.Ledger, error : Text) : () {
            replaceLedger(ledger.id, ledger.principal, func(current) {
                {
                    current with
                    native_refresh_error = ?boundedText(error, 512);
                };
            });
        };

        func clearNativeRefreshError(ledger : Memory.Ledger) : () {
            if (ledger.native_refresh_error == null) return;
            replaceLedger(ledger.id, ledger.principal, func(current) {
                {
                    current with
                    native_refresh_error = null;
                };
            });
        };

        func depositReport(counts : NativeCounts) : DepositRefreshReport {
            {
                attempted = counts.attempted;
                succeeded = counts.succeeded;
                failed = counts.failed;
                stale = counts.stale;
                snapshot = snapshot();
            };
        };

        func replaceLedger(
            id : Nat,
            principal : Principal,
            update : Memory.Ledger -> Memory.Ledger,
        ) : () {
            let ?current = Map.get(mem.ledgers, Principal.compare, principal) else {
                return;
            };
            if (current.id != id) return;
            Map.add(mem.ledgers, Principal.compare, principal, update(current));
        };

        func newLedger(
            principal : Principal,
            catalogLedger : ?Catalog.Ledger,
        ) : Memory.Ledger {
            let name = switch (catalogLedger) {
                case null null;
                case (?ledger) ?ledger.name;
            };
            let symbol = switch (catalogLedger) {
                case null null;
                case (?ledger) ?ledger.symbol;
            };
            let source : Memory.HistorySource = switch (catalogLedger) {
                case null #unavailable;
                case (?ledger) switch (ledger.index) {
                    case null #unavailable;
                    case (?value) #index(Principal.fromText(value));
                };
            };
            {
                id = mem.next_id;
                principal;
                name;
                symbol;
                decimals = null;
                fee = null;
                logo = null;
                balance = null;
                metadata_updated_at = null;
                balance_updated_at = null;
                metadata_error = null;
                balance_error = null;
                native_address = null;
                native_address_updated_at = null;
                native_address_error = null;
                native_refresh_updated_at = null;
                native_refresh_error = null;
                native_deposit_progress = null;
                enabled = true;
                history = HistoryStore.emptyHistory(source);
            };
        };

        func setLedgerEnabled(ledger : Memory.Ledger, enabled : Bool) : () {
            if (ledger.enabled == enabled) return;
            ledger.history.config_epoch += 1;
            ledger.history.scan := null;
            ledger.history.state := #idle;
            ledger.history.last_error := null;
            Map.add(mem.ledgers, Principal.compare, ledger.principal, {
                ledger with enabled
            });
        };

        let _initializeDefaultLedgers : () = if (mem.configured) {
            ()
        } else {
            for (principalText in Catalog.defaultLedgers.vals()) {
                let principal = Principal.fromText(principalText);
                switch (Map.get(mem.ledgers, Principal.compare, principal)) {
                    case (?ledger) setLedgerEnabled(ledger, true);
                    case null {
                        Map.add(
                            mem.ledgers,
                            Principal.compare,
                            principal,
                            newLedger(principal, Catalog.find(principal)),
                        );
                        mem.next_id += 1;
                    };
                };
            };
            mem.configured := true;
        };

        func enabledCustomLedgers() : [Memory.Ledger] {
            let custom = List.empty<Memory.Ledger>();
            for (ledger in Map.values(mem.ledgers)) {
                if (ledger.enabled) {
                    switch (Catalog.find(ledger.principal)) {
                        case null List.add(custom, ledger);
                        case (?_) {};
                    };
                };
            };
            Array.sort<Memory.Ledger>(
                List.toArray(custom),
                func(left, right) { Nat.compare(left.id, right.id) },
            );
        };

        func customLedgerHasHistory(ledger : Memory.Ledger) : Bool {
            Map.size(ledger.history.transactions) > 0 or
            Map.size(ledger.history.adjustments) > 0;
        };

        func retainedCustomLedgerCountAfter(
            requested : Set.Set<Principal>,
        ) : Nat {
            var count = 0;
            for (ledger in Map.values(mem.ledgers)) {
                switch (Catalog.find(ledger.principal)) {
                    case null {
                        if (
                            Set.contains(requested, Principal.compare, ledger.principal) or
                            customLedgerHasHistory(ledger)
                        ) count += 1;
                    };
                    case (?_) {};
                };
            };
            count;
        };

        func discardEmptyUnselectedCustomLedgers(
            requested : Set.Set<Principal>,
        ) : () {
            let discarded = List.empty<Principal>();
            for (ledger in Map.values(mem.ledgers)) {
                if (
                    not Set.contains(requested, Principal.compare, ledger.principal) and
                    not customLedgerHasHistory(ledger)
                ) {
                    switch (Catalog.find(ledger.principal)) {
                        case null List.add(discarded, ledger.principal);
                        case (?_) {};
                    };
                };
            };
            for (principal in List.values(discarded)) {
                Map.remove(mem.ledgers, Principal.compare, principal);
            };
        };

        func snapshot() : WalletSnapshot {
            let ledgers = List.empty<LedgerView>();
            for (catalogLedger in Catalog.ledgers.vals()) {
                let principal = Principal.fromText(catalogLedger.principal);
                switch (Map.get(mem.ledgers, Principal.compare, principal)) {
                    case (?ledger) if (ledger.enabled) List.add(ledgers, ledger);
                    case null {};
                    case (_) {};
                };
            };
            for (ledger in enabledCustomLedgers().vals()) {
                List.add(ledgers, ledger);
            };
            {
                owner = calls.canister_principal;
                configured = mem.configured;
                ledgers = List.toArray(ledgers);
            };
        };

        func enabledLedgers() : [Memory.Ledger] {
            let result = List.empty<Memory.Ledger>();
            for (catalogLedger in Catalog.ledgers.vals()) {
                let principal = Principal.fromText(catalogLedger.principal);
                switch (Map.get(mem.ledgers, Principal.compare, principal)) {
                    case (?ledger) if (ledger.enabled) List.add(result, ledger);
                    case (_) {};
                };
            };
            for (ledger in enabledCustomLedgers().vals()) {
                List.add(result, ledger);
            };
            List.toArray(result);
        };
    };

    func parseMetadata(metadata : IcrcTypes.Metadata) : IcrcTypes.Result<ParsedMetadata> {
        var name : ?Text = null;
        var symbol : ?Text = null;
        var decimals : ?Nat = null;
        var fee : ?Nat = null;
        var logo : ?Text = null;
        for ((key, value) in metadata.vals()) {
            if (key == "icrc1:name") {
                switch (value) {
                    case (#Text(text)) {
                        if (text.size() > 128) return #err("Ledger name is too long");
                        name := ?text;
                    };
                    case (_) return #err("Ledger name has an unexpected type");
                };
            } else if (key == "icrc1:symbol") {
                switch (value) {
                    case (#Text(text)) {
                        if (text.size() > 32) return #err("Ledger symbol is too long");
                        symbol := ?text;
                    };
                    case (_) return #err("Ledger symbol has an unexpected type");
                };
            } else if (key == "icrc1:decimals") {
                switch (value) {
                    case (#Nat(value)) {
                        if (value > 255) return #err("Ledger decimals are too large");
                        decimals := ?value;
                    };
                    case (_) return #err("Ledger decimals have an unexpected type");
                };
            } else if (key == "icrc1:fee") {
                switch (value) {
                    case (#Nat(value)) fee := ?value;
                    case (_) return #err("Ledger fee has an unexpected type");
                };
            } else if (key == "icrc1:logo") {
                switch (value) {
                    case (#Text(text)) {
                        if (Text.encodeUtf8(text).size() > 32_768) {
                            return #err("Ledger logo is too large");
                        };
                        logo := ?text;
                    };
                    case (_) return #err("Ledger logo has an unexpected type");
                };
            };
        };
        #ok({ name; symbol; decimals; fee; logo });
    };

    func min(left : Nat, right : Nat) : Nat {
        if (left < right) left else right;
    };

    func catalogRoute(route : Catalog.NativeRoute) : CatalogNativeRoute {
        switch (route) {
            case (#ckbtc(value)) {
                {
                    kind = "ckbtc";
                    origin_network = "bitcoin_mainnet";
                    minter = Principal.fromText(value.minter);
                    contract = null;
                    gas_ledger = null;
                    native_actions_available = true;
                };
            };
            case (#cketh(value)) {
                {
                    kind = "cketh";
                    origin_network = "ethereum_mainnet";
                    minter = Principal.fromText(value.minter);
                    contract = null;
                    gas_ledger = null;
                    native_actions_available = true;
                };
            };
            case (#ckerc20(value)) {
                {
                    kind = "ckerc20";
                    origin_network = "ethereum_mainnet";
                    minter = Principal.fromText(value.minter);
                    contract = ?value.contract;
                    gas_ledger = ?Principal.fromText(value.cketh_ledger);
                    native_actions_available = true;
                };
            };
            case (#ckdoge(value)) {
                {
                    kind = "ckdoge";
                    origin_network = "dogecoin_mainnet";
                    minter = Principal.fromText(value.minter);
                    contract = null;
                    gas_ledger = null;
                    native_actions_available = true;
                };
            };
            case (#cksol(value)) {
                {
                    kind = "cksol";
                    origin_network = "solana_mainnet";
                    minter = Principal.fromText(value.minter);
                    contract = null;
                    gas_ledger = null;
                    native_actions_available = true;
                };
            };
        };
    };

    func toCatalogNetwork(network : DestinationKindV1) : Catalog.Network {
        switch (network) {
            case (#internet_computer) #internet_computer;
            case (#bitcoin_mainnet) #bitcoin_mainnet;
            case (#dogecoin_mainnet) #dogecoin_mainnet;
            case (#ethereum_mainnet) #ethereum_mainnet;
            case (#solana_mainnet) #solana_mainnet;
        };
    };

    func supportsNetwork(
        principal : Principal,
        network : DestinationKindV1,
    ) : Bool {
        switch (Catalog.find(principal)) {
            case (?ledger) Catalog.supportsNetwork(ledger, toCatalogNetwork(network));
            case null switch (network) {
                case (#internet_computer) true;
                case (_) false;
            };
        };
    };

    func accountsEqual(left : IcrcTypes.Account, right : IcrcTypes.Account) : Bool {
        left.owner == right.owner and left.subaccount == right.subaccount;
    };

    func destinationMatchesNetwork(
        destination : DestinationV1,
        network : DestinationKindV1,
    ) : Bool {
        switch (destination, network) {
            case (#internet_computer(_), #internet_computer) true;
            case (#bitcoin_mainnet(_), #bitcoin_mainnet) true;
            case (#dogecoin_mainnet(_), #dogecoin_mainnet) true;
            case (#ethereum_mainnet(_), #ethereum_mainnet) true;
            case (#solana_mainnet(_), #solana_mainnet) true;
            case (_) false;
        };
    };

    func destinationsEqual(left : DestinationV1, right : DestinationV1) : Bool {
        switch (left, right) {
            case (#internet_computer(leftAccount), #internet_computer(rightAccount)) {
                accountsEqual(leftAccount, rightAccount);
            };
            case (#bitcoin_mainnet(leftAddress), #bitcoin_mainnet(rightAddress)) {
                leftAddress == rightAddress;
            };
            case (#dogecoin_mainnet(leftAddress), #dogecoin_mainnet(rightAddress)) {
                leftAddress == rightAddress;
            };
            case (#ethereum_mainnet(leftAddress), #ethereum_mainnet(rightAddress)) {
                leftAddress == rightAddress;
            };
            case (#solana_mainnet(leftAddress), #solana_mainnet(rightAddress)) {
                leftAddress == rightAddress;
            };
            case (_) false;
        };
    };

    func nativeAddress(destination : DestinationV1) : IcrcTypes.Result<Text> {
        switch (destination) {
            case (#internet_computer(_)) #err("Contact destination is not a native address");
            case (#bitcoin_mainnet(address)) #ok(address);
            case (#dogecoin_mainnet(address)) #ok(address);
            case (#ethereum_mainnet(address)) #ok(address);
            case (#solana_mainnet(address)) #ok(address);
        };
    };

    func destinationText(destination : DestinationV1) : Text {
        switch (destination) {
            case (#internet_computer(account)) {
                Principal.toText(account.owner) # (switch (account.subaccount) {
                    case null "";
                    case (?value) ":" # blobHex(value);
                });
            };
            case (#bitcoin_mainnet(address)) address;
            case (#dogecoin_mainnet(address)) address;
            case (#ethereum_mainnet(address)) address;
            case (#solana_mainnet(address)) address;
        };
    };

    func blobHex(value : Blob) : Text {
        let digits = [
            "0", "1", "2", "3", "4", "5", "6", "7",
            "8", "9", "a", "b", "c", "d", "e", "f",
        ];
        var result = "";
        var count = 0;
        for (byte in value.vals()) {
            if (count < 32) {
                let number = Nat8.toNat(byte);
                result #= digits[number / 16] # digits[number % 16];
                count += 1;
            };
        };
        result;
    };

    func nativeRouteNetwork(route : Catalog.NativeRoute) : Catalog.Network {
        switch (route) {
            case (#ckbtc(_)) #bitcoin_mainnet;
            case (#ckdoge(_)) #dogecoin_mainnet;
            case (#cketh(_)) #ethereum_mainnet;
            case (#ckerc20(_)) #ethereum_mainnet;
            case (#cksol(_)) #solana_mainnet;
        };
    };

    func contactErrorText(error : ContactErrorV1) : Text {
        switch (error) {
            case (#validation(message)) message;
            case (#limit(message)) message;
            case (#not_found(id)) "Contact " # Nat.toText(id) # " was not found";
            case (#conflict(value)) {
                "Contact revision conflict: expected " # Nat.toText(value.expected) #
                ", current " # Nat.toText(value.actual)
            };
        };
    };

    func prefer<T>(next : ?T, current : ?T) : ?T {
        switch (next) {
            case (?value) ?value;
            case (null) current;
        };
    };

    func boundedText(value : Text, limit : Nat) : Text {
        if (value.size() <= limit) return value;
        Text.fromIter(Iter.take(value.chars(), limit));
    };

    func emptyNativeCounts() : NativeCounts {
        {
            attempted = 0;
            succeeded = 0;
            failed = 0;
            stale = 0;
        };
    };

    func addNativeCounts(left : NativeCounts, right : NativeCounts) : NativeCounts {
        {
            attempted = left.attempted + right.attempted;
            succeeded = left.succeeded + right.succeeded;
            failed = left.failed + right.failed;
            stale = left.stale + right.stale;
        };
    };

/*---NEUTRON GENERATED BEGIN---*/

public type wallet_snapshot_Input = (());
public type wallet_snapshot_Output = WalletSnapshot;

public type wallet_catalog_Input = (());
public type wallet_catalog_Output = [CatalogLedger];

public type wallet_history_page_Input = (request : WalletHistoryPageRequest,);
public type wallet_history_page_Output = WalletHistoryPage;

public type wallet_history_status_Input = (());
public type wallet_history_status_Output = WalletHistoryStatus;

public type wallet_history_sources_Input = (());
public type wallet_history_sources_Output = [WalletHistorySourceStatus];

public type wallet_history_sync_Input = (());
public type wallet_history_sync_Output = WalletHistorySyncReport;

public type wallet_history_tick_Input = (());
public type wallet_history_tick_Output = ();

public type wallet_contact_destinations_Input = (request : WalletContactDestinationsRequest,);
public type wallet_contact_destinations_Output = WalletContactDestinationsResult;

public type wallet_transfer_Input = (request : WalletTransferRequest,);
public type wallet_transfer_Output = WalletTransferResult;

public type wallet_set_ledgers_Input = (principals : [Principal],);
public type wallet_set_ledgers_Output = WalletSnapshot;

public type wallet_refresh_metadata_Input = (());
public type wallet_refresh_metadata_Output = RefreshReport;

public type wallet_refresh_balances_Input = (());
public type wallet_refresh_balances_Output = RefreshReport;

public type wallet_refresh_deposits_Input = (());
public type wallet_refresh_deposits_Output = DepositRefreshReport;

/*---NEUTRON GENERATED END---*/
};
