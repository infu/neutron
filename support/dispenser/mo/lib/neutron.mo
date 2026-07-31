// This is a generated Motoko binding.
// Please use `import service "ic:canister_id"` instead to call canisters on the IC if possible.

module {
  public type Callback = { token : ?Token; body : [Nat8] };
  public type CallbackFunc = shared query Token -> async Callback;
  public type Class = actor {
    http_request : shared query http_request_Input -> async http_request_Output;
    http_request_streaming_callback : shared query http_request_streaming_callback_Input -> async http_request_streaming_callback_Output;
    kernel_publication_entropy_initialize : shared Null -> async kernel_publication_entropy_initialize_Output;
    kernel_static : shared kernel_static_Input -> async kernel_static_Output;
    kernel_static_query : shared query kernel_static_query_Input -> async kernel_static_query_Output;
    kernel_activation : shared kernel_activation_Input -> async kernel_activation_Output;
  };
  public type File = {
    content : [Nat8];
    content_type : Text;
    chunks: Nat;
    content_encoding : Text;
  };
  public type HeaderField = (Text, Text);
  public type StreamingStrategy = {
    #Callback : { token : Token; callback : CallbackFunc };
  };
  public type Token = {
    key : Text;
    sha256 : ?[Nat8];
    index : Nat;
    content_encoding : Text;
  };
  public type http_request_Input = {
    url : Text;
    method : Text;
    body : [Nat8];
    headers : [HeaderField];
  };
  public type http_request_Output = {
    body : [Nat8];
    headers : [HeaderField];
    streaming_strategy : ?StreamingStrategy;
    status_code : Nat16;
  };
  public type http_request_streaming_callback_Input = {
    key : Text;
    sha256 : ?[Nat8];
    index : Nat;
    content_encoding : Text;
  };
  public type http_request_streaming_callback_Output = {
    token : ?Token;
    body : [Nat8];
  };
  public type kernel_publication_entropy_initialize_Output = {
    #ok : { fingerprint : Blob };
    #err : { #randomness_failed };
  };
  public type kernel_static_Input = {
    #clear : { prefix : Text };
    #delete : { key : Text };
    #store : { key : Text; val : File };
    #store_chunk : { key : Text; chunk_id : Nat; content : [Nat8] };
  };
  public type kernel_static_Output = Null;
  public type kernel_static_query_Input = { #list : { prefix : Text } };
  public type kernel_static_query_Output = [Text];
  public type kernel_activation_Input = {
    #set : Blob;
    #use : Blob;
  };
  public type kernel_activation_Output = {
    #ready;
    #authorized;
    #already_authorized;
    #already_set;
    #already_activated;
    #invalid;
  };
  public type Self = () -> async Class
}
