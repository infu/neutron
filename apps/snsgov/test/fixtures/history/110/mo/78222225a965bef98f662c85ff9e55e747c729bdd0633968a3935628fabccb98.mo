import Runtime "ccb23e2d72bb4ab9edc842d7dc106d708734b3a441117e4a7816067209391eac";
import Types "d1ceaf3da72a662842dad6256b90f6c4214b079f5658917a72e0fa3b97e21bdc";
module {
  public func get<T>(self : ?T, default : T) : T = switch self {
    case null { default };
    case (?x_) { x_ }
  };
  public func getMapped<T, R>(self : ?T, f : T -> R, default : R) : R = switch self {
    case null { default };
    case (?x_) { f(x_) }
  };
  public func map<T, R>(self : ?T, f : T -> R) : ?R = switch self {
    case null { null };
    case (?x_) { ?f(x_) }
  };
  public func forEach<T>(self : ?T, f : T -> ()) = switch self {
    case null {};
    case (?x_) { f(x_) }
  };
  public func apply<T, R>(self : ?T, f : ?(T -> R)) : ?R {
    switch (f, self) {
      case (?f_, ?x_) { ?f_(x_) };
      case (_, _) { null }
    }
  };
  public func chain<T, R>(self : ?T, f : T -> ?R) : ?R {
    switch (self) {
      case (?x_) { f(x_) };
      case (null) { null }
    }
  };
  public func flatten<T>(self : ??T) : ?T {
    chain<?T, T>(self, func(x_ : ?T) : ?T = x_)
  };
  public func some<T>(self : T) : ?T = ?self;
  public func isSome(self : ?Any) : Bool {
    self != null
  };
  public func isNull(self : ?Any) : Bool {
    self == null
  };
  public func equal<T>(self : ?T, other : ?T, eq : (implicit : (equal : (T, T) -> Bool))) : Bool = switch (self, other) {
    case (null, null) { true };
    case (?x_, ?y_) { eq(x_, y_) };
    case (_, _) { false }
  };
  public func compare<T>(self : ?T, other : ?T, compare : (implicit : (T, T) -> Types.Order)) : Types.Order = switch (self, other) {
    case (null, null) #equal;
    case (null, _) #less;
    case (_, null) #greater;
    case (?x_, ?y_) { compare(x_, y_) }
  };
  public func unwrap<T>(self : ?T) : T = switch self {
    case null { Runtime.trap("Option.unwrap()") };
    case (?x_) { x_ }
  };
  public func toText<T>(self : ?T, toText : (implicit : T -> Text)) : Text = switch self {
    case null { "null" };
    case (?x_) { "?" # toText(x_) }
  };
}
