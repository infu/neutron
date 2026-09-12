module {
  public type Error = { code : Text; message : Text };
  public type Result<T> = { #ok : T; #err : Error };
  public type Kind = { #issue; #feedback; #app_suggestion; #feature_suggestion };
  public type AuthorRole = { #user; #moderator };
  public type Init = { administrator : Principal };
  public type Info = { protocolVersion : Nat; schemaVersion : Nat; administrator : Principal };
  public type Session = { neutron : Principal; moderator : Bool; unreadReplies : Nat };
  public type Thread = {
    id : Nat64;
    owner : Principal;
    kind : Kind;
    title : Text;
    appId : ?Text;
    resolved : Bool;
    needsReply : Bool;
    messageCount : Nat;
    lastMessageId : Nat64;
    unreadReplies : Nat;
    activity : Nat64;
    createdAtNs : Int;
    updatedAtNs : Int;
  };
  public type Message = {
    id : Nat64;
    threadId : Nat64;
    author : Principal;
    role : AuthorRole;
    body : Text;
    moderatorSequence : Nat;
    createdAtNs : Int;
  };
  public type Moderator = { id : Nat64; neutron : Principal; active : Bool; updatedAtNs : Int };
  public type PageRequest = { cursor : ?Nat64; limit : Nat };
  public type MyThreadsRequest = { cursor : ?Nat64; limit : Nat; kind : ?Kind; unreadOnly : Bool };
  public type ModerationThreadsRequest = { cursor : ?Nat64; limit : Nat; kind : ?Kind; needsReply : Bool };
  public type ThreadPage = { items : [Thread]; nextCursor : ?Nat64 };
  public type MessagePage = { items : [Message]; nextCursor : ?Nat64 };
  public type ModeratorPage = { items : [Moderator]; nextCursor : ?Nat64 };
  public type MessagesRequest = { threadId : Nat64; cursor : ?Nat64; limit : Nat };
  public type CreateRequest = { requestId : Text; kind : Kind; title : Text; appId : ?Text; body : Text };
  public type ReplyRequest = { requestId : Text; threadId : Nat64; body : Text };
  public type MarkReadRequest = { threadId : Nat64; throughMessageId : Nat64 };
  public type StatusRequest = { threadId : Nat64; resolved : Bool };
  public type DelegateRequest = { browser : Principal };
  public type ModeratorRequest = { neutron : Principal; active : Bool };
}
