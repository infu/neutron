// SNS Governance — app backend.
//
// This backend is deliberately small. Everything an SNS client normally does
// (listing SNSes, reading parameters, proposals, neurons, ledgers) happens in
// the browser over free anonymous queries, so none of it is here.
//
// The backend owns exactly three things:
//   1. The owner's SNS allowlist and per-SNS agent-voting policy — the state
//      that authorizes a signed write.
//   2. An append-only, bounded audit trail of signed governance actions.
//   3. Proposal drafts awaiting human review.
//
// The signing path is a byte relay: pre-encoded Candid in, raw reply out. The
// browser decodes SNS command outcomes; broker success only means a reply was
// received, not that governance accepted a vote or proposal.
import NeutronCapabilities "mo:neutron-capabilities";
import Array "mo:core/Array";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Time "mo:core/Time";
import Memory "./memory/snsgov/v1";

module {

    // ---- Wire types -------------------------------------------------------

    public type SnsView = {
        sns : Principal;
        governance : Principal;
        voting_enabled : Bool;
        agent_voting_enabled : Bool;
        label_text : Text;
        added_at_seconds : Nat64;
    };

    public type ConfigView = {
        snses : [SnsView];
        audit_rows : Nat;
        max_audit_rows : Nat;
        draft_count : Nat;
    };

    public type SnsUpsert = {
        sns : Principal;
        governance : Principal;
        voting_enabled : Bool;
        agent_voting_enabled : Bool;
        label_text : Text;
    };

    public type AuditView = {
        seq : Nat;
        sns : Principal;
        governance : Principal;
        kind : Text;
        proposal_id : ?Nat64;
        initiator : Text;
        vote : ?Int32;
        neurons_attempted : Nat;
        neurons_succeeded : Nat;
        note : Text;
        at_seconds : Nat64;
    };

    // `next_before` is passed back as `before` to continue paging; it is null
    // when the page is the last one.
    public type AuditPage = {
        rows : [AuditView];
        next_before : ?Nat;
        total : Nat;
    };

    // `before` is an exclusive upper bound on `seq`; null starts at the newest
    // row. `limit` is clamped to MAX_AUDIT_PAGE.
    public type AuditQuery = {
        before : ?Nat;
        limit : Nat;
    };

    public type DraftView = {
        id : Nat;
        sns : Principal;
        governance : Principal;
        title : Text;
        summary : Text;
        url : Text;
        action_kind : Text;
        payload : ?Blob;
        function_id : ?Nat64;
        rendering : ?Text;
        proposer : ?Blob;
        created_by : Text;
        updated_at_seconds : Nat64;
    };

    // A null `id` creates a new draft; a known id updates it in place.
    public type DraftSave = {
        id : ?Nat;
        sns : Principal;
        governance : Principal;
        title : Text;
        summary : Text;
        url : Text;
        action_kind : Text;
        payload : ?Blob;
        function_id : ?Nat64;
        rendering : ?Text;
        proposer : ?Blob;
        created_by : Text;
    };

    public type HotkeyView = {
        principal : Principal;
        can_manage_neuron : Bool;
    };

    public type RelayRequest = {
        sns : Principal;
        args : Blob;
        initiator : Text;
        kind : Text;
        proposal_id : ?Nat64;
        vote : ?Int32;
    };

    public type RelayResult = { #ok : Blob; #err : Text };

    public type RelayBatchRequest = {
        sns : Principal;
        calls : [Blob];
        initiator : Text;
        kind : Text;
        proposal_id : ?Nat64;
        vote : ?Int32;
    };

    public type RelayBatchResult = {
        results : [RelayResult];
        attempted : Nat;
        succeeded : Nat;
        error : ?Text;
    };

    public type Outcome = { #ok; #err : Text };
    public type DraftOutcome = { #ok : Nat; #err : Text };

    // ---- Bounds -----------------------------------------------------------
    //
    // Every one of these is enforced on the way in. The canister is the last
    // line of defence: the frontend validates too, but the frontend is not
    // trusted to be the only check.

    let MAX_SNSES : Nat = 128;
    let MAX_LABEL_BYTES : Nat = 64;
    let MAX_TITLE_BYTES : Nat = 256; // SNS: title <= 256 BYTES
    let MAX_SUMMARY_BYTES : Nat = 30_000; // SNS: summary <= 30_000 BYTES
    let MAX_URL_CHARS : Nat = 2_048; // SNS: url <= 2_048 CHARACTERS
    let MAX_ACTION_KIND_BYTES : Nat = 64;
    let MAX_RENDERING_BYTES : Nat = 8_192;
    let MAX_PAYLOAD_BYTES : Nat = 100_000;
    let MAX_NOTE_BYTES : Nat = 256;
    let MAX_INITIATOR_BYTES : Nat = 16;
    let MAX_DRAFTS : Nat = 256;
    let MAX_AUDIT_PAGE : Nat = 200;
    let MAX_AUDIT_ROWS_CEILING : Nat = 10_000;
    let NEURON_ID_BYTES : Nat = 32;
    // The only method this app will ever sign. Not caller-supplied.
    let MANAGE_NEURON : Text = "manage_neuron";
    // A valid, non-self destination used only to ask the broker whether the
    // `manage_neuron` reservation exists. NNS SNS-W is a real canister we
    // already read from, and `manage_neuron` is never sent to it.
    //
    // Held as text, not as a Principal: this file is a module, and a module's
    // top-level bindings must be static expressions. `Principal.fromText` is a
    // call, so binding it here fails the whole assembled actor with
    // "non-static expression in library, module or migration expression".
    let PROBE_GOVERNANCE_TEXT : Text = "qaa6y-5yaaa-aaaaa-aaafa-cai";
    let MAX_RELAY_ARG_BYTES : Nat = 100_000;
    // The broker caps a batch at 20; asking for more would be rejected there.
    let MAX_RELAY_BATCH : Nat = 20;

    func isAgent(initiator : Text) : Bool { initiator == "agent" or initiator == "timer" };

    func utf8Size(value : Text) : Nat { Text.encodeUtf8(value).size() };

    func nowSeconds() : Nat64 {
        Nat64.fromNat(Nat.fromInt(Time.now() / 1_000_000_000));
    };

    /// Truncate on a character boundary. Text.size() is scalar count, so this
    /// cannot split a code point; the byte bound is checked separately.
    func clampChars(value : Text, maxChars : Nat) : Text {
        if (value.size() <= maxChars) return value;
        var out = "";
        var seen = 0;
        for (ch in value.chars()) {
            if (seen >= maxChars) return out;
            out #= Text.fromChar(ch);
            seen += 1;
        };
        out;
    };

    public type AppBackendEnvironment = {
        stable_memory : { snsgov : Memory.Mem };
        capabilities : { backend_calls : NeutronCapabilities.BackendCallsV1 };
    };

    public class Init(env : AppBackendEnvironment) {
        let mem = env.stable_memory.snsgov;
        let calls = env.capabilities.backend_calls;

        // ---- Configuration ------------------------------------------------

        public func /*query*/snsgov_config(()) : ConfigView {
            let rows = List.empty<SnsView>();
            for ((sns, entry) in Map.entries(mem.snses)) {
                List.add(rows, {
                    sns;
                    governance = entry.governance;
                    voting_enabled = entry.voting_enabled;
                    agent_voting_enabled = entry.agent_voting_enabled;
                    label_text = entry.label_text;
                    added_at_seconds = entry.added_at_seconds;
                });
            };
            {
                snses = List.toArray(rows);
                audit_rows = Map.size(mem.audit);
                max_audit_rows = mem.max_audit_rows;
                draft_count = Map.size(mem.drafts);
            };
        };

        /// Admit or update one SNS. `governance` is the only principal the
        /// relay will target for this entry, so recording it here is what makes
        /// the allowlist meaningful.
        public func /*update*/snsgov_sns_upsert(request : SnsUpsert) : Outcome {
            if (Principal.isAnonymous(request.sns) or Principal.isAnonymous(request.governance)) {
                return #err("anonymous principal is not a valid SNS reference");
            };
            if (utf8Size(request.label_text) > MAX_LABEL_BYTES) {
                return #err("label too long");
            };
            switch (Map.get(mem.snses, Principal.compare, request.sns)) {
                case (?entry) {
                    if (entry.governance != request.governance) {
                        // Changing the governance target is a different
                        // authority, not an edit. Force an explicit remove.
                        return #err("governance canister differs; remove the SNS first");
                    };
                    entry.voting_enabled := request.voting_enabled;
                    entry.agent_voting_enabled := request.agent_voting_enabled;
                    entry.label_text := request.label_text;
                    #ok;
                };
                case null {
                    if (Map.size(mem.snses) >= MAX_SNSES) return #err("SNS limit reached");
                    Map.add(mem.snses, Principal.compare, request.sns, {
                        governance = request.governance;
                        var voting_enabled = request.voting_enabled;
                        var agent_voting_enabled = request.agent_voting_enabled;
                        var label_text = request.label_text;
                        added_at_seconds = nowSeconds();
                    });
                    #ok;
                };
            };
        };

        public func /*update*/snsgov_sns_remove(sns : Principal) : Outcome {
            switch (Map.get(mem.snses, Principal.compare, sns)) {
                case null #err("not found");
                case (?_) { Map.remove(mem.snses, Principal.compare, sns); #ok };
            };
        };

        public func /*update*/snsgov_set_max_audit_rows(value : Nat) : Outcome {
            if (value == 0 or value > MAX_AUDIT_ROWS_CEILING) return #err("out of range");
            mem.max_audit_rows := value;
            trimAudit();
            #ok;
        };

        /// Internal: is this SNS admitted, and by which governance canister?
        /// The relay will consult this before signing anything.
        public func /*internal*/snsgov_allowed(sns : Principal, forAgent : Bool) : ?Principal {
            switch (Map.get(mem.snses, Principal.compare, sns)) {
                case null null;
                case (?entry) {
                    if (not entry.voting_enabled) return null;
                    if (forAgent and not entry.agent_voting_enabled) return null;
                    ?entry.governance;
                };
            };
        };

        // ---- Audit --------------------------------------------------------

        public func /*internal*/snsgov_audit_append(row : {
            sns : Principal;
            governance : Principal;
            kind : Text;
            proposal_id : ?Nat64;
            initiator : Text;
            vote : ?Int32;
            neurons_attempted : Nat;
            neurons_succeeded : Nat;
            note : Text;
        }) : Nat {
            let seq = mem.audit_seq;
            mem.audit_seq += 1;
            Map.add(mem.audit, Nat.compare, seq, {
                seq;
                sns = row.sns;
                governance = row.governance;
                kind = clampChars(row.kind, MAX_ACTION_KIND_BYTES);
                proposal_id = row.proposal_id;
                initiator = clampChars(row.initiator, MAX_INITIATOR_BYTES);
                vote = row.vote;
                neurons_attempted = row.neurons_attempted;
                neurons_succeeded = row.neurons_succeeded;
                note = clampChars(row.note, MAX_NOTE_BYTES);
                at_seconds = nowSeconds();
            });
            trimAudit();
            seq;
        };

        /// Newest-first page. `before` is an exclusive upper bound on `seq`.
        public func /*query*/snsgov_audit(request : AuditQuery) : AuditPage {
            let limit = if (request.limit == 0 or request.limit > MAX_AUDIT_PAGE) {
                MAX_AUDIT_PAGE;
            } else { request.limit };
            let rows = List.empty<AuditView>();
            var count = 0;
            var oldest : ?Nat = null;
            label scan for ((seq, row) in Map.reverseEntries(mem.audit)) {
                switch (request.before) {
                    case (?bound) { if (seq >= bound) continue scan };
                    case null {};
                };
                if (count >= limit) break scan;
                List.add(rows, {
                    seq = row.seq;
                    sns = row.sns;
                    governance = row.governance;
                    kind = row.kind;
                    proposal_id = row.proposal_id;
                    initiator = row.initiator;
                    vote = row.vote;
                    neurons_attempted = row.neurons_attempted;
                    neurons_succeeded = row.neurons_succeeded;
                    note = row.note;
                    at_seconds = row.at_seconds;
                });
                oldest := ?seq;
                count += 1;
            };
            // Only advertise a continuation when an older row actually exists.
            let next = switch (oldest) {
                case null null;
                case (?seq) {
                    if (seq == 0) null else if (hasOlderThan(seq)) ?seq else null;
                };
            };
            { rows = List.toArray(rows); next_before = next; total = Map.size(mem.audit) };
        };

        func hasOlderThan(seq : Nat) : Bool {
            label probe for ((candidate, _) in Map.reverseEntries(mem.audit)) {
                if (candidate < seq) return true;
            };
            false;
        };

        func trimAudit() {
            while (Map.size(mem.audit) > mem.max_audit_rows) {
                var lowest : ?Nat = null;
                label first for ((seq, _) in Map.entries(mem.audit)) {
                    lowest := ?seq;
                    break first;
                };
                switch (lowest) {
                    case null return;
                    case (?seq) Map.remove(mem.audit, Nat.compare, seq);
                };
            };
        };


        // ---- Signing relay ------------------------------------------------
        //
        // The backend is a byte relay: pre-encoded Candid in, raw reply out. It
        // models no SNS types, so an SNS interface change cannot break it and an
        // unknown variant tag cannot trap it.
        //
        // Two things it does NOT take from the caller: the target canister and
        // the method. The target is looked up from the owner-approved allowlist
        // keyed by SNS root, and the method is fixed to `manage_neuron`. So the
        // widest possible blast radius of a compromised frontend is calling
        // `manage_neuron` on an SNS the owner already admitted — which is
        // exactly the authority the owner granted, and no more.

        // The kernel's broker rejects this canister as its own destination
        // (`validTarget`), so probing readiness with our own principal always
        // answers false no matter what the owner approved. Probe a real
        // governance canister instead: the first allowlisted one, or a
        // well-known SNS governance canister when the allowlist is still empty.
        // Our reservation is method-scoped, so one answer holds for every SNS.
        func probeTarget() : Principal {
            for ((_, entry) in Map.entries(mem.snses)) return entry.governance;
            Principal.fromText(PROBE_GOVERNANCE_TEXT);
        };

        public func /*query*/snsgov_hotkey(()) : HotkeyView {
            {
                principal = calls.canister_principal;
                can_manage_neuron = calls.can_call(probeTarget(), MANAGE_NEURON);
            };
        };

        public func /*update*/snsgov_relay(request : RelayRequest) : async* RelayResult {
            let forAgent = isAgent(request.initiator);
            let ?governance = snsgov_allowed(request.sns, forAgent) else {
                return #err(notAllowed(request.sns, forAgent));
            };
            if (request.args.size() > MAX_RELAY_ARG_BYTES) return #err("argument too large");

            let outcome = await* calls.call({
                canister = governance;
                method = MANAGE_NEURON;
                args = request.args;
                cycles = 0;
            });
            let succeeded = switch (outcome) { case (#ok(_)) 1; case (#err(_)) 0 };
            ignore snsgov_audit_append({
                sns = request.sns;
                governance;
                kind = request.kind;
                proposal_id = request.proposal_id;
                initiator = request.initiator;
                vote = request.vote;
                neurons_attempted = 1;
                neurons_succeeded = succeeded;
                note = switch (outcome) {
                    case (#ok(_)) "IC reply received; inspect the decoded SNS command outcome.";
                    case (#err(e)) e.code;
                };
            });
            switch (outcome) {
                case (#ok(reply)) #ok(reply);
                case (#err(e)) #err(e.code # ": " # e.message);
            };
        };

        // Vote with many neurons in one owner-visible action. Uses the broker's
        // batch so the calls are dispatched together rather than serially.
        public func /*update*/snsgov_relay_batch(request : RelayBatchRequest) : async* RelayBatchResult {
            let forAgent = isAgent(request.initiator);
            let ?governance = snsgov_allowed(request.sns, forAgent) else {
                return {
                    results = [];
                    attempted = 0;
                    succeeded = 0;
                    error = ?notAllowed(request.sns, forAgent);
                };
            };
            if (request.calls.size() == 0) {
                return { results = []; attempted = 0; succeeded = 0; error = ?"no calls supplied" };
            };
            if (request.calls.size() > MAX_RELAY_BATCH) {
                return { results = []; attempted = 0; succeeded = 0; error = ?"batch too large" };
            };
            for (args in request.calls.vals()) {
                if (args.size() > MAX_RELAY_ARG_BYTES) {
                    return { results = []; attempted = 0; succeeded = 0; error = ?"argument too large" };
                };
            };

            let requests = Array.map<Blob, NeutronCapabilities.BackendCallRequestV1>(
                request.calls,
                func(args) {
                    { canister = governance; method = MANAGE_NEURON; args; cycles = 0 };
                },
            );
            let outcomes = await* calls.call_batch(requests);

            let results = List.empty<RelayResult>();
            var succeeded = 0;
            for (outcome in outcomes.vals()) {
                switch (outcome) {
                    case (#ok(reply)) { succeeded += 1; List.add(results, #ok(reply)) };
                    case (#err(e)) List.add(results, #err(e.code # ": " # e.message));
                };
            };
            ignore snsgov_audit_append({
                sns = request.sns;
                governance;
                kind = request.kind;
                proposal_id = request.proposal_id;
                initiator = request.initiator;
                vote = request.vote;
                neurons_attempted = outcomes.size();
                neurons_succeeded = succeeded;
                note = "Counts describe IC replies, not accepted SNS commands; inspect each decoded result.";
            });
            {
                results = List.toArray(results);
                attempted = outcomes.size();
                succeeded;
                error = null;
            };
        };

        func notAllowed(sns : Principal, forAgent : Bool) : Text {
            if (forAgent) {
                "This SNS is not enabled for agent voting. Enable it in the app first.";
            } else {
                "This SNS is not on your allowlist, or voting is disabled for it.";
            };
        };

        // ---- Drafts -------------------------------------------------------

        public func /*query*/snsgov_drafts(()) : [DraftView] {
            let rows = List.empty<DraftView>();
            for ((_, d) in Map.entries(mem.drafts)) {
                List.add(rows, draftView(d));
            };
            List.toArray(rows);
        };

        public func /*update*/snsgov_draft_save(request : DraftSave) : DraftOutcome {
            switch (validateDraft(request)) {
                case (?problem) return #err(problem);
                case null {};
            };
            switch (request.id) {
                case (?id) {
                    switch (Map.get(mem.drafts, Nat.compare, id)) {
                        case null #err("draft not found");
                        case (?d) {
                            // The stored target is immutable. A stale editor
                            // must not save another DAO's proposal under it.
                            if (d.sns != request.sns or d.governance != request.governance) {
                                return #err("draft belongs to a different SNS or governance canister; create a new draft");
                            };
                            d.title := request.title;
                            d.summary := request.summary;
                            d.url := request.url;
                            d.action_kind := request.action_kind;
                            d.payload := request.payload;
                            d.function_id := request.function_id;
                            d.rendering := request.rendering;
                            d.proposer := request.proposer;
                            d.updated_at_seconds := nowSeconds();
                            #ok(id);
                        };
                    };
                };
                case null {
                    if (Map.size(mem.drafts) >= MAX_DRAFTS) return #err("draft limit reached");
                    let id = mem.draft_seq;
                    mem.draft_seq += 1;
                    Map.add(mem.drafts, Nat.compare, id, {
                        id;
                        sns = request.sns;
                        governance = request.governance;
                        var title = request.title;
                        var summary = request.summary;
                        var url = request.url;
                        var action_kind = request.action_kind;
                        var payload = request.payload;
                        var function_id = request.function_id;
                        var rendering = request.rendering;
                        var proposer = request.proposer;
                        var created_by = clampChars(request.created_by, MAX_INITIATOR_BYTES);
                        var updated_at_seconds = nowSeconds();
                    });
                    #ok(id);
                };
            };
        };

        public func /*update*/snsgov_draft_delete(id : Nat) : Outcome {
            switch (Map.get(mem.drafts, Nat.compare, id)) {
                case null #err("draft not found");
                case (?_) { Map.remove(mem.drafts, Nat.compare, id); #ok };
            };
        };

        func validateDraft(request : DraftSave) : ?Text {
            // Mirror the SNS canister's own limits so a draft that saves is a
            // draft that can be submitted. Note the units differ per field:
            // title and summary are BYTES, url is CHARACTERS.
            if (utf8Size(request.title) > MAX_TITLE_BYTES) return ?"title exceeds 256 bytes";
            if (request.title.size() == 0) return ?"title is required";
            if (utf8Size(request.summary) > MAX_SUMMARY_BYTES) return ?"summary exceeds 30000 bytes";
            if (request.url.size() > MAX_URL_CHARS) return ?"url exceeds 2048 characters";
            if (utf8Size(request.action_kind) > MAX_ACTION_KIND_BYTES) return ?"action kind too long";
            switch (request.payload) {
                case (?bytes) { if (bytes.size() > MAX_PAYLOAD_BYTES) return ?"payload too large" };
                case null {};
            };
            switch (request.rendering) {
                case (?text) { if (utf8Size(text) > MAX_RENDERING_BYTES) return ?"rendering too long" };
                case null {};
            };
            switch (request.proposer) {
                case (?id) { if (id.size() != NEURON_ID_BYTES) return ?"proposer must be a 32-byte neuron id" };
                case null {};
            };
            if (Principal.isAnonymous(request.sns) or Principal.isAnonymous(request.governance)) {
                return ?"anonymous principal is not a valid SNS reference";
            };
            null;
        };

        func draftView(d : Memory.Draft) : DraftView {
            {
                id = d.id;
                sns = d.sns;
                governance = d.governance;
                title = d.title;
                summary = d.summary;
                url = d.url;
                action_kind = d.action_kind;
                payload = d.payload;
                function_id = d.function_id;
                rendering = d.rendering;
                proposer = d.proposer;
                created_by = d.created_by;
                updated_at_seconds = d.updated_at_seconds;
            };
        };
    };

    /*---NEUTRON GENERATED BEGIN---*/

public type snsgov_config_Input = (());
public type snsgov_config_Output = ConfigView;

public type snsgov_sns_upsert_Input = (request : SnsUpsert);
public type snsgov_sns_upsert_Output = Outcome;

public type snsgov_sns_remove_Input = (sns : Principal);
public type snsgov_sns_remove_Output = Outcome;

public type snsgov_set_max_audit_rows_Input = (value : Nat);
public type snsgov_set_max_audit_rows_Output = Outcome;

public type snsgov_allowed_Input = (sns : Principal, forAgent : Bool);
public type snsgov_allowed_Output = ?Principal;

public type snsgov_audit_append_Input = (row : {
            sns : Principal;
            governance : Principal;
            kind : Text;
            proposal_id : ?Nat64;
            initiator : Text;
            vote : ?Int32;
            neurons_attempted : Nat;
            neurons_succeeded : Nat;
            note : Text;
        });
public type snsgov_audit_append_Output = Nat;

public type snsgov_audit_Input = (request : AuditQuery);
public type snsgov_audit_Output = AuditPage;

public type snsgov_hotkey_Input = (());
public type snsgov_hotkey_Output = HotkeyView;

public type snsgov_relay_Input = (request : RelayRequest);
public type snsgov_relay_Output = RelayResult;

public type snsgov_relay_batch_Input = (request : RelayBatchRequest);
public type snsgov_relay_batch_Output = RelayBatchResult;

public type snsgov_drafts_Input = (());
public type snsgov_drafts_Output = [DraftView];

public type snsgov_draft_save_Input = (request : DraftSave);
public type snsgov_draft_save_Output = DraftOutcome;

public type snsgov_draft_delete_Input = (id : Nat);
public type snsgov_draft_delete_Output = Outcome;

/*---NEUTRON GENERATED END---*/
};
