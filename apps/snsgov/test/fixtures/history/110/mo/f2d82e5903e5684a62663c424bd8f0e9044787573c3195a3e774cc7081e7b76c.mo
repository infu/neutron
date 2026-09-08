import Map "59d991367413199580f31df1021c41cd6aafb1ad1580824a58e45ca6e5d1f9f2";
module {
    public type SnsEntry = {
        governance : Principal;
        var voting_enabled : Bool;
        var agent_voting_enabled : Bool;
        var label_text : Text;
        added_at_seconds : Nat64;
    };
    public type AuditRow = {
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
    public type Draft = {
        id : Nat;
        sns : Principal;
        governance : Principal;
        var title : Text;
        var summary : Text;
        var url : Text;
        var action_kind : Text;
        var payload : ?Blob;
        var function_id : ?Nat64;
        var rendering : ?Text;
        var proposer : ?Blob;
        var created_by : Text;
        var updated_at_seconds : Nat64;
    };
    public type Mem = {
        snses : Map.Map<Principal, SnsEntry>;
        audit : Map.Map<Nat, AuditRow>;
        var audit_seq : Nat;
        drafts : Map.Map<Nat, Draft>;
        var draft_seq : Nat;
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
