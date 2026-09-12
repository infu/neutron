export type FeedbackKind = "issue" | "feedback" | "app_suggestion" | "feature_suggestion";
export type AuthorRole = "user" | "moderator";

export type FeedbackSession = {
  neutron: string;
  moderator: boolean;
  unreadReplies: number;
};

export type FeedbackThread = {
  id: string;
  owner: string;
  kind: FeedbackKind;
  title: string;
  appId: string | null;
  resolved: boolean;
  needsReply: boolean;
  messageCount: number;
  lastMessageId: string;
  unreadReplies: number;
  createdAt: string;
  updatedAt: string;
};

export type FeedbackMessage = {
  id: string;
  threadId: string;
  author: string;
  role: AuthorRole;
  body: string;
  createdAt: string;
};

export type FeedbackPage<T> = { items: T[]; nextCursor: string | null };
export type ThreadListInput = {
  cursor?: string;
  kind?: FeedbackKind;
  unreadOnly?: boolean;
  needsReply?: boolean;
};
export type CreateThreadInput = {
  requestId: string;
  kind: FeedbackKind;
  title: string;
  body: string;
  appId?: string;
};
export type ReplyInput = { requestId: string; threadId: string; body: string };
export type Discussion = { thread: FeedbackThread; messages: FeedbackPage<FeedbackMessage> };

export type PendingFeedbackRequest = {
  requestId: string;
  method: "create" | "reply" | "moderationReply";
  body: string;
  title?: string;
  kind?: FeedbackKind;
  appId?: string;
  threadId?: string;
};

export type FeedbackClient = {
  pending?(cursor?: string): Promise<FeedbackPage<PendingFeedbackRequest>>;
  resume?(requestId: string): Promise<FeedbackThread | FeedbackMessage>;
  session(): Promise<FeedbackSession>;
  list(input?: ThreadListInput): Promise<FeedbackPage<FeedbackThread>>;
  get(threadId: string, cursor?: string): Promise<Discussion>;
  create(input: CreateThreadInput): Promise<FeedbackThread>;
  reply(input: ReplyInput): Promise<FeedbackMessage>;
  markRead(threadId: string, throughMessageId: string): Promise<FeedbackThread>;
  setResolved(threadId: string, resolved: boolean): Promise<FeedbackThread>;
  moderationList(input?: ThreadListInput): Promise<FeedbackPage<FeedbackThread>>;
  moderationGet(threadId: string, cursor?: string): Promise<Discussion>;
  moderationReply(input: ReplyInput): Promise<FeedbackMessage>;
};
