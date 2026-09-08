// Persistent schema for the SNS Governance app.
//
// Keep this file immutable after release. Package imports are allowed;
// relative imports are forbidden so app-local types cannot drift.
//
// Design notes:
//   * The backend deliberately stores NO SNS domain data (proposals, neurons,
//     ledger state). All of that is read anonymously in the browser and is
//     free; persisting it here would cost the owner storage for no benefit.
//   * What lives here is exactly the state that must survive a reload and that
//     authorizes a signed write: the owner's SNS allowlist, the per-SNS agent
//     voting policy, an append-only audit trail, and proposal drafts.
import Map "mo:core/Map";

module {
    /// One SNS the owner has admitted. Keyed by the SNS root canister id.
    ///
    /// `governance` is the only principal the relay will ever target for this
    /// entry, so the allowlist is enforced against a value the owner approved
    /// rather than one supplied by the frontend at call time.
    public type SnsEntry = {
        governance : Principal;
        /// Owner allowlist: may the relay sign `manage_neuron` for this SNS.
        var voting_enabled : Bool;
        /// Agent voting policy. Defaults to false; settable only from the tile.
        var agent_voting_enabled : Bool;
        var label_text : Text;
        added_at_seconds : Nat64;
    };

    /// One append-only audit row per attempted signed governance action.
    /// Held in an ordered map keyed by `seq` so paging is a reverse range scan
    /// and trimming is removal of the smallest keys; both are O(log n).
    /// Bounded: the service trims the oldest rows past `max_audit_rows`.
    public type AuditRow = {
        seq : Nat;
        /// SNS root canister id.
        sns : Principal;
        governance : Principal;
        /// "vote" | "proposal" | "other"
        kind : Text;
        proposal_id : ?Nat64;
        /// "user" | "agent" | "timer"
        initiator : Text;
        /// For a vote: 1 = adopt, 2 = reject. Mirrors the SNS `Vote` encoding.
        vote : ?Int32;
        neurons_attempted : Nat;
        neurons_succeeded : Nat;
        /// Bounded, redacted. Never contains payload bytes or arguments.
        note : Text;
        at_seconds : Nat64;
    };

    /// A proposal awaiting human review. Drafts are small and user-visible if
    /// lost, so they live in managed memory rather than browser storage.
    public type Draft = {
        id : Nat;
        sns : Principal;
        governance : Principal;
        var title : Text;
        var summary : Text;
        var url : Text;
        /// Logical action kind, e.g. "Motion" or "ExecuteGenericNervousSystemFunction".
        var action_kind : Text;
        /// Set for custom proposals; the exact Candid argument bytes.
        var payload : ?Blob;
        /// Custom-function id for ExecuteGenericNervousSystemFunction drafts.
        var function_id : ?Nat64;
        /// Last validator rendering seen, for review. Bounded by the service.
        var rendering : ?Text;
        /// Neuron that will propose, as the raw 32-byte subaccount.
        var proposer : ?Blob;
        var created_by : Text;
        var updated_at_seconds : Nat64;
    };

    public type Mem = {
        /// SNS root canister id -> entry.
        snses : Map.Map<Principal, SnsEntry>;
        audit : Map.Map<Nat, AuditRow>;
        var audit_seq : Nat;
        drafts : Map.Map<Nat, Draft>;
        var draft_seq : Nat;
        /// Owner-tunable bound on retained audit rows.
        var max_audit_rows : Nat;
    };

    public func init() : Mem {
        {
            snses = Map.empty<Principal, SnsEntry>();
            audit = Map.empty<Nat, AuditRow>();
            var audit_seq = 0;
            drafts = Map.empty<Nat, Draft>();
            var draft_seq = 0;
            var max_audit_rows = 1_000;
        };
    };
};
