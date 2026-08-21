import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Char "mo:core/Char";
import Int "mo:core/Int";
import Nat "mo:core/Nat";
import Nat16 "mo:core/Nat16";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Time "mo:core/Time";
import NeutronCapabilities "mo:neutron-capabilities";
import Memory "memory/rendezvous/v2";
import PublicIngressWire "PublicIngressWire";

module {
    let MAX_NEGOTIATIONS = 64; let MAX_CANDIDATES = 16; let MAX_TITLE = 160; let MAX_RECEIPTS = 128;
    let MIN_DURATION : Nat32 = 15; let MAX_DURATION : Nat32 = 480; let MAX_WIRE = 16_384;
    let REMOTE_CYCLES = 250_000_000; let REMOTE_METHOD = "app_rendezvous__rendezvous_v1_update"; let REMOTE_ROUTE = "exchange";
    let SIGNAL_METHOD = "app_rendezvous__rendezvous_signal_v1_update"; let SIGNAL_ROUTE = "signal";
    let MAX_SIGNALS = 64; let MAX_SIGNAL_RECEIPTS = 128; let MAX_SIGNAL_TEXT = 12_000; let SIGNAL_TTL_NS : Nat64 = 600_000_000_000;

    public type Direction = { #inbound; #outbound };
    public type State = { #draft; #offered; #countered; #accept_intent; #confirmed; #declined; #cancelled; #expired };
    public type Delivery = { #idle; #pending; #delivered; #retryable : Text; #uncertain : Text; #rejected : Text };
    public type Error = { code : Text; message : Text; retryable : Bool; uncertain : Bool };
    public type Result = { #ok : NegotiationView; #err : Error };
    public type NegotiationView = { id : Blob; revision : Nat64; direction : Direction; peer : ?Principal; peer_name : ?Text; state : State; title : Text; duration_minutes : Nat32; candidate_starts_ns : [Nat64]; selected_start_ns : ?Nat64; expires_at_ns : Nat64; delivery : Delivery };
    public type Status = { revision : Nat64; negotiation_count : Nat; actionable_count : Nat };
    public type ListRequest = { offset : Nat; limit : Nat };
    public type ListResult = { revision : Nat64; total : Nat; negotiations : [NegotiationView] };
    public type GetRequest = { id : Blob };
    public type CreateOfferRequest = { id : Blob; capability : Blob; peer : Principal; title : Text; duration_minutes : Nat32; candidate_starts_ns : [Nat64]; expires_at_ns : Nat64 };
    public type ContactBinding = { contact_id : Nat; contact_revision : Nat; book_revision : Nat };
    public type CreateContactOfferRequest = { id : Blob; capability : Blob; peer : Principal; contact : ContactBinding; title : Text; duration_minutes : Nat32; candidate_starts_ns : [Nat64]; expires_at_ns : Nat64 };
    public type MutationRequest = { id : Blob; expected_revision : Nat64 };
    public type SelectRequest = { id : Blob; expected_revision : Nat64; selected_start_ns : Nat64 };
    public type RemoteExchangeRequest = { version : Nat8; command : Text; command_id : Blob; negotiation_id : Blob; capability : Blob; expected_revision : Nat64; title : Text; duration_minutes : Nat32; candidate_starts_ns : [Nat64]; selected_start_ns : ?Nat64; expires_at_ns : Nat64 };
    public type RemoteReply = { #ok : { revision : Nat64; state : State; candidate_starts_ns : [Nat64] }; #err : Error };
    public type MediaSelectRequest = { id : Blob };
    public type MediaMeeting = { id : Blob; title : Text; peer : Principal; initiator : Bool };
    public type MediaMeetingResult = { #ok : MediaMeeting; #err : Error };
    public type SignalSendRequest = { negotiation_id : Blob; signal_id : Blob; kind : Text; payload : Text };
    public type RemoteSignalRequest = { version : Nat8; negotiation_id : Blob; capability : Blob; signal_id : Blob; kind : Text; payload : Text; expires_at_ns : Nat64 };
    public type SignalReply = { #ok; #err : Error };
    public type SignalPollRequest = { negotiation_id : Blob; after_sequence : Nat64 };
    public type SignalView = { sequence : Nat64; signal_id : Blob; kind : Text; payload : Text };
    public type SignalPage = { latest_sequence : Nat64; signals : [SignalView] };

    public type CalendarAvailability = { revision : Nat64; available_starts_ns : [Nat64] };
    public type SuggestRequestV1 = { duration_minutes : Nat32; candidate_starts_ns : [Nat64] };
    public type CalendarReserve = { #reserved : { event_id : Nat64; event_revision : Nat64; calendar_revision : Nat64 }; #conflict : { calendar_revision : Nat64 }; #stale : { calendar_revision : Nat64 }; #invalid; #full };
    public type CalendarSimple = { #ok : { calendar_revision : Nat64 }; #not_found : { calendar_revision : Nat64 }; #invalid };
    public type ContactErrorV2 = { #validation : Text; #not_found : Nat; #conflict : { expected : Nat; actual : Nat }; #neutron_conflict : { principal : Principal; contact_id : Nat; contact_name : Text }; #limit : Text };
    public type Contact = { contact_id : Nat; contact_revision : Nat; contact_name : Text; principal : Principal };
    public type ContactPage = { book_revision : Nat; contacts : [Contact]; total : Nat; next_offset : ?Nat };
    public type ContactSearchRequest = { search_text : Text; offset : Nat; limit : Nat };
    public type ContactSearchDependencyResult = { #ok : ContactPage; #err : ContactErrorV2 };
    public type ContactSearchResult = { #ok : ContactPage; #err : Error };
    public type ContactLookup = { book_revision : Nat; integrity_ok : Bool; match : ?Contact };
    public type AppCalls = { calendar : {
        calendar_availability_v1 : { window_start_ns : Nat64; window_end_ns : Nat64; duration_minutes : Nat32; candidate_starts_ns : [Nat64] } -> CalendarAvailability;
        calendar_reserve_v1 : { external_id : Blob; expected_revision : Nat64; start_ns : Nat64; duration_minutes : Nat32; meeting_label : Text; hold_expires_at_ns : Nat64 } -> CalendarReserve;
        calendar_confirm_v1 : { external_id : Blob } -> CalendarSimple;
        calendar_release_v1 : { external_id : Blob } -> CalendarSimple;
    }; contacts : {
        contacts_neutron_lookup_v2 : { principal : Principal } -> ContactLookup;
        contacts_neutron_search_v2 : ContactSearchRequest -> ContactSearchDependencyResult;
        contacts_neutron_revision_v2 : (()) -> Nat;
    } };
    public type AppBackendEnvironment = { stable_memory : { rendezvous : Memory.Mem }; app_calls : AppCalls; capabilities : { backend_calls : NeutronCapabilities.BackendCallsV1 } };

    public func remoteExpectedRevision(command : Text, state : State, revision : Nat64) : Nat64 {
        if (command == "offer") 0 else if (command == "accept" and state == #accept_intent and revision > 0) revision - 1 else revision
    };

    public func commandIdFor(id : Blob, revision : Nat64, command : Text) : Blob {
        let idBytes = Blob.toArray(id);
        let context = Blob.toArray(Text.encodeUtf8(Nat64.toText(revision) # ":" # command));
        Blob.fromArray(Array.tabulate<Nat8>(16, func(i) {
            let identityByte : Nat8 = if (i < idBytes.size()) idBytes[i] else 0;
            Nat8.bitxor(identityByte, context[i % context.size()])
        }))
    };

    public func failedDelivery(code : Text, message : Text) : Delivery {
        if (code == "timeout") #uncertain(message) else #retryable(message)
    };

    public class Init(env : AppBackendEnvironment) {
        let mem = env.stable_memory.rendezvous; let calendar = env.app_calls.calendar; let contacts = env.app_calls.contacts; let calls = env.capabilities.backend_calls; let self = calls.canister_principal;
        var mediaSelection : ?Blob = null;
        public func /*query*/rendezvous_status() : Status { { revision = mem.revision; negotiation_count = mem.negotiations.size(); actionable_count = Array.filter<Memory.Negotiation>(mem.negotiations, func(n) { n.state == #offered or n.state == #countered }).size() } };
        public func /*query*/rendezvous_list(request : ListRequest) : ListResult { let limit = if (request.limit > 50) 50 else request.limit; { revision = mem.revision; total = mem.negotiations.size(); negotiations = Array.tabulate<NegotiationView>(Nat.min(limit, if (request.offset >= mem.negotiations.size()) 0 else mem.negotiations.size() - request.offset), func(i) { view(mem.negotiations[request.offset + i]) }) } };
        public func /*query*/rendezvous_get(request : GetRequest) : ?NegotiationView { switch (find(request.id)) { case (?(_, n)) ?view(n); case null null } };
        public func /*query*/rendezvous_suggest_v1(request : SuggestRequestV1) : CalendarAvailability { availabilityFor(request.candidate_starts_ns, request.duration_minutes) };
        public func /*query*/rendezvous_contacts_search_v1(request : ContactSearchRequest) : ContactSearchResult {
            if (not validContactSearch(request)) return #err(error("invalid_contact_search", "Search text or page bounds are invalid", false, false));
            switch (contacts.contacts_neutron_search_v2(request)) {
                case (#err(_)) #err(error("contacts_unavailable", "Contacts could not complete that search", true, false));
                case (#ok(page)) {
                    if (not validContactPage(request, page)) return #err(error("contacts_invalid", "Contacts returned an invalid or conflicting result", false, false));
                    #ok(page);
                };
            };
        };
        public func /*update*/rendezvous_create_offer(request : CreateOfferRequest) : Result {
            createOffer(request);
        };
        public func /*update*/rendezvous_create_contact_offer(request : CreateContactOfferRequest) : Result {
            let lookup = contacts.contacts_neutron_lookup_v2({ principal = request.peer });
            if (
                not lookup.integrity_ok or
                lookup.book_revision != request.contact.book_revision or
                contacts.contacts_neutron_revision_v2(()) != request.contact.book_revision
            ) return #err(contactChanged());
            let ?match = lookup.match else return #err(contactChanged());
            if (
                match.contact_id != request.contact.contact_id or
                match.contact_revision != request.contact.contact_revision or
                not Principal.equal(match.principal, request.peer)
            ) return #err(contactChanged());
            createOffer({
                id = request.id;
                capability = request.capability;
                peer = request.peer;
                title = request.title;
                duration_minutes = request.duration_minutes;
                candidate_starts_ns = request.candidate_starts_ns;
                expires_at_ns = request.expires_at_ns;
            });
        };

        func createOffer(request : CreateOfferRequest) : Result {
            if (Principal.equal(request.peer, self)) return #err(error("self_invite", "A Rendezvous peer must be another Neutron", false, false));
            switch (validate(request.id, request.capability, request.title, request.duration_minutes, request.candidate_starts_ns, request.expires_at_ns)) { case (?e) return #err(e); case null {} };
            if (find(request.id) != null) return #err(error("duplicate", "Negotiation ID already exists", false, false)); if (mem.negotiations.size() >= MAX_NEGOTIATIONS) return #err(error("capacity", "Negotiation capacity reached", false, false));
            let n : Memory.Negotiation = { id = request.id; capability = request.capability; revision = 1; direction = #outbound; peer = ?request.peer; state = #draft; title = request.title; duration_minutes = request.duration_minutes; candidate_starts_ns = canonical(request.candidate_starts_ns); selected_start_ns = null; expires_at_ns = request.expires_at_ns; outbound_bytes = null; attempts = 0; delivery = #idle };
            mem.negotiations := Array.concat(mem.negotiations, [n]); bump(); #ok(view(n));
        };
        public func /*update*/rendezvous_send_offer(request : MutationRequest) : async* Result { await* sendExisting(request.id, request.expected_revision, "offer", null) };
        public func /*update*/rendezvous_counter(request : SelectRequest) : async* Result { await* sendExisting(request.id, request.expected_revision, "counter", ?request.selected_start_ns) };
        public func /*update*/rendezvous_accept(request : SelectRequest) : async* Result {
            let ?(index, n) = find(request.id) else return #err(error("not_found", "Negotiation not found", false, false)); if (n.revision != request.expected_revision) return #err(stale());
            let current = availabilityFor(n.candidate_starts_ns, n.duration_minutes); if (Array.find(current.available_starts_ns, func(start) { start == request.selected_start_ns }) == null) return #err(error("conflict", "That time is no longer available", false, false));
            switch (calendar.calendar_reserve_v1({ external_id = n.id; expected_revision = current.revision; start_ns = request.selected_start_ns; duration_minutes = n.duration_minutes; meeting_label = n.title; hold_expires_at_ns = n.expires_at_ns })) { case (#reserved(_)) {}; case (#conflict(_)) return #err(error("conflict", "That time is no longer available", false, false)); case (#stale(_)) return #err(error("calendar_stale", "Calendar changed; refresh and retry", true, false)); case (#invalid) return #err(error("calendar_invalid", "Calendar rejected the reservation", false, false)); case (#full) return #err(error("calendar_full", "Calendar capacity reached", false, false)) };
            replace(index, { n with state = #accept_intent; selected_start_ns = ?request.selected_start_ns; revision = n.revision + 1 });
            let sent = await* sendExisting(n.id, n.revision + 1, "accept", ?request.selected_start_ns); switch (sent) { case (#ok(done)) { ignore calendar.calendar_confirm_v1({ external_id = n.id }); #ok(done) }; case (#err(e)) #err(e) };
        };
        public func /*update*/rendezvous_decline(request : MutationRequest) : async* Result { await* sendExisting(request.id, request.expected_revision, "decline", null) };
        public func /*update*/rendezvous_cancel(request : MutationRequest) : async* Result { ignore calendar.calendar_release_v1({ external_id = request.id }); await* sendExisting(request.id, request.expected_revision, "cancel", null) };
        public func /*update*/rendezvous_retry(request : MutationRequest) : async* Result { let ?(_, n) = find(request.id) else return #err(error("not_found", "Negotiation not found", false, false)); let command = stateCommand(n.state); await* sendExisting(request.id, request.expected_revision, command, n.selected_start_ns) };

        public func /*update*/rendezvous_media_select_v1(request : MediaSelectRequest) : MediaMeetingResult {
            switch (mediaMeeting(request.id)) {
                case (#err(e)) #err(e);
                case (#ok(meeting)) { mediaSelection := ?request.id; #ok(meeting) };
            }
        };
        public func /*query*/rendezvous_media_current_v1() : MediaMeetingResult {
            let ?id = mediaSelection else return #err(error("no_media_selection", "Choose a confirmed meeting first", false, false));
            mediaMeeting(id)
        };
        public func /*update*/rendezvous_signal_send_v1(request : SignalSendRequest) : async* SignalReply {
            let ?(_, n) = find(request.negotiation_id) else return #err(error("not_found", "Meeting not found", false, false));
            let ?peer = n.peer else return #err(error("no_peer", "Meeting has no peer", false, false));
            if (not signalAllowed(n, request.signal_id, request.kind, request.payload)) return #err(error("invalid_signal", "Signal is invalid or meeting is not confirmed", false, false));
            let expires = nowNs() + SIGNAL_TTL_NS;
            let wire : RemoteSignalRequest = { version = 1; negotiation_id = n.id; capability = n.capability; signal_id = request.signal_id; kind = request.kind; payload = request.payload; expires_at_ns = expires };
            let bytes = to_candid(wire); if (bytes.size() > MAX_WIRE) return #err(error("oversize", "Signal is too large", false, false));
            let ingress : NeutronCapabilities.PublicIngressRequestV1 = { method = SIGNAL_ROUTE; payload = bytes };
            let callResult = try { await* calls.call({ canister = peer; method = SIGNAL_METHOD; args = to_candid(ingress); cycles = REMOTE_CYCLES }) } catch (_) { return #err(error("transport_exception", "Signal delivery outcome is unknown", true, true)) };
            switch (callResult) {
                case (#err(e)) #err(error(e.code, e.message, true, e.code == "timeout"));
                case (#ok(raw)) {
                    let ?inner = PublicIngressWire.unwrapOk(raw, MAX_WIRE) else return #err(error("remote_decode", "Peer returned an invalid signal response", true, true));
                    let decoded : ?SignalReply = from_candid(inner); switch (decoded) { case (?reply) reply; case null #err(error("remote_decode", "Peer returned an invalid signal response", true, true)) };
                };
            }
        };
        public func /*query*/rendezvous_signal_poll_v1(request : SignalPollRequest) : SignalPage {
            let selected = switch (mediaSelection) { case (?id) id == request.negotiation_id; case null false };
            if (not selected) return { latest_sequence = mem.signal_sequence; signals = [] };
            let now = nowNs();
            { latest_sequence = mem.signal_sequence; signals = Array.map<Memory.Signal, SignalView>(Array.filter<Memory.Signal>(mem.signals, func(signal) { signal.expires_at_ns > now and signal.negotiation_id == request.negotiation_id and signal.sequence > request.after_sequence }), func(signal) { { sequence = signal.sequence; signal_id = signal.signal_id; kind = signal.kind; payload = signal.payload } }) };
        };
        public func /*update*/rendezvous_media_close_v1() : () {
            let closing = mediaSelection;
            mediaSelection := null;
            switch (closing) {
                case null {};
                case (?id) {
                    mem.signals := Array.filter<Memory.Signal>(mem.signals, func(signal) { signal.negotiation_id != id });
                    mem.signal_receipts := Array.filter<Memory.SignalReceipt>(mem.signal_receipts, func(receipt) { receipt.negotiation_id != id });
                };
            };
            cleanupSignals()
        };

        public func /*update*/rendezvous_remote_signal_v1(request : RemoteSignalRequest, /*caller*/ caller : Principal) : SignalReply {
            cleanupSignals();
            if (request.version != 1 or request.expires_at_ns <= nowNs() or request.expires_at_ns > nowNs() + SIGNAL_TTL_NS) return #err(error("invalid_signal", "Signal version or expiry is invalid", false, false));
            let ?(_, n) = find(request.negotiation_id) else return #err(error("not_found", "Meeting not found", false, false));
            if (n.peer != ?caller or n.capability != request.capability or not signalAllowed(n, request.signal_id, request.kind, request.payload)) return #err(error("forbidden", "Signal capability or peer binding failed", false, false));
            for (receipt in mem.signal_receipts.vals()) if (Principal.equal(receipt.peer, caller) and receipt.negotiation_id == request.negotiation_id and receipt.signal_id == request.signal_id) return #ok;
            mem.signal_sequence += 1;
            let signal : Memory.Signal = { sequence = mem.signal_sequence; peer = caller; negotiation_id = request.negotiation_id; signal_id = request.signal_id; kind = request.kind; payload = request.payload; expires_at_ns = request.expires_at_ns };
            mem.signals := appendBounded<Memory.Signal>(mem.signals, signal, MAX_SIGNALS);
            mem.signal_receipts := appendBounded<Memory.SignalReceipt>(mem.signal_receipts, { peer = caller; negotiation_id = request.negotiation_id; signal_id = request.signal_id; expires_at_ns = request.expires_at_ns }, MAX_SIGNAL_RECEIPTS);
            #ok
        };

        public func /*update*/rendezvous_remote_exchange_v1(request : RemoteExchangeRequest, /*caller*/ caller : Principal) : RemoteReply {
            if (Principal.equal(caller, self)) return #err(error("self_call", "Self exchange rejected", false, false));
            if (request.version != 1 or request.command_id.size() != 16) return #err(error("invalid_wire", "Invalid protocol version or command ID", false, false));
            for (receipt in mem.receipts.vals()) if (Principal.equal(receipt.peer, caller) and receipt.negotiation_id == request.negotiation_id and receipt.command_id == request.command_id) return receipt.reply;
            let reply = receive(caller, request); mem.receipts := Array.concat(if (mem.receipts.size() >= MAX_RECEIPTS) Array.tabulate<Memory.Receipt>(MAX_RECEIPTS - 1, func(i) { mem.receipts[i + 1] }) else mem.receipts, [{ peer = caller; negotiation_id = request.negotiation_id; command_id = request.command_id; reply }]); reply;
        };

        func receive(caller : Principal, request : RemoteExchangeRequest) : RemoteReply {
            if (request.command == "offer") {
                switch (validate(request.negotiation_id, request.capability, request.title, request.duration_minutes, request.candidate_starts_ns, request.expires_at_ns)) { case (?e) return #err(e); case null {} };
                if (find(request.negotiation_id) != null) return #err(error("duplicate", "Negotiation already exists", false, false));
                let available = availability(request); if (available.size() == 0) return #err(error("no_availability", "No proposed times are currently available", false, false));
                let n : Memory.Negotiation = { id = request.negotiation_id; capability = request.capability; revision = 1; direction = #inbound; peer = ?caller; state = #offered; title = request.title; duration_minutes = request.duration_minutes; candidate_starts_ns = available; selected_start_ns = null; expires_at_ns = request.expires_at_ns; outbound_bytes = null; attempts = 0; delivery = #delivered };
                mem.negotiations := Array.concat(mem.negotiations, [n]); bump(); return okReply(n);
            };
            let ?(index, n) = find(request.negotiation_id) else return #err(error("not_found", "Unknown negotiation", false, false)); if (n.capability != request.capability or n.peer != ?caller) return #err(error("forbidden", "Capability or peer binding failed", false, false)); if (request.expected_revision != n.revision) return #err(error("stale", "Remote revision mismatch", true, false));
            var next = n;
            if (request.command == "counter") { let ?selected = request.selected_start_ns else return #err(error("invalid", "Counter requires a selected time", false, false)); if (availability({ request with candidate_starts_ns = [selected] }).size() == 0) return #err(error("conflict", "Counter time is unavailable", false, false)); next := { n with state = #countered; selected_start_ns = ?selected; candidate_starts_ns = [selected]; revision = n.revision + 1 } }
            else if (request.command == "accept") { let ?selected = request.selected_start_ns else return #err(error("invalid", "Accept requires a selected time", false, false)); let current = availabilityFor([selected], n.duration_minutes); if (current.available_starts_ns.size() == 0) return #err(error("conflict", "Time became unavailable", false, false)); switch (calendar.calendar_reserve_v1({ external_id = n.id; expected_revision = current.revision; start_ns = selected; duration_minutes = n.duration_minutes; meeting_label = n.title; hold_expires_at_ns = n.expires_at_ns })) { case (#reserved(_)) {}; case (_) return #err(error("conflict", "Time became unavailable", false, false)) }; ignore calendar.calendar_confirm_v1({ external_id = n.id }); next := { n with state = #confirmed; selected_start_ns = ?selected; revision = n.revision + 1 } }
            else if (request.command == "decline") next := { n with state = #declined; revision = n.revision + 1 }
            else if (request.command == "cancel") { ignore calendar.calendar_release_v1({ external_id = n.id }); next := { n with state = #cancelled; revision = n.revision + 1 } }
            else return #err(error("invalid_command", "Unknown or forbidden command", false, false)); replace(index, next); okReply(next);
        };

        func sendExisting(id : Blob, expected : Nat64, command : Text, selected : ?Nat64) : async* Result {
            let ?(index, n) = find(id) else return #err(error("not_found", "Negotiation not found", false, false)); if (n.revision != expected) return #err(stale()); let ?peer = n.peer else return #err(error("no_peer", "Negotiation has no peer", false, false));
            let remoteExpected = remoteExpectedRevision(command, n.state, n.revision);
            let commandId = commandIdFor(n.id, n.revision, command); let request : RemoteExchangeRequest = { version = 1; command; command_id = commandId; negotiation_id = n.id; capability = n.capability; expected_revision = remoteExpected; title = n.title; duration_minutes = n.duration_minutes; candidate_starts_ns = n.candidate_starts_ns; selected_start_ns = selected; expires_at_ns = n.expires_at_ns };
            let bytes = to_candid(request); if (bytes.size() > MAX_WIRE) return #err(error("oversize", "Protocol request is too large", false, false)); let pending = { n with outbound_bytes = ?bytes; attempts = n.attempts + 1; delivery = #pending }; replace(index, pending);
            let ingress : NeutronCapabilities.PublicIngressRequestV1 = { method = REMOTE_ROUTE; payload = bytes };
            let callResult = try {
                await* calls.call({ canister = peer; method = REMOTE_METHOD; args = to_candid(ingress); cycles = REMOTE_CYCLES });
            } catch (_) {
                let message = "Peer delivery outcome is unknown";
                replace(index, { pending with delivery = #uncertain(message) });
                return #err(error("transport_exception", message, true, true));
            };
            switch (callResult) {
                case (#err(e)) { let uncertain = e.code == "timeout"; let failed = { pending with delivery = failedDelivery(e.code, e.message) }; replace(index, failed); #err(error(e.code, e.message, true, uncertain)) };
                case (#ok(raw)) { let ?inner = PublicIngressWire.unwrapOk(raw, MAX_WIRE) else { let failed = { pending with delivery = #uncertain("Invalid ingress response") }; replace(index, failed); return #err(error("remote_decode", "Peer may have committed, but returned an invalid response", true, true)) }; let decoded : ?RemoteReply = from_candid(inner); let ?reply = decoded else return #err(error("remote_decode", "Invalid Rendezvous response", true, true));
                    switch (reply) { case (#err(e)) { replace(index, { pending with delivery = #rejected(e.message) }); #err(e) }; case (#ok(remote)) { var state = remote.state; if (command == "offer" and state == #offered) state := #offered; let done = { pending with state; candidate_starts_ns = remote.candidate_starts_ns; selected_start_ns = selected; revision = remote.revision; outbound_bytes = null; delivery = #delivered }; replace(index, done); #ok(view(done)) } };
                };
            };
        };
        func availability(request : RemoteExchangeRequest) : [Nat64] { availabilityFor(request.candidate_starts_ns, request.duration_minutes).available_starts_ns };
        func mediaMeeting(id : Blob) : MediaMeetingResult { let ?(_, n) = find(id) else return #err(error("not_found", "Meeting not found", false, false)); let ?peer = n.peer else return #err(error("no_peer", "Meeting has no peer", false, false)); if (n.state != #confirmed) return #err(error("not_confirmed", "Only a confirmed meeting can start media", false, false)); #ok({ id = n.id; title = n.title; peer; initiator = n.direction == #outbound }) };
        func signalAllowed(n : Memory.Negotiation, signalId : Blob, kind : Text, payload : Text) : Bool { n.state == #confirmed and signalId.size() == 16 and (kind == "description" or kind == "candidate" or kind == "end") and payload.size() <= MAX_SIGNAL_TEXT and not hasUnsafeControls(payload) };
        func cleanupSignals() { let now = nowNs(); mem.signals := Array.filter<Memory.Signal>(mem.signals, func(signal) { signal.expires_at_ns > now }); mem.signal_receipts := Array.filter<Memory.SignalReceipt>(mem.signal_receipts, func(receipt) { receipt.expires_at_ns > now }) };
        func appendBounded<T>(values : [T], value : T, maximum : Nat) : [T] { Array.concat(if (values.size() >= maximum) Array.tabulate<T>(maximum - 1, func(i) { values[i + 1] }) else values, [value]) };
        func nowNs() : Nat64 { Nat64.fromNat(Int.abs(Time.now())) };
        func availabilityFor(candidates : [Nat64], duration : Nat32) : CalendarAvailability { if (candidates.size() == 0) return { revision = 0; available_starts_ns = [] }; let starts = canonical(candidates); let last = starts[starts.size() - 1]; let end = Nat64.fromNat(Nat64.toNat(last) + Nat32.toNat(duration) * 60_000_000_000); calendar.calendar_availability_v1({ window_start_ns = starts[0]; window_end_ns = end; duration_minutes = duration; candidate_starts_ns = starts }) };
        func find(id : Blob) : ?(Nat, Memory.Negotiation) { var i = 0; while (i < mem.negotiations.size()) { if (mem.negotiations[i].id == id) return ?(i, mem.negotiations[i]); i += 1 }; null };
        func replace(index : Nat, n : Memory.Negotiation) { mem.negotiations := Array.tabulate(mem.negotiations.size(), func(i) { if (i == index) n else mem.negotiations[i] }); bump() };
        func bump() { mem.revision += 1 };
        func localPeerName(peer : ?Principal) : ?Text {
            let ?principal = peer else return null;
            let lookup = contacts.contacts_neutron_lookup_v2({ principal });
            if (not lookup.integrity_ok) return null;
            let ?match = lookup.match else return null;
            if (not Principal.equal(match.principal, principal) or Text.size(match.contact_name) == 0) return null;
            ?match.contact_name
        };
        func view(n : Memory.Negotiation) : NegotiationView { { id = n.id; revision = n.revision; direction = n.direction; peer = n.peer; peer_name = localPeerName(n.peer); state = n.state; title = n.title; duration_minutes = n.duration_minutes; candidate_starts_ns = n.candidate_starts_ns; selected_start_ns = n.selected_start_ns; expires_at_ns = n.expires_at_ns; delivery = n.delivery } };
        func okReply(n : Memory.Negotiation) : RemoteReply { #ok({ revision = n.revision; state = n.state; candidate_starts_ns = n.candidate_starts_ns }) };
        func canonical(values : [Nat64]) : [Nat64] { var last : ?Nat64 = null; Array.filter(values, func(v) { let keep = switch (last) { case null true; case (?p) v > p }; last := ?v; keep }) };
        func validate(id : Blob, capability : Blob, title : Text, duration : Nat32, candidates : [Nat64], expires : Nat64) : ?Error { if (id.size() != 16 or capability.size() != 16) return ?error("invalid_id", "IDs must be 128-bit values", false, false); if (title.size() == 0 or title.size() > MAX_TITLE) return ?error("invalid_title", "Title length is invalid", false, false); if (duration < MIN_DURATION or duration > MAX_DURATION) return ?error("invalid_duration", "Duration must be 15–480 minutes", false, false); if (candidates.size() == 0 or candidates.size() > MAX_CANDIDATES or canonical(candidates).size() != candidates.size()) return ?error("invalid_candidates", "Candidates must be bounded, unique, and increasing", false, false); if (Nat64.toNat(expires) <= Int.abs(Time.now())) return ?error("expired", "Invite has expired", false, false); null };
        func validContactSearch(request : ContactSearchRequest) : Bool {
            request.search_text.size() <= 120 and not hasUnsafeControls(request.search_text) and request.offset <= 2_000 and request.limit > 0 and request.limit <= 20;
        };
        func validContactPage(request : ContactSearchRequest, page : ContactPage) : Bool {
            if (page.total > 2_000 or page.contacts.size() > request.limit) return false;
            let expectedCount = if (request.offset >= page.total) 0 else Nat.min(request.limit, page.total - request.offset);
            if (page.contacts.size() != expectedCount) return false;
            let end = request.offset + page.contacts.size();
            if (page.next_offset != (if (end < page.total) ?end else null)) return false;
            var index = 0;
            while (index < page.contacts.size()) {
                let contact = page.contacts[index];
                if (contact.contact_id == 0 or contact.contact_revision == 0 or contact.contact_name.size() == 0 or contact.contact_name.size() > 120 or hasUnsafeControls(contact.contact_name) or not Principal.isCanister(contact.principal)) return false;
                var prior = 0;
                while (prior < index) {
                    if (page.contacts[prior].contact_id == contact.contact_id or Principal.equal(page.contacts[prior].principal, contact.principal)) return false;
                    prior += 1;
                };
                index += 1;
            };
            true;
        };
        func hasUnsafeControls(value : Text) : Bool {
            for (char in value.chars()) { let code = Char.toNat32(char); if (code < 32 or code == 127) return true };
            false;
        };
        func contactChanged() : Error { error("contact_changed", "That Contact changed. Search again and review the exact recipient before sending", true, false) };
        func stateCommand(state : Memory.State) : Text { switch (state) { case (#draft) "offer"; case (#accept_intent) "accept"; case (#declined) "decline"; case (#cancelled) "cancel"; case (_) "counter" } };
        func stale() : Error { error("stale", "Negotiation changed; refresh before acting", true, false) }; func error(code : Text, message : Text, retryable : Bool, uncertain : Bool) : Error { { code; message; retryable; uncertain } };
    };
/*---NEUTRON GENERATED BEGIN---*/

public type rendezvous_status_Input = ();
public type rendezvous_status_Output = Status;

public type rendezvous_list_Input = (request : ListRequest);
public type rendezvous_list_Output = ListResult;

public type rendezvous_get_Input = (request : GetRequest);
public type rendezvous_get_Output = ?NegotiationView;

public type rendezvous_suggest_v1_Input = (request : SuggestRequestV1);
public type rendezvous_suggest_v1_Output = CalendarAvailability;

public type rendezvous_contacts_search_v1_Input = (request : ContactSearchRequest);
public type rendezvous_contacts_search_v1_Output = ContactSearchResult;

public type rendezvous_create_offer_Input = (request : CreateOfferRequest);
public type rendezvous_create_offer_Output = Result;

public type rendezvous_create_contact_offer_Input = (request : CreateContactOfferRequest);
public type rendezvous_create_contact_offer_Output = Result;

public type rendezvous_send_offer_Input = (request : MutationRequest);
public type rendezvous_send_offer_Output = Result;

public type rendezvous_counter_Input = (request : SelectRequest);
public type rendezvous_counter_Output = Result;

public type rendezvous_accept_Input = (request : SelectRequest);
public type rendezvous_accept_Output = Result;

public type rendezvous_decline_Input = (request : MutationRequest);
public type rendezvous_decline_Output = Result;

public type rendezvous_cancel_Input = (request : MutationRequest);
public type rendezvous_cancel_Output = Result;

public type rendezvous_retry_Input = (request : MutationRequest);
public type rendezvous_retry_Output = Result;

public type rendezvous_media_select_v1_Input = (request : MediaSelectRequest);
public type rendezvous_media_select_v1_Output = MediaMeetingResult;

public type rendezvous_media_current_v1_Input = ();
public type rendezvous_media_current_v1_Output = MediaMeetingResult;

public type rendezvous_signal_send_v1_Input = (request : SignalSendRequest);
public type rendezvous_signal_send_v1_Output = SignalReply;

public type rendezvous_signal_poll_v1_Input = (request : SignalPollRequest);
public type rendezvous_signal_poll_v1_Output = SignalPage;

public type rendezvous_media_close_v1_Input = ();
public type rendezvous_media_close_v1_Output = ();

public type rendezvous_remote_signal_v1_Input = (request : RemoteSignalRequest);
public type rendezvous_remote_signal_v1_Output = SignalReply;

public type rendezvous_remote_exchange_v1_Input = (request : RemoteExchangeRequest);
public type rendezvous_remote_exchange_v1_Output = RemoteReply;

/*---NEUTRON GENERATED END---*/
}
