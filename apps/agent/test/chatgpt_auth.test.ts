import { expect, test } from "bun:test";
import {
  CHATGPT_AUTH_ORIGIN,
  CHATGPT_DEVICE_VERIFICATION_URL,
  CHATGPT_OAUTH_CLIENT_ID,
  ChatGptAuthError,
  chatGptCredentialsNeedRefresh,
  completeChatGptDeviceLogin,
  refreshChatGptCredentials,
  startChatGptDeviceLogin,
  type ChatGptCredentials,
  type ChatGptDeviceLogin,
  type ChatGptFetch,
} from "../src/chatgpt_auth.ts";

const time = 1_800_000_000_000;
const authClaim = "https://api.openai.com/auth";

function jwt(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function sequence(responses: Response[]): { fetch: ChatGptFetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  return {
    calls,
    fetch: async (input, init) => {
      calls.push({ url: String(input), ...(init ? { init } : {}) });
      const response = responses.shift();
      if (!response) throw new Error("Unexpected request");
      return response;
    },
  };
}

const login: ChatGptDeviceLogin = {
  verificationUrl: CHATGPT_DEVICE_VERIFICATION_URL,
  userCode: "ABCD-EFGH",
  deviceAuthId: "device-id",
  intervalMs: 2_000,
  expiresAt: time + 900_000,
};

const existing: ChatGptCredentials = {
  accessToken: jwt({ exp: time / 1_000 + 3_600, [authClaim]: { chatgpt_account_id: "account-1" } }),
  refreshToken: "refresh-1",
  idToken: jwt({ email: "owner@example.test", [authClaim]: { chatgpt_account_id: "account-1", chatgpt_plan_type: "plus" } }),
  accountId: "account-1",
  expiresAt: time + 3_600_000,
  email: "owner@example.test",
  planType: "plus",
};

test("device login uses Codex's public client and keeps the supplied route and cancellation signal", async () => {
  const route = sequence([json({ device_auth_id: "device-id", usercode: "ABCD-EFGH", interval: "2" })]);
  const signal = new AbortController().signal;
  const result = await startChatGptDeviceLogin({ fetch: route.fetch, signal, now: () => time });
  expect(result).toEqual(login);
  expect(route.calls[0]?.url).toBe(`${CHATGPT_AUTH_ORIGIN}/api/accounts/deviceauth/usercode`);
  expect(JSON.parse(String(route.calls[0]?.init?.body))).toEqual({ client_id: CHATGPT_OAUTH_CLIENT_ID });
  expect(route.calls[0]?.init?.credentials).toBe("omit");
  expect(route.calls[0]?.init?.signal).toBe(signal);
});

test("device login reads user_code and a numeric interval, and reports unavailable device auth", async () => {
  const route = sequence([json({ device_auth_id: "id", user_code: "CODE", interval: 3 }), json({}, 404)]);
  expect((await startChatGptDeviceLogin({ fetch: route.fetch })).intervalMs).toBe(3_000);
  await expect(startChatGptDeviceLogin({ fetch: route.fetch })).rejects.toMatchObject({ code: "device_login_unavailable", status: 404 });
});

test("device polling treats 403 and 404 as pending, then exchanges the issued PKCE code", async () => {
  const route = sequence([
    json({}, 403), json({}, 404),
    json({ authorization_code: "code+with&encoding", code_verifier: "verifier+&", code_challenge: "challenge" }),
    json({ access_token: existing.accessToken, refresh_token: existing.refreshToken, id_token: existing.idToken }),
  ]);
  let current = time;
  const sleeps: number[] = [];
  const credentials = await completeChatGptDeviceLogin(login, {
    fetch: route.fetch,
    now: () => current,
    sleep: async (ms) => { sleeps.push(ms); current += ms; },
  });
  expect(credentials).toEqual(existing);
  expect(sleeps).toEqual([2_000, 2_000]);
  for (const call of route.calls.slice(0, 3)) {
    expect(call.url).toBe(`${CHATGPT_AUTH_ORIGIN}/api/accounts/deviceauth/token`);
    expect(JSON.parse(String(call.init?.body))).toEqual({ device_auth_id: "device-id", user_code: "ABCD-EFGH" });
  }
  const exchange = route.calls[3]!;
  expect(exchange.url).toBe(`${CHATGPT_AUTH_ORIGIN}/oauth/token`);
  expect(exchange.init?.headers).toEqual({ "content-type": "application/x-www-form-urlencoded" });
  expect(Object.fromEntries(new URLSearchParams(String(exchange.init?.body)))).toEqual({
    grant_type: "authorization_code",
    code: "code+with&encoding",
    redirect_uri: `${CHATGPT_AUTH_ORIGIN}/deviceauth/callback`,
    client_id: CHATGPT_OAUTH_CLIENT_ID,
    code_verifier: "verifier+&",
  });
});

test("device code expires without starting more requests or extending the provider's lifetime", async () => {
  let current = login.expiresAt - 100;
  const route = sequence([json({}, 403)]);
  const sleeps: number[] = [];
  await expect(completeChatGptDeviceLogin(login, {
    fetch: route.fetch,
    now: () => current,
    sleep: async (ms) => { sleeps.push(ms); current += ms; },
  })).rejects.toMatchObject({ code: "device_code_expired" });
  expect(sleeps).toEqual([100]);
  expect(route.calls).toHaveLength(1);
});

test("canceling during the polling timer prevents subsequent token requests", async () => {
  const controller = new AbortController();
  let notify!: () => void;
  const pending = new Promise<void>((resolve) => { notify = resolve; });
  let requests = 0;
  const result = completeChatGptDeviceLogin(login, {
    signal: controller.signal,
    now: () => time,
    fetch: async () => { requests++; notify(); return json({}, 403); },
  });
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(requests).toBe(1);
});

test("canceling before or during authorization prevents token exchange", async () => {
  const controller = new AbortController();
  let requests = 0;
  const fetch: ChatGptFetch = async () => {
    requests++;
    controller.abort();
    return json({ authorization_code: "code", code_verifier: "verifier" });
  };
  await expect(completeChatGptDeviceLogin(login, { fetch, signal: controller.signal, now: () => time })).rejects.toMatchObject({ name: "AbortError" });
  await expect(startChatGptDeviceLogin({ fetch, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(requests).toBe(1);
});

test("refresh rotates credentials and preserves ID/account metadata when omitted", async () => {
  const accessToken = jwt({ exp: time / 1_000 + 7_200 });
  const route = sequence([json({ access_token: accessToken, refresh_token: "refresh-2" })]);
  const refreshed = await refreshChatGptCredentials(existing, { fetch: route.fetch, now: () => time });
  expect(refreshed).toEqual({ ...existing, accessToken, refreshToken: "refresh-2", expiresAt: time + 7_200_000 });
  expect(JSON.parse(String(route.calls[0]?.init?.body))).toEqual({
    client_id: CHATGPT_OAUTH_CLIENT_ID, grant_type: "refresh_token", refresh_token: "refresh-1",
  });
  expect(route.calls[0]?.init?.headers).toEqual({ "content-type": "application/json" });
  expect(existing.refreshToken).toBe("refresh-1");
});

test("partial refresh responses retain omitted access tokens as Codex's refresh contract permits", async () => {
  const route = sequence([json({ refresh_token: "refresh-2" })]);
  const refreshed = await refreshChatGptCredentials(existing, { fetch: route.fetch, now: () => time });
  expect(refreshed).toEqual({ ...existing, refreshToken: "refresh-2" });
});

test.each([404, 500])("device start cancels a routed error body for HTTP %s", async (status) => {
  let cancelled = false;
  const route = sequence([new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status })]);
  await expect(startChatGptDeviceLogin({ fetch: route.fetch })).rejects.toBeInstanceOf(ChatGptAuthError);
  expect(cancelled).toBe(true);
});

test("device polling and token exchange cancel unconsumed routed error bodies", async () => {
  let cancelled = 0;
  const failure = () => new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 500 });
  const route = sequence([failure(), json({ authorization_code: "code", code_verifier: "verifier" }), failure()]);
  await expect(completeChatGptDeviceLogin(login, { fetch: route.fetch, now: () => time })).rejects.toBeInstanceOf(ChatGptAuthError);
  expect(cancelled).toBe(1);
  await expect(completeChatGptDeviceLogin(login, { fetch: route.fetch, now: () => time })).rejects.toBeInstanceOf(ChatGptAuthError);
  expect(cancelled).toBe(2);
});

test.each(["start", "poll", "exchange", "refresh"] as const)("abort after %s response headers cancels the routed body", async (stage) => {
  const controller = new AbortController();
  let cancelled = false;
  let calls = 0;
  const fetch: ChatGptFetch = async () => {
    calls++;
    if (stage === "exchange" && calls === 1) return json({ authorization_code: "code", code_verifier: "verifier" });
    controller.abort();
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  };
  const options = { fetch, signal: controller.signal, now: () => time };
  const result = stage === "start" ? startChatGptDeviceLogin(options)
    : stage === "refresh" ? refreshChatGptCredentials(existing, options)
      : completeChatGptDeviceLogin(login, options);
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(cancelled).toBe(true);
});

test("opaque access tokens use expires_in and missing expiry remains unknown", async () => {
  const route = sequence([json({ access_token: "opaque", expires_in: 120 }), json({ access_token: "opaque-again" })]);
  const refreshed = await refreshChatGptCredentials(existing, { fetch: route.fetch, now: () => time });
  expect(refreshed.expiresAt).toBe(time + 120_000);
  expect(refreshed.refreshToken).toBe(existing.refreshToken);
  expect(chatGptCredentialsNeedRefresh(refreshed, time)).toBe(false);
  expect(chatGptCredentialsNeedRefresh(refreshed, time + 60_000)).toBe(true);
  const unknownExpiry = await refreshChatGptCredentials(refreshed, { fetch: route.fetch, now: () => time });
  expect(unknownExpiry.expiresAt).toBeNull();
  expect(chatGptCredentialsNeedRefresh(unknownExpiry, time + 365 * 86_400_000)).toBe(false);
});

test.each([
  [400, { error: "invalid_grant" }],
  [401, { error: { message: "expired" } }],
  [400, { error: { code: "refresh_token_expired" } }],
  [400, { error: { code: "refresh_token_reused" } }],
  [400, { error: { code: "refresh_token_invalidated" } }],
] as const)("terminal refresh failure %s asks for login without exposing returned secrets", async (status, error) => {
  const route = sequence([json({ ...error, secret: existing.refreshToken }, status)]);
  try {
    await refreshChatGptCredentials(existing, { fetch: route.fetch });
    throw new Error("Expected failure");
  } catch (failure) {
    expect(failure).toBeInstanceOf(ChatGptAuthError);
    expect((failure as ChatGptAuthError).requiresLogin).toBe(true);
    expect(String(failure)).not.toContain(existing.refreshToken);
  }
});

test("transient refresh failures retain credentials and do not report a disconnected account", async () => {
  const route = sequence([new Response("gateway error refresh-1", { status: 502 })]);
  await expect(refreshChatGptCredentials(existing, { fetch: route.fetch })).rejects.toMatchObject({ code: "request_failed", requiresLogin: false, status: 502 });
  expect(existing.refreshToken).toBe("refresh-1");
});

test("a refresh cannot silently replace the selected account", async () => {
  const route = sequence([
    json({ id_token: jwt({ [authClaim]: { chatgpt_account_id: "another-account" } }) }),
    json({ access_token: jwt({ [authClaim]: { chatgpt_account_id: "another-account" } }) }),
  ]);
  await expect(refreshChatGptCredentials(existing, { fetch: route.fetch })).rejects.toMatchObject({ code: "login_required" });
  await expect(refreshChatGptCredentials(existing, { fetch: route.fetch })).rejects.toMatchObject({ code: "login_required" });
});

test("fresh access-token metadata supersedes a retained ID token after a plan change", async () => {
  const route = sequence([json({ access_token: jwt({ [authClaim]: { chatgpt_account_id: "account-1", chatgpt_plan_type: "pro" } }) })]);
  const refreshed = await refreshChatGptCredentials(existing, { fetch: route.fetch });
  expect(refreshed.planType).toBe("pro");
  expect(refreshed.idToken).toBe(existing.idToken);
});

test("malformed token responses and missing account metadata fail without leaking token contents", async () => {
  const route = sequence([
    json({ authorization_code: "code", code_verifier: "verifier" }),
    json({ access_token: "secret-access", refresh_token: "secret-refresh", id_token: "not.a.jwt" }),
  ]);
  await expect(completeChatGptDeviceLogin(login, { fetch: route.fetch, now: () => time })).rejects.toMatchObject({ code: "invalid_response", message: "OpenAI returned an invalid ChatGPT account ID. Please connect again." });
  const invalid = sequence([new Response("secret-access", { status: 200 })]);
  await expect(startChatGptDeviceLogin({ fetch: invalid.fetch })).rejects.toMatchObject({ code: "invalid_response" });
});

test("UTF-8 JWT profile metadata is decoded in browsers", async () => {
  const route = sequence([
    json({ authorization_code: "code", code_verifier: "verifier" }),
    json({ access_token: jwt({ exp: time / 1_000 + 300, [authClaim]: { chatgpt_account_id: "account-1", chatgpt_plan_type: "pro" }, "https://api.openai.com/profile": { email: "élise@example.test" } }), refresh_token: "refresh" }),
  ]);
  expect(await completeChatGptDeviceLogin(login, { fetch: route.fetch, now: () => time })).toMatchObject({ email: "élise@example.test", planType: "pro", accountId: "account-1" });
});
