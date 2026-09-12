// All rights reserved. See ../LICENSE.
import Char "mo:core/Char";
import Iter "mo:core/Iter";
import List "mo:core/List";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Time "mo:core/Time";
import Generated "../.ashroot/lib";
import API "./API";

persistent actor class Feedback(initial : API.Init) {
  // This root is retained across upgrades. The initializer is never an upgrade
  // fallback, and the cached database handles are reconstructed only once.
  let memory = Generated.Mem();
  transient let db = Generated.Use(memory, { administrator = initial.administrator; nextActivity = 1 });
  transient let largestId : Nat64 = 18_446_744_073_709_551_615;

  type StoredThread = Generated.Types.Thread;
  type StoredMessage = Generated.Types.Message;

  func failure<T>(code : Text, message : Text) : API.Result<T> { #err({ code; message }) };
  func must<T>(result : { #ok : T; #err : Generated.Threads.Errors.Error }) : T {
    switch (result) {
      case (#ok(value)) value;
      // No method below awaits. Trapping preserves all-or-nothing multi-table
      // writes; returning an error after a partial write would not roll it back.
      case (#err(error)) Runtime.trap("Feedback storage write failed: " # debug_show(error));
    };
  };
  func principalClass(value : Principal) : ?Nat8 {
    let bytes = Principal.toBlob(value);
    if (bytes.size() == 0) null else ?bytes[bytes.size() - 1];
  };
  func writer(caller : Principal) : API.Result<Principal> {
    if (principalClass(caller) != ?(1 : Nat8)) return failure("neutron_required", "Send this change through your Neutron.");
    #ok(caller);
  };
  func readOwner(caller : Principal) : API.Result<Principal> {
    if (Principal.isAnonymous(caller)) return failure("authentication_required", "Connect to your Neutron to view feedback.");
    if (principalClass(caller) == ?(1 : Nat8)) return #ok(caller);
    switch (db.delegates.by_browser.lookup(caller)) {
      case (?delegate) #ok(delegate.owner);
      case null failure("delegate_required", "Connect this browser through your Neutron to view feedback.");
    };
  };
  func isModerator(neutron : Principal) : Bool {
    switch (db.moderators.by_neutron.lookup(neutron)) { case (?value) value.active; case null false };
  };
  func moderatorReader(caller : Principal) : API.Result<Principal> {
    let neutron = switch (readOwner(caller)) { case (#err(error)) return #err(error); case (#ok(value)) value };
    if (not isModerator(neutron)) return failure("moderator_required", "This Neutron is not assigned to the support team.");
    #ok(neutron);
  };
  func moderatorWriter(caller : Principal) : API.Result<Principal> {
    let neutron = switch (writer(caller)) { case (#err(error)) return #err(error); case (#ok(value)) value };
    if (not isModerator(neutron)) return failure("moderator_required", "This Neutron is not assigned to the support team.");
    #ok(neutron);
  };
  func administrator(caller : Principal) : Bool {
    not Principal.isAnonymous(caller) and caller == db.store.get().administrator;
  };
  func ownedThread(owner : Principal, id : Nat64) : API.Result<StoredThread> {
    switch (db.threads.get(id)) {
      case (?value) if (value.owner == owner) return #ok(value);
      case null {};
    };
    failure("thread_not_found", "This conversation is not available.");
  };
  func existingThread(id : Nat64) : API.Result<StoredThread> {
    switch (db.threads.get(id)) { case (?value) #ok(value); case null failure("thread_not_found", "This conversation is not available.") };
  };
  func threadView(value : StoredThread) : API.Thread {
    {
      id = value.id; owner = value.owner; kind = value.kind; title = value.title;
      appId = value.appId; resolved = value.resolved; needsReply = value.needsReply;
      messageCount = value.messageCount; lastMessageId = value.lastMessageId;
      unreadReplies = value.moderatorReplies - value.readModeratorReplies;
      activity = value.activity; createdAtNs = value.createdAtNs; updatedAtNs = value.updatedAtNs;
    };
  };
  func messageView(value : StoredMessage) : API.Message {
    {
      id = value.id; threadId = value.threadId; author = value.author; role = value.role;
      body = value.body; moderatorSequence = value.moderatorSequence; createdAtNs = value.createdAtNs;
    };
  };
  func unreadCount(owner : Principal) : Nat {
    switch (db.owners.by_neutron.lookup(owner)) { case (?value) value.unreadReplies; case null 0 };
  };
  func setUnreadCount(owner : Principal, count : Nat) {
    switch (db.owners.by_neutron.lookup(owner)) {
      case (?value) { ignore must(db.owners.update({ value with unreadReplies = count })) };
      case null { ignore must(db.owners.insert({ neutron = owner; unreadReplies = count })) };
    };
  };
  func activity() : Nat64 {
    let value = db.store.get().nextActivity;
    db.store.nextActivity.set(value + 1);
    value;
  };
  func hasText(value : Text) : Bool { Text.trim(value, #predicate(Char.isWhitespace)) != "" };
  func validPage(limit : Nat) : API.Result<()> {
    if (limit == 0) failure("invalid_page", "Choose a positive page size.") else #ok(());
  };
  // User-approved presentation and text bounds. Text.size counts Unicode
  // codepoints, including one character for a non-BMP emoji.
  func pageSize(requested : Nat) : Nat { if (requested > 30) 30 else requested };
  func selector(kind : ?API.Kind, selected : Bool) : Nat8 {
    let category : Nat8 = switch (kind) {
      case null 0;
      case (?#issue) 1;
      case (?#feedback) 2;
      case (?#app_suggestion) 3;
      case (?#feature_suggestion) 4;
    };
    category + (if (selected) 5 else 0);
  };
  func threadPage(values : Iter.Iter<StoredThread>, limit : Nat) : API.ThreadPage {
    let items = List.empty<API.Thread>();
    var last : ?Nat64 = null;
    while (List.size(items) < limit) {
      let ?value = values.next() else return { items = List.toArray(items); nextCursor = null };
      List.add(items, threadView(value));
      last := ?value.activity;
    };
    { items = List.toArray(items); nextCursor = switch (values.next()) { case null null; case (?_) last } };
  };
  func messagePage(request : API.MessagesRequest) : API.Result<API.MessagePage> {
    switch (validPage(request.limit)) { case (#err(error)) return #err(error); case (_) {} };
    let limit = pageSize(request.limit);
    let values = db.messages.by_thread.rangeIter({
      gt = switch (request.cursor) { case (?cursor) ?(request.threadId, cursor); case null null };
      gte = ?(request.threadId, 0);
      lt = null; lte = ?(request.threadId, largestId); dir = #fwd;
    }, null);
    let items = List.empty<API.Message>();
    var last : ?Nat64 = null;
    while (List.size(items) < limit) {
      let ?value = values.next() else return #ok({ items = List.toArray(items); nextCursor = null });
      List.add(items, messageView(value));
      last := ?value.id;
    };
    #ok({ items = List.toArray(items); nextCursor = switch (values.next()) { case null null; case (?_) last } });
  };

  public query func feedback_info() : async API.Info {
    { protocolVersion = 1; schemaVersion = 1; administrator = db.store.get().administrator };
  };
  public shared query ({ caller }) func session() : async API.Result<API.Session> {
    let neutron = switch (readOwner(caller)) { case (#err(error)) return #err(error); case (#ok(value)) value };
    #ok({ neutron; moderator = isModerator(neutron); unreadReplies = unreadCount(neutron) });
  };
  public shared ({ caller }) func read_delegate_set(request : API.DelegateRequest) : async API.Result<()> {
    let owner = switch (writer(caller)) { case (#err(error)) return #err(error); case (#ok(value)) value };
    if (principalClass(request.browser) != ?(2 : Nat8)) return failure("invalid_browser_identity", "Use this browser's signing identity to connect.");
    switch (db.delegates.by_browser.lookup(request.browser)) {
      case (?value) {
        if (value.owner != owner) return failure("delegate_owner_mismatch", "This browser identity belongs to another Neutron.");
        return #ok(());
      };
      case null {};
    };
    switch (db.delegates.by_owner.lookup(owner)) {
      case (?value) { ignore must(db.delegates.update({ value with browser = request.browser })) };
      case null { ignore must(db.delegates.insert({ owner; browser = request.browser })) };
    };
    #ok(());
  };
  public shared query ({ caller }) func my_threads(request : API.MyThreadsRequest) : async API.Result<API.ThreadPage> {
    let owner = switch (readOwner(caller)) { case (#err(error)) return #err(error); case (#ok(value)) value };
    switch (validPage(request.limit)) { case (#err(error)) return #err(error); case (_) {} };
    let selected = selector(request.kind, request.unreadOnly);
    #ok(threadPage(db.threads.by_owner_selection.rangeIter({
      gt = null; gte = ?(owner, selected, 0);
      lt = switch (request.cursor) { case (?cursor) ?(owner, selected, cursor); case null null };
      lte = ?(owner, selected, largestId); dir = #bwd;
    }, null), pageSize(request.limit)));
  };
  public shared query ({ caller }) func moderation_threads(request : API.ModerationThreadsRequest) : async API.Result<API.ThreadPage> {
    switch (moderatorReader(caller)) { case (#err(error)) return #err(error); case (_) {} };
    switch (validPage(request.limit)) { case (#err(error)) return #err(error); case (_) {} };
    let selected = selector(request.kind, request.needsReply);
    #ok(threadPage(db.threads.by_moderation_selection.rangeIter({
      gt = null; gte = ?(selected, 0);
      lt = switch (request.cursor) { case (?cursor) ?(selected, cursor); case null null };
      lte = ?(selected, largestId); dir = #bwd;
    }, null), pageSize(request.limit)));
  };
  public shared query ({ caller }) func thread(id : Nat64) : async API.Result<API.Thread> {
    let owner = switch (readOwner(caller)) { case (#err(error)) return #err(error); case (#ok(value)) value };
    switch (ownedThread(owner, id)) { case (#ok(value)) #ok(threadView(value)); case (#err(error)) #err(error) };
  };
  public shared query ({ caller }) func moderation_thread(id : Nat64) : async API.Result<API.Thread> {
    switch (moderatorReader(caller)) { case (#err(error)) return #err(error); case (_) {} };
    switch (existingThread(id)) { case (#ok(value)) #ok(threadView(value)); case (#err(error)) #err(error) };
  };
  public shared query ({ caller }) func messages(request : API.MessagesRequest) : async API.Result<API.MessagePage> {
    let owner = switch (readOwner(caller)) { case (#err(error)) return #err(error); case (#ok(value)) value };
    switch (ownedThread(owner, request.threadId)) { case (#err(error)) return #err(error); case (_) {} };
    messagePage(request);
  };
  public shared query ({ caller }) func moderation_messages(request : API.MessagesRequest) : async API.Result<API.MessagePage> {
    switch (moderatorReader(caller)) { case (#err(error)) return #err(error); case (_) {} };
    switch (existingThread(request.threadId)) { case (#err(error)) return #err(error); case (_) {} };
    messagePage(request);
  };

  public shared ({ caller }) func thread_create(request : API.CreateRequest) : async API.Result<API.Thread> {
    let owner = switch (writer(caller)) { case (#err(error)) return #err(error); case (#ok(value)) value };
    switch (db.threads.by_request.lookup((owner, request.requestId))) {
      case (?value) {
        let ?first = db.messages.get(value.firstMessageId) else Runtime.trap("Feedback first message is missing");
        if (value.kind != request.kind or value.title != request.title or value.appId != request.appId or first.body != request.body) {
          return failure("request_conflict", "This submission identifier was already used for different content.");
        };
        return #ok(threadView(value));
      };
      case null {};
    };
    if (not hasText(request.requestId)) return failure("request_id_required", "A submission identifier is required.");
    if (not hasText(request.title)) return failure("title_required", "Add a short title for your conversation.");
    if (not hasText(request.body)) return failure("message_required", "Write a message before sending.");
    if (Text.size(request.title) > 160) return failure("title_too_long", "Keep the title to 160 characters or fewer.");
    if (Text.size(request.body) > 16_000) return failure("message_too_long", "Keep each message to 16,000 characters or fewer.");
    let now = Time.now();
    let id = must(db.threads.insert({
      owner; requestId = request.requestId; kind = request.kind; title = request.title; appId = request.appId;
      resolved = false; needsReply = request.kind == #issue; messageCount = 1;
      firstMessageId = 0; lastMessageId = 0; lastRole = #user;
      moderatorReplies = 0; readModeratorReplies = 0; activity = activity(); createdAtNs = now; updatedAtNs = now;
    }));
    let messageId = must(db.messages.insert({
      threadId = id; author = owner; role = #user; requestId = null; body = request.body;
      moderatorSequence = 0; createdAtNs = now;
    }));
    let ?value = db.threads.get(id) else Runtime.trap("Feedback conversation insert is missing");
    let saved = must(db.threads.update({ value with firstMessageId = messageId; lastMessageId = messageId }));
    #ok(threadView(saved));
  };
  func appendReply(author : Principal, role : API.AuthorRole, current : StoredThread, request : API.ReplyRequest) : API.Result<API.Message> {
    switch (db.messages.by_request.lookup((author, request.requestId))) {
      case (?value) {
        if (value.threadId != request.threadId or value.body != request.body or value.role != role) {
          return failure("request_conflict", "This reply identifier was already used for different content.");
        };
        return #ok(messageView(value));
      };
      case null {};
    };
    if (not hasText(request.requestId)) return failure("request_id_required", "A reply identifier is required.");
    if (not hasText(request.body)) return failure("message_required", "Write a message before sending.");
    if (Text.size(request.body) > 16_000) return failure("message_too_long", "Keep each message to 16,000 characters or fewer.");
    let now = Time.now();
    let count = current.moderatorReplies + (if (role == #moderator) 1 else 0);
    let id = must(db.messages.insert({
      threadId = current.id; author; role; requestId = ?request.requestId; body = request.body;
      moderatorSequence = count; createdAtNs = now;
    }));
    ignore must(db.threads.update({ current with
      lastMessageId = id; lastRole = role; messageCount = current.messageCount + 1;
      moderatorReplies = count; activity = activity(); updatedAtNs = now;
      needsReply = current.kind == #issue and not current.resolved and role == #user;
    }));
    if (role == #moderator) setUnreadCount(current.owner, unreadCount(current.owner) + 1);
    let ?value = db.messages.get(id) else Runtime.trap("Feedback reply insert is missing");
    #ok(messageView(value));
  };
  public shared ({ caller }) func reply(request : API.ReplyRequest) : async API.Result<API.Message> {
    let owner = switch (writer(caller)) { case (#err(error)) return #err(error); case (#ok(value)) value };
    let current = switch (ownedThread(owner, request.threadId)) { case (#err(error)) return #err(error); case (#ok(value)) value };
    appendReply(owner, #user, current, request);
  };
  public shared ({ caller }) func moderation_reply(request : API.ReplyRequest) : async API.Result<API.Message> {
    let moderator = switch (moderatorWriter(caller)) { case (#err(error)) return #err(error); case (#ok(value)) value };
    let current = switch (existingThread(request.threadId)) { case (#err(error)) return #err(error); case (#ok(value)) value };
    appendReply(moderator, #moderator, current, request);
  };
  public shared ({ caller }) func mark_read(request : API.MarkReadRequest) : async API.Result<API.Thread> {
    let owner = switch (writer(caller)) { case (#err(error)) return #err(error); case (#ok(value)) value };
    let current = switch (ownedThread(owner, request.threadId)) { case (#err(error)) return #err(error); case (#ok(value)) value };
    let displayed = switch (db.messages.get(request.throughMessageId)) {
      case (?value) {
        if (value.threadId != current.id) return failure("message_not_found", "This message is not in the conversation.");
        value;
      };
      case null return failure("message_not_found", "This message is not in the conversation.");
    };
    if (displayed.moderatorSequence <= current.readModeratorReplies) return #ok(threadView(current));
    let delta = displayed.moderatorSequence - current.readModeratorReplies;
    let saved = must(db.threads.update({ current with readModeratorReplies = displayed.moderatorSequence }));
    setUnreadCount(owner, unreadCount(owner) - delta);
    #ok(threadView(saved));
  };
  public shared ({ caller }) func issue_status_set(request : API.StatusRequest) : async API.Result<API.Thread> {
    let owner = switch (writer(caller)) { case (#err(error)) return #err(error); case (#ok(value)) value };
    let current = switch (ownedThread(owner, request.threadId)) { case (#err(error)) return #err(error); case (#ok(value)) value };
    if (current.kind != #issue) return failure("issue_required", "Only support tickets can be resolved or reopened.");
    if (current.resolved == request.resolved) return #ok(threadView(current));
    #ok(threadView(must(db.threads.update({ current with
      resolved = request.resolved; needsReply = not request.resolved and current.lastRole == #user;
      activity = activity(); updatedAtNs = Time.now();
    }))));
  };

  public shared ({ caller }) func moderator_set(request : API.ModeratorRequest) : async API.Result<()> {
    if (not administrator(caller)) return failure("administrator_required", "Only the feedback administrator can assign moderators.");
    if (principalClass(request.neutron) != ?(1 : Nat8)) return failure("neutron_required", "Assign a Neutron canister ID as moderator.");
    switch (db.moderators.by_neutron.lookup(request.neutron)) {
      case (?value) {
        if (value.active == request.active) return #ok(());
        ignore must(db.moderators.update({ value with active = request.active; updatedAtNs = Time.now() }));
      };
      case null {
        if (request.active) ignore must(db.moderators.insert({ neutron = request.neutron; active = true; updatedAtNs = Time.now() }));
      };
    };
    #ok(());
  };
  public shared query ({ caller }) func moderators(request : API.PageRequest) : async API.Result<API.ModeratorPage> {
    if (not administrator(caller)) return failure("administrator_required", "Only the feedback administrator can view moderator assignments.");
    switch (validPage(request.limit)) { case (#err(error)) return #err(error); case (_) {} };
    let limit = pageSize(request.limit);
    let values = db.moderators.iterPrimary(#fwd, request.cursor);
    let items = List.empty<API.Moderator>();
    var last : ?Nat64 = null;
    label scan loop {
      let ?(id, value) = values.next() else return #ok({ items = List.toArray(items); nextCursor = null });
      switch (request.cursor) { case (?cursor) if (id <= cursor) continue scan; case null {} };
      if (List.size(items) == limit) return #ok({ items = List.toArray(items); nextCursor = last });
      List.add(items, value);
      last := ?id;
    };
    Runtime.trap("Feedback moderator iteration did not complete");
  };
}
