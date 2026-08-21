import Principal "mo:core/Principal";
module {
    public type Direction = { #inbound; #outbound };
    public type State = { #draft; #offered; #countered; #accept_intent; #confirmed; #declined; #cancelled; #expired };
    public type Delivery = { #idle; #pending; #delivered; #retryable : Text; #uncertain : Text; #rejected : Text };
    public type Negotiation = { id : Blob; capability : Blob; revision : Nat64; direction : Direction; peer : ?Principal; state : State; title : Text; duration_minutes : Nat32; candidate_starts_ns : [Nat64]; selected_start_ns : ?Nat64; expires_at_ns : Nat64; outbound_bytes : ?Blob; attempts : Nat16; delivery : Delivery };
    public type ReceiptReply = { #ok : { revision : Nat64; state : State; candidate_starts_ns : [Nat64] }; #err : { code : Text; message : Text; retryable : Bool; uncertain : Bool } };
    public type Receipt = { peer : Principal; negotiation_id : Blob; command_id : Blob; reply : ReceiptReply };
    public type Mem = { var revision : Nat64; var negotiations : [Negotiation]; var receipts : [Receipt] };
    public func init() : Mem { { var revision = 0; var negotiations = []; var receipts = [] } };
}
