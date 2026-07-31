import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Error "mo:core/Error";
import Int "mo:core/Int";
import Iter "mo:core/Iter";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Time "mo:core/Time";
import Catalog "../Catalog";
import Capabilities "../capabilities/Types";
import IcrcClient "../icrc1/Client";
import Memory "../memory/wallet/v1";
import AccountIdentifier "AccountIdentifier";
import IcpIndex "IcpIndex";
import IcrcIndex "IcrcIndex";
import IcrcLedger "IcrcLedger";
import Store "Store";
import Types "Types";

module {
    let SYNC_INTERVAL_NS : Int = 43_200_000_000_000;
    let PAGE_SIZE = 1_000;
    // Sixteen balance reads plus one source anchor and four pages per ledger
    // stays below the scheduled task's 100-call budget.
    let PAGES_PER_INVOCATION = 4;
    let ABSOLUTE_PAGE_LIMIT = 50;
    let CANDIDATE_LIMIT = 50_000;
    let MAX_PAGE_LIMIT = 100;
    let MAX_INSPECTED = 1_000;

    public type HistoryRoute = {
        #index : { principal : Principal; kind : Catalog.HistoryKind };
        #icrc3_ledger;
        #unsupported;
    };

    public func historyRoute(ledger : Principal) : HistoryRoute {
        switch (Catalog.find(ledger)) {
            case null #icrc3_ledger;
            case (?catalogLedger) switch (catalogLedger.index) {
                case (?value) #index({
                    principal = Principal.fromText(value);
                    kind = catalogLedger.history_kind;
                });
                case null {
                    if (catalogLedger.history_kind == #icrc) #icrc3_ledger else #unsupported;
                };
            };
        };
    };

    public func balanceNeedsHistory(
        scan : ?Memory.HistoryScan,
        checkpoint : ?Memory.HistoryCheckpoint,
        observedBalance : Nat,
    ) : Bool {
        switch (scan, checkpoint) {
            case (null, ?value) value.balance != observedBalance;
            case (_) true;
        };
    };

    public func exactBalanceDelta(
        previousBalance : Nat,
        targetBalance : Nat,
        effect : Int,
    ) : Bool {
        effect == Int.fromNat(targetBalance) - Int.fromNat(previousBalance);
    };

    public class Service(
        mem : Memory.Mem,
        calls : Capabilities.BackendCalls,
    ) {
        var running = false;

        do {
            for (ledger in Map.values(mem.ledgers)) {
                if (ledger.history.state == #syncing) ledger.history.state := #idle;
            };
        };

        public func page(request : Types.PageRequest) : Types.Page {
            let limit = if (request.limit == 0) 40 else Nat.min(request.limit, MAX_PAGE_LIMIT);
            let records = List.empty<Types.Record>();
            var inspected = 0;
            var dangling = 0;
            var lastInspected : ?Memory.HistoryOrderKey = null;
            let entries = switch (request.before) {
                case null Map.reverseEntries(mem.activity_order);
                case (?cursor) Map.reverseEntriesFrom(
                    mem.activity_order,
                    Store.compareOrderKey,
                    cursor,
                );
            };
            label rows for ((key, reference) in entries) {
                if (inspected >= MAX_INSPECTED or List.size(records) >= limit) break rows;
                if (request.before == ?key) continue rows;
                inspected += 1;
                lastInspected := ?key;
                if (matchesLedger(reference, request.ledger)) {
                    switch (Store.recordFor(mem, reference)) {
                        case null dangling += 1;
                        case (?#transaction(value)) {
                            List.add(records, #transaction({
                                ledger = value.ledger;
                                symbol = ledgerSymbol(value.ledger);
                                decimals = ledgerDecimals(value.ledger);
                                logo = ledgerLogo(value.ledger);
                                value = value.value;
                            }));
                        };
                        case (?#adjustment(value)) {
                            List.add(records, #adjustment({
                                symbol = ledgerSymbol(value.ledger);
                                decimals = ledgerDecimals(value.ledger);
                                logo = ledgerLogo(value.ledger);
                                value;
                            }));
                        };
                    };
                };
            };
            let hasMore = List.size(records) >= limit or inspected >= MAX_INSPECTED;
            {
                records = List.toArray(records);
                next = if (hasMore) lastInspected else null;
                inspected;
                has_more = hasMore;
                warning = if (dangling == 0) null else {
                    ?("Skipped " # Nat.toText(dangling) # " invalid activity reference(s)");
                };
            };
        };

        public func status() : Types.Status {
            let ledgers = List.empty<Types.LedgerStatus>();
            for (catalogLedger in Catalog.ledgers.vals()) {
                let principal = Principal.fromText(catalogLedger.principal);
                switch (Map.get(mem.ledgers, Principal.compare, principal)) {
                    case null {};
                    case (?ledger) List.add(ledgers, {
                        ledger = principal;
                        symbol = ledger.symbol;
                        enabled = ledger.enabled;
                        source = reportedSource(ledger);
                        state = ledger.history.state;
                        checkpoint = ledger.history.checkpoint;
                        last_attempt_at = ledger.history.last_attempt_at;
                        last_success_at = ledger.history.last_success_at;
                        last_error = ledger.history.last_error;
                        transaction_count = Map.size(ledger.history.transactions);
                        adjustment_count = Map.size(ledger.history.adjustments);
                    });
                };
            };
            let custom = List.empty<Memory.Ledger>();
            for (ledger in Map.values(mem.ledgers)) {
                switch (Catalog.find(ledger.principal)) {
                    case null List.add(custom, ledger);
                    case (?_) {};
                };
            };
            for (ledger in Array.sort<Memory.Ledger>(
                List.toArray(custom),
                func(left, right) { Nat.compare(left.id, right.id) },
            ).vals()) {
                List.add(ledgers, {
                    ledger = ledger.principal;
                    symbol = ledger.symbol;
                    enabled = ledger.enabled;
                    source = #ledger;
                    state = ledger.history.state;
                    checkpoint = ledger.history.checkpoint;
                    last_attempt_at = ledger.history.last_attempt_at;
                    last_success_at = ledger.history.last_success_at;
                    last_error = ledger.history.last_error;
                    transaction_count = Map.size(ledger.history.transactions);
                    adjustment_count = Map.size(ledger.history.adjustments);
                });
            };
            { running; ledgers = List.toArray(ledgers) };
        };

        public func sources() : [Types.SourceStatus] {
            let result = List.empty<Types.SourceStatus>();
            let selected = List.empty<Memory.Ledger>();
            for (ledger in Map.values(mem.ledgers)) {
                if (ledger.enabled) List.add(selected, ledger);
            };
            for (ledger in Array.sort<Memory.Ledger>(
                List.toArray(selected),
                func(left, right) { Nat.compare(left.id, right.id) },
            ).vals()) {
                let missing = List.empty<Text>();
                let route = historyRoute(ledger.principal);
                let index = switch (route) {
                    case (#index(value)) ?value.principal;
                    case (_) null;
                };
                switch (route) {
                    case (#index(value)) {
                        if (not calls.can_call(value.principal, "get_account_transactions")) {
                            List.add(
                                missing,
                                Principal.toText(value.principal) # ":get_account_transactions",
                            );
                        };
                    };
                    case (#icrc3_ledger) {
                        if (not calls.can_call(ledger.principal, "icrc3_get_blocks")) {
                            List.add(
                                missing,
                                Principal.toText(ledger.principal) # ":icrc3_get_blocks",
                            );
                        };
                    };
                    case (#unsupported) List.add(
                        missing,
                        "Direct ICP ledger history is not supported",
                    );
                };
                List.add(result, {
                    ledger = ledger.principal;
                    index;
                    ready = List.size(missing) == 0;
                    missing_methods = List.toArray(missing);
                });
            };
            List.toArray(result);
        };

        public func sync(force : Bool) : async* Types.SyncReport {
            await* syncWith(calls, force);
        };

        func syncWith(
            activeCalls : Capabilities.BackendCalls,
            force : Bool,
        ) : async* Types.SyncReport {
            let startedAt = Time.now();
            if (running) {
                return {
                    started_at = startedAt;
                    finished_at = Time.now();
                    skipped_overlap = true;
                    ledgers = [];
                };
            };
            running := true;
            let eligible = List.empty<Memory.Ledger>();
            for (ledger in Map.values(mem.ledgers)) {
                if (ledger.enabled and (force or isDue(ledger))) {
                    List.add(eligible, ledger);
                };
            };
            let selected = Array.sort<Memory.Ledger>(
                List.toArray(eligible),
                func(left, right) { Nat.compare(left.id, right.id) },
            );
            let refreshed = await* refreshBalances(
                activeCalls,
                selected,
            );
            let results = List.empty<Types.SyncLedgerResult>();
            for (selection in selected.vals()) {
                switch (Map.get(mem.ledgers, Principal.compare, selection.principal)) {
                    case (?ledger) if (ledger.enabled and ledger.id == selection.id) {
                        let ledgerResult = if (not containsPrincipal(refreshed, ledger.principal)) {
                            fail(
                                ledger,
                                switch (ledger.balance_error) {
                                    case null "Balance refresh became stale before history sync";
                                    case (?error) "Could not refresh balance before history sync: " # error;
                                },
                                #degraded,
                            );
                        } else try {
                            switch (historyRoute(ledger.principal)) {
                                case (#index(route)) await* syncIndexedLedger(
                                    activeCalls,
                                    ledger,
                                    route.kind,
                                    route.principal,
                                );
                                case (#icrc3_ledger) await* syncDirectLedger(
                                    activeCalls,
                                    ledger,
                                );
                                case (#unsupported) fail(
                                    ledger,
                                    "Direct ICP ledger history is not supported",
                                    #degraded,
                                );
                            };
                        } catch (error) {
                            fail(
                                ledger,
                                "History sync failed: " # Error.message(error),
                                #degraded,
                            );
                        };
                        List.add(results, ledgerResult);
                    };
                    case (_) {};
                };
            };
            running := false;
            {
                started_at = startedAt;
                finished_at = Time.now();
                skipped_overlap = false;
                ledgers = List.toArray(results);
            };
        };

        public func tick(activeCalls : Capabilities.BackendCalls) : async* () {
            ignore await* syncWith(activeCalls, false);
        };

        func refreshBalances(
            activeCalls : Capabilities.BackendCalls,
            ledgers : [Memory.Ledger],
        ) : async* [Principal] {
            if (ledgers.size() == 0) return [];
            mem.balance_epoch += 1;
            let epoch = mem.balance_epoch;
            let requests = Array.map<Memory.Ledger, Capabilities.CallRequest>(
                ledgers,
                func(ledger) {
                    IcrcClient.balanceRequest(
                        ledger.principal,
                        activeCalls.canister_principal,
                    );
                },
            );
            let replies = await* activeCalls.call_batch(requests);
            if (mem.balance_epoch != epoch or replies.size() != ledgers.size()) return [];
            let refreshed = List.empty<Principal>();
            var index = 0;
            while (index < ledgers.size()) {
                let ledger = ledgers[index];
                switch (IcrcClient.decodeBalance(replies[index])) {
                    case (#err(error)) cacheBalanceError(ledger, error);
                    case (#ok(balance)) {
                        cacheBalance(ledger, balance);
                        List.add(refreshed, ledger.principal);
                    };
                };
                index += 1;
            };
            List.toArray(refreshed);
        };

        func containsPrincipal(values : [Principal], principal : Principal) : Bool {
            for (value in values.vals()) if (value == principal) return true;
            false;
        };

        public func recordTransfer(
            ledgerPrincipal : Principal,
            blockIndex : Nat,
            operation : Memory.HistoryOperation,
            amount : Nat,
            fee : ?Nat,
            destination : ?Memory.HistoryAddress,
            intent : Memory.TransferIntent,
            native : ?Memory.NativeHistoryContext,
        ) : Types.Result<()> {
            let ?ledger = Map.get(mem.ledgers, Principal.compare, ledgerPrincipal) else {
                return #err("Ledger is not configured");
            };
            let effectFee = switch (fee) { case null 0; case (?value) value };
            // The ICP index returns legacy account identifiers even when its
            // request uses an ICRC account, so store local ICP receipts alike.
            let canonicalDestination = switch (destination) {
                case (?#icrc(account)) ?historyAddress(ledgerPrincipal, account);
                case (_) destination;
            };
            switch (Map.get(ledger.history.transactions, Nat.compare, blockIndex)) {
                case (?existing) {
                    if (existing.amount != amount) {
                        return #err("Block already has a conflicting Wallet amount");
                    };
                    switch (existing.intent) {
                        case (?previous) {
                            if (not intentsEqual(previous, intent)) {
                                return #err("Block already has a conflicting Wallet destination");
                            };
                        };
                        case (_) {};
                    };
                    let merged = {
                        existing with
                        intent = ?intent;
                        native = preferNative(native, existing.native);
                    };
                    ignore Store.putTransaction(mem, ledgerPrincipal, merged);
                    #ok(());
                };
                case null {
                    let transaction : Memory.HistoryTransaction = {
                        block_index = blockIndex;
                        operation;
                        timestamp_ns = Store.nowNanos();
                        amount;
                        fee;
                        balance_effect = -Int.fromNat(amount + effectFee);
                        from = ?historyAddress(ledgerPrincipal, {
                            owner = calls.canister_principal;
                            subaccount = null;
                        });
                        to = canonicalDestination;
                        spender = null;
                        memo = null;
                        intent = ?intent;
                        native;
                        provenance = #local_pending;
                        verification = #pending;
                    };
                    if (Store.putTransaction(mem, ledgerPrincipal, transaction)) {
                        #ok(());
                    } else #err("Ledger disappeared while recording transfer");
                };
            };
        };

        public func recordNativeMint(
            ledgerPrincipal : Principal,
            blockIndex : Nat,
            amount : Nat,
            native : Memory.NativeHistoryContext,
        ) : () {
            let ?ledger = Map.get(mem.ledgers, Principal.compare, ledgerPrincipal) else return;
            switch (Map.get(ledger.history.transactions, Nat.compare, blockIndex)) {
                case (?existing) {
                    ignore Store.putTransaction(mem, ledgerPrincipal, {
                        existing with native = preferNative(?native, existing.native)
                    });
                };
                case null {
                    ignore Store.putTransaction(mem, ledgerPrincipal, {
                        block_index = blockIndex;
                        operation = #mint;
                        timestamp_ns = Store.nowNanos();
                        amount;
                        fee = null;
                        balance_effect = Int.fromNat(amount);
                        from = null;
                        to = ?#icrc({ owner = calls.canister_principal; subaccount = null });
                        spender = null;
                        memo = null;
                        intent = null;
                        native = ?native;
                        provenance = #local_pending;
                        verification = #pending;
                    });
                };
            };
        };

        func syncIndexedLedger(
            activeCalls : Capabilities.BackendCalls,
            ledger : Memory.Ledger,
            historyKind : Catalog.HistoryKind,
            indexPrincipal : Principal,
        ) : async* Types.SyncLedgerResult {
            ledger.history.last_attempt_at := ?Time.now();
            ledger.history.state := #syncing;
            let configEpoch = ledger.history.config_epoch;
            let observedBalance = switch (ledger.balance, ledger.balance_error) {
                case (?balance, null) balance;
                case (_, ?error) {
                    return fail(
                        ledger,
                        "Could not refresh balance before history sync: " # error,
                        #degraded,
                    );
                };
                case (null, null) {
                    return fail(ledger, "Wallet balance is unavailable", #degraded);
                };
            };

            if (not balanceNeedsHistory(
                ledger.history.scan,
                ledger.history.checkpoint,
                observedBalance,
            )) {
                switch (ledger.history.checkpoint) {
                    case (?checkpoint) {
                        ledger.history.checkpoint := ?{
                            checkpoint with checked_at = Time.now()
                        };
                        ledger.history.state := #idle;
                        ledger.history.last_error := null;
                        return success(ledger, "unchanged", 0);
                    };
                    case null {};
                };
            };

            if (not sourceReady(activeCalls, indexPrincipal)) {
                return fail(ledger, "History source access has not been approved", #permission_required);
            };
            ledger.history.source := #index(indexPrincipal);

            switch (ledger.history.checkpoint) {
                case null {
                    let anchor = switch (await* captureAccountAnchor(
                        activeCalls,
                        historyKind,
                        indexPrincipal,
                    )) {
                        case (#err(error)) return fail(ledger, error, #degraded);
                        case (#ok(value)) value;
                    };
                    if (anchor.balance != observedBalance) {
                        return fail(ledger, "History index is still catching up", #waiting_for_index);
                    };
                    if (not stillCurrent(ledger, configEpoch)) {
                        return stale(ledger, "Ledger configuration changed during baseline");
                    };
                    establishBaseline(ledger, anchor);
                    return success(ledger, "baseline", 0);
                };
                case (?_) {};
            };

            let scan = switch (ledger.history.scan) {
                case (?existing) {
                    if (
                        existing.index != indexPrincipal or
                        existing.config_epoch != configEpoch
                    ) {
                        ledger.history.scan := null;
                        return fail(
                            ledger,
                            "Discarded stale history scan; retry",
                            #idle,
                        );
                    };
                    existing;
                };
                case null {
                    let anchor = switch (await* captureAccountAnchor(
                        activeCalls,
                        historyKind,
                        indexPrincipal,
                    )) {
                        case (#err(error)) return fail(ledger, error, #degraded);
                        case (#ok(value)) value;
                    };
                    if (anchor.balance != observedBalance) {
                        return fail(ledger, "History index is still catching up", #waiting_for_index);
                    };
                    let ?checkpoint = ledger.history.checkpoint else {
                        return fail(ledger, "History checkpoint disappeared", #degraded);
                    };
                    if (anchor.tip_exclusive < checkpoint.tip_exclusive) {
                        return fail(ledger, "History index is still catching up", #waiting_for_index);
                    };
                    {
                        index = indexPrincipal;
                        from_tip_exclusive = checkpoint.tip_exclusive;
                        target_tip_exclusive = anchor.tip_exclusive;
                        previous_balance = checkpoint.balance;
                        target_balance = anchor.balance;
                        cursor = ?anchor.tip_exclusive;
                        candidates = Map.empty<Nat, Memory.HistoryTransaction>();
                        unsupported_block_ids = [];
                        page_count = 0;
                        started_at = Time.now();
                        config_epoch = configEpoch;
                    };
                };
            };

            var staged = scan;
            var complete = scan.target_tip_exclusive == scan.from_tip_exclusive;
            var pages = 0;
            label paging while (not complete and pages < PAGES_PER_INVOCATION) {
                if (staged.page_count >= ABSOLUTE_PAGE_LIMIT) break paging;
                let cursor = boundedScanCursor(
                    staged.cursor,
                    staged.target_tip_exclusive,
                );
                let page = switch (decodePage(
                    historyKind,
                    await* activeCalls.call(pageRequest(
                        historyKind,
                        indexPrincipal,
                        activeCalls.canister_principal,
                        cursor,
                    )),
                    activeCalls.canister_principal,
                    cursor,
                    staged.from_tip_exclusive,
                    staged.target_tip_exclusive,
                )) {
                    case (#err(error)) return fail(ledger, error, #degraded);
                    case (#ok(value)) value;
                };
                if (not stillCurrent(ledger, configEpoch)) {
                    return stale(ledger, "Ledger configuration changed during history paging");
                };
                for (transaction in page.transactions.vals()) {
                    Map.add(
                        staged.candidates,
                        Nat.compare,
                        transaction.block_index,
                        transaction,
                    );
                };
                if (Map.size(staged.candidates) > CANDIDATE_LIMIT) {
                    return commitScanLimit(ledger, staged, "Account history exceeded 50,000 records");
                };
                let unsupported = Array.concat(
                    staged.unsupported_block_ids,
                    page.unsupported_block_ids,
                );
                complete := page.crossed_floor or page.next_cursor == null;
                staged := {
                    staged with
                    cursor = page.next_cursor;
                    unsupported_block_ids = unsupported;
                    page_count = staged.page_count + 1;
                };
                ledger.history.scan := ?staged;
                pages += 1;
            };

            if (not complete) {
                if (staged.page_count >= ABSOLUTE_PAGE_LIMIT) {
                    return commitScanLimit(ledger, staged, "History scan reached its absolute page limit");
                };
                ledger.history.state := #catching_up;
                ledger.history.last_error := null;
                return result(ledger, "catching_up", 0, null);
            };
            commitComplete(ledger, staged, observedBalance);
        };

        func syncDirectLedger(
            activeCalls : Capabilities.BackendCalls,
            ledger : Memory.Ledger,
        ) : async* Types.SyncLedgerResult {
            ledger.history.last_attempt_at := ?Time.now();
            ledger.history.state := #syncing;
            let configEpoch = ledger.history.config_epoch;
            let observedBalance = switch (ledger.balance, ledger.balance_error) {
                case (?balance, null) balance;
                case (_, ?error) {
                    return fail(
                        ledger,
                        "Could not refresh balance before history sync: " # error,
                        #degraded,
                    );
                };
                case (null, null) {
                    return fail(ledger, "Wallet balance is unavailable", #degraded);
                };
            };

            if (not balanceNeedsHistory(
                ledger.history.scan,
                ledger.history.checkpoint,
                observedBalance,
            )) {
                switch (ledger.history.checkpoint) {
                    case (?checkpoint) {
                        ledger.history.checkpoint := ?{
                            checkpoint with checked_at = Time.now()
                        };
                        ledger.history.state := #idle;
                        ledger.history.last_error := null;
                        return success(ledger, "unchanged", 0);
                    };
                    case null {};
                };
            };

            if (not activeCalls.can_call(ledger.principal, "icrc3_get_blocks")) {
                return fail(
                    ledger,
                    "Direct ledger history access has not been approved",
                    #permission_required,
                );
            };
            // The stable v1 source enum predates direct scans. Public status is
            // derived from the permanent catalog selection and reports #ledger.
            ledger.history.source := #unavailable;

            switch (ledger.history.checkpoint) {
                case null {
                    let target = switch (IcrcLedger.decodeTip(
                        await* activeCalls.call(IcrcLedger.tipRequest(ledger.principal))
                    )) {
                        case (#err(error)) return fail(ledger, error, #degraded);
                        case (#ok(value)) value;
                    };
                    if (not stillCurrent(ledger, configEpoch)) {
                        return stale(ledger, "Ledger configuration changed during baseline");
                    };
                    // Unlike an index account head, a global ledger tip and an
                    // account balance are separate reads. Confirm the balance
                    // after capturing the tip so a net-changing account event
                    // in that gap cannot be skipped by the baseline.
                    let confirmedBalance = switch (await* readBalance(activeCalls, ledger)) {
                        case (#err(error)) return fail(ledger, error, #degraded);
                        case (#ok(value)) value;
                    };
                    if (confirmedBalance != observedBalance) {
                        return fail(
                            ledger,
                            "Balance changed while the direct history baseline was captured; retry",
                            #catching_up,
                        );
                    };
                    if (not stillCurrent(ledger, configEpoch)) {
                        return stale(ledger, "Ledger configuration changed during baseline");
                    };
                    establishBaseline(ledger, {
                        tip_exclusive = target;
                        balance = confirmedBalance;
                    });
                    return success(ledger, "baseline", 0);
                };
                case (?_) {};
            };

            let scan = switch (ledger.history.scan) {
                case (?existing) {
                    if (
                        existing.index != ledger.principal or
                        existing.config_epoch != configEpoch
                    ) {
                        ledger.history.scan := null;
                        return fail(
                            ledger,
                            "Discarded stale direct history scan; retry",
                            #idle,
                        );
                    };
                    existing;
                };
                case null {
                    let target = switch (IcrcLedger.decodeTip(
                        await* activeCalls.call(IcrcLedger.tipRequest(ledger.principal))
                    )) {
                        case (#err(error)) return fail(ledger, error, #degraded);
                        case (#ok(value)) value;
                    };
                    let ?checkpoint = ledger.history.checkpoint else {
                        return fail(ledger, "History checkpoint disappeared", #degraded);
                    };
                    if (target < checkpoint.tip_exclusive) {
                        return fail(ledger, "Ledger history moved behind its checkpoint", #degraded);
                    };
                    if (target == checkpoint.tip_exclusive) {
                        return fail(
                            ledger,
                            "Balance changed before direct ledger history advanced; retry",
                            #catching_up,
                        );
                    };
                    {
                        // Reuse the stable scan source field as a direct-source
                        // discriminator. Direct scans always page forward.
                        index = ledger.principal;
                        from_tip_exclusive = checkpoint.tip_exclusive;
                        target_tip_exclusive = target;
                        previous_balance = checkpoint.balance;
                        target_balance = observedBalance;
                        cursor = ?checkpoint.tip_exclusive;
                        candidates = Map.empty<Nat, Memory.HistoryTransaction>();
                        unsupported_block_ids = [];
                        page_count = 0;
                        started_at = Time.now();
                        config_epoch = configEpoch;
                    };
                };
            };

            var staged = scan;
            var complete = scan.target_tip_exclusive == scan.from_tip_exclusive;
            var pages = 0;
            label paging while (not complete and pages < PAGES_PER_INVOCATION) {
                if (staged.page_count >= ABSOLUTE_PAGE_LIMIT) break paging;
                let start = switch (staged.cursor) {
                    case null staged.from_tip_exclusive;
                    case (?value) value;
                };
                if (
                    start < staged.from_tip_exclusive or
                    start >= staged.target_tip_exclusive
                ) {
                    ledger.history.scan := null;
                    return fail(ledger, "Direct history scan cursor is invalid; retry", #degraded);
                };
                let length = Nat.min(
                    IcrcLedger.MAX_PAGE_SIZE,
                    staged.target_tip_exclusive - start,
                );
                let page = switch (IcrcLedger.decodePage(
                    await* activeCalls.call(IcrcLedger.pageRequest(
                        ledger.principal,
                        start,
                        length,
                    )),
                    activeCalls.canister_principal,
                    start,
                    length,
                    staged.target_tip_exclusive,
                )) {
                    case (#err(error)) return fail(ledger, error, #degraded);
                    case (#ok(value)) value;
                };
                if (not stillCurrent(ledger, configEpoch)) {
                    return stale(ledger, "Ledger configuration changed during direct history paging");
                };
                for (transaction in page.transactions.vals()) {
                    Map.add(
                        staged.candidates,
                        Nat.compare,
                        transaction.block_index,
                        transaction,
                    );
                };
                if (Map.size(staged.candidates) > CANDIDATE_LIMIT) {
                    ledger.history.scan := null;
                    return fail(
                        ledger,
                        "Direct account history exceeded 50,000 records; configure an index canister",
                        #degraded,
                    );
                };
                complete := page.complete;
                staged := {
                    staged with
                    cursor = ?page.next_start;
                    page_count = staged.page_count + 1;
                };
                ledger.history.scan := ?staged;
                pages += 1;
            };

            if (not complete) {
                if (staged.page_count >= ABSOLUTE_PAGE_LIMIT) {
                    ledger.history.scan := null;
                    return fail(
                        ledger,
                        "Direct ledger scan reached its page limit; configure an index canister",
                        #degraded,
                    );
                };
                ledger.history.state := #catching_up;
                ledger.history.last_error := null;
                return result(ledger, "catching_up", 0, null);
            };
            commitDirect(
                ledger,
                staged,
                activeCalls.canister_principal,
                observedBalance,
            );
        };

        func readBalance(
            activeCalls : Capabilities.BackendCalls,
            ledger : Memory.Ledger,
        ) : async* Types.Result<Nat> {
            switch (IcrcClient.decodeBalance(await* activeCalls.call(
                IcrcClient.balanceRequest(
                    ledger.principal,
                    activeCalls.canister_principal,
                )
            ))) {
                case (#err(error)) #err("Could not confirm balance: " # error);
                case (#ok(value)) #ok(value);
            };
        };

        func commitDirect(
            ledger : Memory.Ledger,
            scan : Memory.HistoryScan,
            owner : Principal,
            observedBalance : Nat,
        ) : Types.SyncLedgerResult {
            let ?checkpoint = ledger.history.checkpoint else {
                return fail(ledger, "History checkpoint disappeared before commit", #degraded);
            };
            if (
                checkpoint.tip_exclusive != scan.from_tip_exclusive or
                checkpoint.balance != scan.previous_balance or
                not stillCurrent(ledger, scan.config_epoch)
            ) {
                return stale(ledger, "History checkpoint changed before direct commit");
            };
            switch (pendingWindowError(ledger, scan, owner)) {
                case (?error) return fail(ledger, error, #degraded);
                case null {};
            };
            var effect : Int = 0;
            for (transaction in Map.values(scan.candidates)) {
                effect += transaction.balance_effect;
            };
            if (
                not exactBalanceDelta(
                    scan.previous_balance,
                    scan.target_balance,
                    effect,
                ) or
                scan.unsupported_block_ids.size() != 0
            ) {
                ledger.history.scan := null;
                return fail(
                    ledger,
                    "Direct ledger history did not exactly explain the observed balance; retry",
                    #degraded,
                );
            };

            var added = 0;
            for ((blockIndex, canonical) in Map.entries(scan.candidates)) {
                let merged = switch (Map.get(
                    ledger.history.transactions,
                    Nat.compare,
                    blockIndex,
                )) {
                    case null ({ canonical with verification = #verified });
                    case (?local) {
                        {
                            canonical with
                            intent = preferIntent(local.intent, canonical.intent);
                            native = preferNative(local.native, canonical.native);
                            verification = #verified;
                        };
                    };
                };
                if (Store.putTransaction(mem, ledger.principal, merged)) added += 1;
            };
            ledger.history.checkpoint := ?{
                tip_exclusive = scan.target_tip_exclusive;
                balance = scan.target_balance;
                checked_at = Time.now();
            };
            ledger.history.scan := null;
            let needsFollowup = observedBalance != scan.target_balance;
            ledger.history.state := if (needsFollowup) #catching_up else #idle;
            ledger.history.last_error := null;
            success(
                ledger,
                if (needsFollowup) "catching_up" else if (added == 0) "current" else "synced",
                added,
            );
        };

        func captureAccountAnchor(
            activeCalls : Capabilities.BackendCalls,
            kind : Catalog.HistoryKind,
            index : Principal,
        ) : async* Types.Result<Types.AccountAnchor> {
            let head = switch (decodeHead(
                kind,
                await* activeCalls.call(headRequest(
                    kind,
                    index,
                    activeCalls.canister_principal,
                )),
            )) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            #ok(accountAnchor(head));
        };

        func establishBaseline(
            ledger : Memory.Ledger,
            anchor : Types.AccountAnchor,
        ) : () {
            if (anchor.balance > 0) {
                ignore Store.addAdjustment(
                    mem,
                    ledger.principal,
                    #opening_balance,
                    Int.fromNat(anchor.balance),
                    0,
                    anchor.balance,
                    anchor.tip_exclusive,
                    anchor.tip_exclusive,
                    "Opening balance",
                );
            };
            let pending = List.empty<Memory.HistoryTransaction>();
            for ((blockIndex, transaction) in Map.entries(ledger.history.transactions)) {
                if (blockIndex < anchor.tip_exclusive and transaction.verification == #pending) {
                    List.add(pending, { transaction with verification = #prebaseline });
                };
            };
            for (transaction in List.values(pending)) {
                ignore Store.putTransaction(mem, ledger.principal, transaction);
            };
            ledger.history.checkpoint := ?{
                tip_exclusive = anchor.tip_exclusive;
                balance = anchor.balance;
                checked_at = Time.now();
            };
            ledger.history.scan := null;
            ledger.history.state := #idle;
            ledger.history.last_error := null;
        };

        func commitComplete(
            ledger : Memory.Ledger,
            scan : Memory.HistoryScan,
            observedBalance : Nat,
        ) : Types.SyncLedgerResult {
            let ?checkpoint = ledger.history.checkpoint else {
                return fail(ledger, "History checkpoint disappeared before commit", #degraded);
            };
            if (
                checkpoint.tip_exclusive != scan.from_tip_exclusive or
                checkpoint.balance != scan.previous_balance or
                not stillCurrent(ledger, scan.config_epoch)
            ) {
                return stale(ledger, "History checkpoint changed before commit");
            };
            switch (pendingWindowError(ledger, scan, calls.canister_principal)) {
                case (?error) return fail(ledger, error, #degraded);
                case null {};
            };

            var effect : Int = 0;
            for (transaction in Map.values(scan.candidates)) {
                effect += transaction.balance_effect;
            };
            let delta = Int.fromNat(scan.target_balance) - Int.fromNat(scan.previous_balance);
            let residual = delta - effect;
            var added = 0;
            for ((blockIndex, canonical) in Map.entries(scan.candidates)) {
                let merged = switch (Map.get(
                    ledger.history.transactions,
                    Nat.compare,
                    blockIndex,
                )) {
                    case null ({ canonical with verification = #verified });
                    case (?local) {
                        {
                            canonical with
                            intent = preferIntent(local.intent, canonical.intent);
                            native = preferNative(local.native, canonical.native);
                            verification = #verified;
                        };
                    };
                };
                if (Store.putTransaction(mem, ledger.principal, merged)) added += 1;
            };
            let hasUnsupported = scan.unsupported_block_ids.size() > 0;
            if (residual != 0 or hasUnsupported) {
                ignore Store.addAdjustment(
                    mem,
                    ledger.principal,
                    if (hasUnsupported) #unsupported_operation else #unexplained_balance,
                    residual,
                    scan.previous_balance,
                    scan.target_balance,
                    scan.from_tip_exclusive,
                    scan.target_tip_exclusive,
                    if (hasUnsupported) {
                        "One or more account operations had no safe fee rule"
                    } else "Verified account activity did not explain the observed balance exactly",
                );
            };
            ledger.history.checkpoint := ?{
                tip_exclusive = scan.target_tip_exclusive;
                balance = scan.target_balance;
                checked_at = Time.now();
            };
            ledger.history.scan := null;
            let needsFollowup = observedBalance != scan.target_balance;
            ledger.history.state := if (needsFollowup) {
                #catching_up;
            } else if (residual == 0 and not hasUnsupported) {
                #idle;
            } else #degraded;
            ledger.history.last_error := if (residual == 0 and not hasUnsupported) null else {
                ?"History includes a visible balance adjustment";
            };
            success(
                ledger,
                if (needsFollowup) "catching_up" else if (added == 0) "current" else "synced",
                added,
            );
        };

        func pendingWindowError(
            ledger : Memory.Ledger,
            scan : Memory.HistoryScan,
            owner : Principal,
        ) : ?Text {
            for ((blockIndex, existing) in Map.entries(ledger.history.transactions)) {
                if (
                    blockIndex >= scan.from_tip_exclusive and
                    blockIndex < scan.target_tip_exclusive and
                    existing.verification == #pending
                ) {
                    switch (Map.get(scan.candidates, Nat.compare, blockIndex)) {
                        case null return ?(
                            "A successful local transaction is missing from the verified history window"
                        );
                        case (?canonical) if (not pendingMatches(
                            ledger.principal,
                            owner,
                            existing,
                            canonical,
                            relatedTransactionFor(existing),
                        )) return ?(
                            "A verified transaction conflicts with its local Wallet receipt"
                        );
                        case (_) {};
                    };
                };
            };
            null;
        };

        func commitScanLimit(
            ledger : Memory.Ledger,
            scan : Memory.HistoryScan,
            detail : Text,
        ) : Types.SyncLedgerResult {
            var effect : Int = 0;
            for (transaction in Map.values(scan.candidates)) {
                effect += transaction.balance_effect;
                ignore Store.putTransaction(mem, ledger.principal, {
                    transaction with verification = #unverified_scan_limit
                });
            };
            let residual = Int.fromNat(scan.target_balance) -
                Int.fromNat(scan.previous_balance) - effect;
            ignore Store.addAdjustment(
                mem,
                ledger.principal,
                #scan_limit,
                residual,
                scan.previous_balance,
                scan.target_balance,
                scan.from_tip_exclusive,
                scan.target_tip_exclusive,
                detail,
            );
            ledger.history.checkpoint := ?{
                tip_exclusive = scan.target_tip_exclusive;
                balance = scan.target_balance;
                checked_at = Time.now();
            };
            ledger.history.scan := null;
            ledger.history.state := #degraded;
            ledger.history.last_error := ?Store.boundedText(detail, 512);
            success(ledger, "scan_limit", Map.size(scan.candidates));
        };

        func sourceReady(
            activeCalls : Capabilities.BackendCalls,
            index : Principal,
        ) : Bool {
            activeCalls.can_call(index, "get_account_transactions");
        };

        func stillCurrent(ledger : Memory.Ledger, epoch : Nat) : Bool {
            let ?current = Map.get(mem.ledgers, Principal.compare, ledger.principal) else {
                return false;
            };
            current.id == ledger.id and current.enabled and current.history.config_epoch == epoch;
        };

        func isDue(ledger : Memory.Ledger) : Bool {
            if (ledger.history.state == #catching_up) return true;
            switch (ledger.history.scan) {
                case (?_) return true;
                case null {};
            };
            switch (ledger.history.last_success_at) {
                case null true;
                case (?last) Time.now() - last >= SYNC_INTERVAL_NS;
            };
        };

        func fail(
            ledger : Memory.Ledger,
            error : Text,
            state : Memory.HistoryState,
        ) : Types.SyncLedgerResult {
            ledger.history.state := state;
            ledger.history.last_error := ?Store.boundedText(error, 512);
            result(ledger, stateText(state), 0, ledger.history.last_error);
        };

        func stale(ledger : Memory.Ledger, error : Text) : Types.SyncLedgerResult {
            ledger.history.scan := null;
            fail(ledger, error, #idle);
        };

        func success(
            ledger : Memory.Ledger,
            statusText : Text,
            added : Nat,
        ) : Types.SyncLedgerResult {
            ledger.history.last_success_at := ?Time.now();
            result(ledger, statusText, added, ledger.history.last_error);
        };

        func result(
            ledger : Memory.Ledger,
            statusText : Text,
            added : Nat,
            error : ?Text,
        ) : Types.SyncLedgerResult {
            {
                ledger = ledger.principal;
                status = statusText;
                records_added = added;
                checkpoint = ledger.history.checkpoint;
                error;
            };
        };

        func cacheBalance(ledger : Memory.Ledger, balance : Nat) : () {
            let ?current = Map.get(mem.ledgers, Principal.compare, ledger.principal) else return;
            if (current.id != ledger.id) return;
            Map.add(mem.ledgers, Principal.compare, ledger.principal, {
                current with
                balance = ?balance;
                balance_updated_at = ?Time.now();
                balance_error = null;
            });
        };

        func cacheBalanceError(ledger : Memory.Ledger, error : Text) : () {
            let ?current = Map.get(mem.ledgers, Principal.compare, ledger.principal) else return;
            if (current.id != ledger.id) return;
            Map.add(mem.ledgers, Principal.compare, ledger.principal, {
                current with balance_error = ?Store.boundedText(error, 512)
            });
        };

        func ledgerSymbol(principal : Principal) : ?Text {
            switch (Map.get(mem.ledgers, Principal.compare, principal)) {
                case null null;
                case (?ledger) ledger.symbol;
            };
        };

        func reportedSource(ledger : Memory.Ledger) : Types.HistorySource {
            switch (historyRoute(ledger.principal)) {
                case (#index(value)) #index(value.principal);
                case (#icrc3_ledger) #ledger;
                case (#unsupported) #unavailable;
            };
        };

        func ledgerDecimals(principal : Principal) : ?Nat {
            switch (Map.get(mem.ledgers, Principal.compare, principal)) {
                case null null;
                case (?ledger) ledger.decimals;
            };
        };

        func ledgerLogo(principal : Principal) : ?Text {
            switch (Map.get(mem.ledgers, Principal.compare, principal)) {
                case null null;
                case (?ledger) ledger.logo;
            };
        };

        func relatedTransactionFor(
            transaction : Memory.HistoryTransaction,
        ) : ?Memory.HistoryTransaction {
            let ?native = transaction.native else return null;
            let ?ledgerPrincipal = native.related_ledger else return null;
            let ?blockIndex = native.related_block_index else return null;
            let ?ledger = Map.get(mem.ledgers, Principal.compare, ledgerPrincipal) else {
                return null;
            };
            Map.get(ledger.history.transactions, Nat.compare, blockIndex);
        };
    };

    public func accountAnchor(head : Types.AccountHead) : Types.AccountAnchor {
        // The configured index is permanent. Its account head and balance come
        // from one atomic query, so the newest account block is the only cursor
        // boundary Wallet needs.
        let newestExclusive = switch (head.newest_block_id) {
            case null 0;
            case (?blockIndex) blockIndex + 1;
        };
        {
            tip_exclusive = newestExclusive;
            balance = head.balance;
        };
    };

    public func boundedScanCursor(cursor : ?Nat, targetTip : Nat) : ?Nat {
        // Older staged scans used null for their first page. Bound them at the
        // immutable target so activity appended after capture stays for the
        // next reconciliation.
        switch (cursor) {
            case null ?targetTip;
            case (?value) ?value;
        };
    };

    func headRequest(
        kind : Catalog.HistoryKind,
        index : Principal,
        owner : Principal,
    ) : Capabilities.CallRequest {
        switch (kind) {
            case (#icp) IcpIndex.pageRequest(index, owner, null, 1);
            case (#icrc) IcrcIndex.pageRequest(index, owner, null, 1);
        };
    };

    func decodeHead(
        kind : Catalog.HistoryKind,
        result : Capabilities.CallResult,
    ) : Types.Result<Types.AccountHead> {
        switch (kind) {
            case (#icp) IcpIndex.decodeHead(result);
            case (#icrc) IcrcIndex.decodeHead(result);
        };
    };

    func pageRequest(
        kind : Catalog.HistoryKind,
        index : Principal,
        owner : Principal,
        cursor : ?Nat,
    ) : Capabilities.CallRequest {
        switch (kind) {
            case (#icp) IcpIndex.pageRequest(index, owner, cursor, PAGE_SIZE);
            case (#icrc) IcrcIndex.pageRequest(index, owner, cursor, PAGE_SIZE);
        };
    };

    func decodePage(
        kind : Catalog.HistoryKind,
        result : Capabilities.CallResult,
        owner : Principal,
        cursor : ?Nat,
        floor : Nat,
        targetTip : Nat,
    ) : Types.Result<Types.IndexedPage> {
        switch (kind) {
            case (#icp) IcpIndex.decodePage(result, owner, cursor, floor, targetTip);
            case (#icrc) IcrcIndex.decodePage(result, owner, cursor, floor, targetTip);
        };
    };

    func matchesLedger(
        reference : Memory.HistoryRecordRef,
        filter : ?Principal,
    ) : Bool {
        switch (filter) {
            case null true;
            case (?principal) switch (reference) {
                case (#transaction(value)) value.ledger == principal;
                case (#adjustment(value)) value.ledger == principal;
            };
        };
    };

    func preferIntent(
        preferred : ?Memory.TransferIntent,
        fallback : ?Memory.TransferIntent,
    ) : ?Memory.TransferIntent {
        switch (preferred) { case (?value) ?value; case null fallback };
    };

    func intentsEqual(
        left : Memory.TransferIntent,
        right : Memory.TransferIntent,
    ) : Bool {
        left.contact_id == right.contact_id and
        left.address_id == right.address_id and
        left.contact_name == right.contact_name and
        left.address_label == right.address_label and
        left.network == right.network and
        left.destination == right.destination and
        left.native == right.native;
    };

    func preferNative(
        preferred : ?Memory.NativeHistoryContext,
        fallback : ?Memory.NativeHistoryContext,
    ) : ?Memory.NativeHistoryContext {
        switch (preferred) { case (?value) ?value; case null fallback };
    };

    public func pendingMatches(
        ledgerPrincipal : Principal,
        walletPrincipal : Principal,
        pending : Memory.HistoryTransaction,
        canonical : Memory.HistoryTransaction,
        related : ?Memory.HistoryTransaction,
    ) : Bool {
        if (
            pending.operation == canonical.operation and
            pending.amount == canonical.amount and
            optionalAddressMatches(ledgerPrincipal, pending.to, canonical.to)
        ) return true;

        ckErc20GasBurnMatches(
            ledgerPrincipal,
            walletPrincipal,
            pending,
            canonical,
            related,
        );
    };

    func ckErc20GasBurnMatches(
        ledgerPrincipal : Principal,
        walletPrincipal : Principal,
        pending : Memory.HistoryTransaction,
        canonical : Memory.HistoryTransaction,
        related : ?Memory.HistoryTransaction,
    ) : Bool {
        if (
            pending.block_index != canonical.block_index or
            pending.operation != #burn or
            canonical.operation != #burn or
            pending.provenance != #local_pending or
            canonical.provenance != #index or
            pending.amount == 0 or
            canonical.amount == 0 or
            canonical.balance_effect != -Int.fromNat(canonical.amount) or
            not isDefaultIcrcAddress(pending.from, walletPrincipal) or
            not isDefaultIcrcAddress(canonical.from, walletPrincipal)
        ) return false;
        switch (pending.to, pending.fee, canonical.to, canonical.fee) {
            case (null, null, null, null) {};
            case (_) return false;
        };

        let ?catalogLedger = Catalog.find(ledgerPrincipal) else return false;
        let ?#cketh(ckethRoute) = catalogLedger.native_route else return false;
        let minter = Principal.fromText(ckethRoute.minter);
        if (not isDefaultIcrcAddress(canonical.spender, minter)) return false;

        let ?pendingNative = pending.native else return false;
        let ?relatedLedger = pendingNative.related_ledger else return false;
        let ?relatedBlockIndex = pendingNative.related_block_index else return false;
        let ethereumNetwork = Catalog.networkText(#ethereum_mainnet);
        if (pendingNative.network != ethereumNetwork) return false;

        let ?relatedCatalog = Catalog.find(relatedLedger) else return false;
        let ?#ckerc20(erc20Route) = relatedCatalog.native_route else return false;
        if (
            erc20Route.minter != ckethRoute.minter or
            Principal.fromText(erc20Route.cketh_ledger) != ledgerPrincipal
        ) return false;

        let ?relatedTransaction = related else return false;
        if (
            relatedTransaction.block_index != relatedBlockIndex or
            relatedTransaction.operation != #burn or
            not isDefaultIcrcAddress(relatedTransaction.from, walletPrincipal)
        ) return false;
        let ?relatedNative = relatedTransaction.native else return false;
        if (
            relatedNative.network != ethereumNetwork or
            relatedNative.related_ledger != ?ledgerPrincipal or
            relatedNative.related_block_index != ?pending.block_index
        ) return false;

        let ?pendingIntent = pending.intent else return false;
        let ?relatedIntent = relatedTransaction.intent else return false;
        pendingIntent.native and
        relatedIntent.native and
        pendingIntent.network == ethereumNetwork and
        relatedIntent.network == ethereumNetwork and
        intentsEqual(pendingIntent, relatedIntent);
    };

    func isDefaultIcrcAddress(
        value : ?Memory.HistoryAddress,
        owner : Principal,
    ) : Bool {
        switch (value) {
            case (?#icrc(account)) {
                if (account.owner != owner) return false;
                switch (defaultSubaccount(account.subaccount)) {
                    case null true;
                    case (?_) false;
                };
            };
            case (_) false;
        };
    };

    func optionalAddressMatches(
        ledgerPrincipal : Principal,
        expected : ?Memory.HistoryAddress,
        actual : ?Memory.HistoryAddress,
    ) : Bool {
        switch (expected, actual) {
            case (null, _) true;
            case (?left, ?right) addressMatches(ledgerPrincipal, left, right);
            case (?_, null) false;
        };
    };

    func addressMatches(
        ledgerPrincipal : Principal,
        left : Memory.HistoryAddress,
        right : Memory.HistoryAddress,
    ) : Bool {
        switch (left, right) {
            case (#icp_account_identifier(a), #icp_account_identifier(b)) a == b;
            case (#icrc(a), #icrc(b)) {
                a.owner == b.owner and defaultSubaccount(a.subaccount) == defaultSubaccount(b.subaccount);
            };
            // Keep pre-fix ICP receipts reconcilable after an in-place package update.
            case (#icrc(account), #icp_account_identifier(identifier)) {
                icpAccountMatches(ledgerPrincipal, account, identifier);
            };
            case (#icp_account_identifier(identifier), #icrc(account)) {
                icpAccountMatches(ledgerPrincipal, account, identifier);
            };
            case (_) false;
        };
    };

    public func historyAddress(
        ledgerPrincipal : Principal,
        account : { owner : Principal; subaccount : ?Blob },
    ) : Memory.HistoryAddress {
        let fallback : Memory.HistoryAddress = #icrc(account);
        let ?catalogLedger = Catalog.find(ledgerPrincipal) else return fallback;
        switch (catalogLedger.history_kind) {
            case (#icrc) fallback;
            case (#icp) switch (
                AccountIdentifier.fromAccount(account.owner, account.subaccount)
            ) {
                case null fallback;
                case (?identifier) #icp_account_identifier(identifier);
            };
        };
    };

    func icpAccountMatches(
        ledgerPrincipal : Principal,
        account : { owner : Principal; subaccount : ?Blob },
        identifier : Blob,
    ) : Bool {
        let ?catalogLedger = Catalog.find(ledgerPrincipal) else return false;
        switch (catalogLedger.history_kind) {
            case (#icrc) false;
            case (#icp) switch (
                AccountIdentifier.fromAccount(account.owner, account.subaccount)
            ) {
                case null false;
                case (?derived) derived == identifier;
            };
        };
    };

    func defaultSubaccount(value : ?Blob) : ?Blob {
        switch (value) {
            case (?blob) {
                if (blob.size() != 32) return value;
                for (byte in blob.vals()) if (byte != 0) return value;
                null;
            };
            case null null;
        };
    };

    func stateText(state : Memory.HistoryState) : Text {
        switch (state) {
            case (#idle) "idle";
            case (#syncing) "syncing";
            case (#catching_up) "catching_up";
            case (#waiting_for_index) "waiting_for_index";
            case (#permission_required) "permission_required";
            case (#degraded) "degraded";
        };
    };
};
