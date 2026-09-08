// Device authentication follows OpenAI's Codex login implementation:
// https://github.com/openai/codex/blob/main/codex-rs/login/src/device_code_auth.rs
// https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/manager.rs
// Fetch is supplied by the resident's extension route. This module never stores credentials.
export const CHATGPT_AUTH_ORIGIN = "https://auth.openai.com";
export const CHATGPT_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CHATGPT_DEVICE_VERIFICATION_URL = `${CHATGPT_AUTH_ORIGIN}/codex/device`;

export type ChatGptFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ChatGptCredentials {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  accountId: string;
  /** Access-token expiration in epoch milliseconds; null when OpenAI provides none. */
  expiresAt: number | null;
  email?: string;
  planType?: string;
}

export interface ChatGptDeviceLogin {
  verificationUrl: string;
  userCode: string;
  deviceAuthId: string;
  intervalMs: number;
  /** The one-time OpenAI code expires; extension pairing and route grants do not. */
  expiresAt: number;
}

export interface ChatGptAuthOptions {
  fetch: ChatGptFetch;
  signal?: AbortSignal | undefined;
  now?: () => number;
  /** Injectable timer for deterministic polling tests. */
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export class ChatGptAuthError extends Error {
  constructor(
    message: string,
    readonly code: "device_login_unavailable" | "device_code_expired" | "invalid_response" | "request_failed" | "login_required",
    readonly status?: number,
  ) {
    super(message);
    this.name = "ChatGptAuthError";
  }

  get requiresLogin(): boolean {
    return this.code === "login_required";
  }
}

const DEVICE_CODE_LIFETIME_MS = 15 * 60 * 1_000;
const AUTH_CLAIM = "https://api.openai.com/auth";
const PROFILE_CLAIM = "https://api.openai.com/profile";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function required(value: unknown, field: string): string {
  const result = nonempty(value);
  if (!result) throw new ChatGptAuthError(`OpenAI returned an invalid ${field}. Please connect again.`, "invalid_response");
  return result;
}

function checkAbort(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

async function closeResponse(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* Keep the original authentication error. */ }
}

async function checkResponseAbort(response: Response, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    await closeResponse(response);
    checkAbort(signal);
  }
}

function pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const result: unknown = await response.json();
    if (result === null || typeof result !== "object" || Array.isArray(result)) throw new Error();
    return result as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ChatGptAuthError("OpenAI returned an unreadable authentication response. Please try again.", "invalid_response", response.status);
  }
}

/** Decode only metadata from tokens received over the trusted auth route; this is not JWT verification. */
function jwtClaims(token: string | undefined): Record<string, unknown> {
  if (!token) return {};
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => !part)) return {};
    const payload = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "=")), (char) => char.charCodeAt(0));
    return record(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return {};
  }
}

function credentialsFromResponse(
  data: Record<string, unknown>,
  now: number,
  previous?: ChatGptCredentials,
): ChatGptCredentials {
  const accessToken = required(data.access_token ?? previous?.accessToken, "access token");
  const refreshToken = required(data.refresh_token ?? previous?.refreshToken, "refresh token");
  const idToken = nonempty(data.id_token) ?? previous?.idToken;
  const accessClaims = jwtClaims(accessToken);
  const idClaims = jwtClaims(idToken);
  const accessAuth = record(accessClaims[AUTH_CLAIM]);
  const idAuth = record(idClaims[AUTH_CLAIM]);
  // Fresh access-token metadata takes precedence over an ID token retained from an earlier refresh.
  const freshIdClaims = jwtClaims(nonempty(data.id_token));
  const freshIdAuth = record(freshIdClaims[AUTH_CLAIM]);
  const accountId = required(freshIdAuth.chatgpt_account_id ?? accessAuth.chatgpt_account_id ?? idAuth.chatgpt_account_id ?? previous?.accountId, "ChatGPT account ID");
  if (previous && accountId !== previous.accountId) {
    throw new ChatGptAuthError("The refreshed ChatGPT account changed. Please connect ChatGPT again.", "login_required");
  }
  const jwtExpiration = accessClaims.exp;
  const expiresIn = data.expires_in;
  const expiresAt = typeof jwtExpiration === "number" && Number.isFinite(jwtExpiration)
    ? jwtExpiration * 1_000
    : typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn >= 0
      ? now + expiresIn * 1_000
      : data.access_token == null ? previous?.expiresAt ?? null : null;
  const email = nonempty(freshIdClaims.email) ?? nonempty(record(freshIdClaims[PROFILE_CLAIM]).email)
    ?? nonempty(accessClaims.email) ?? nonempty(record(accessClaims[PROFILE_CLAIM]).email)
    ?? nonempty(idClaims.email) ?? nonempty(record(idClaims[PROFILE_CLAIM]).email) ?? previous?.email;
  const planType = nonempty(freshIdAuth.chatgpt_plan_type) ?? nonempty(accessAuth.chatgpt_plan_type)
    ?? nonempty(idAuth.chatgpt_plan_type) ?? previous?.planType;
  return {
    accessToken,
    refreshToken,
    accountId,
    expiresAt,
    ...(idToken ? { idToken } : {}),
    ...(email ? { email } : {}),
    ...(planType ? { planType } : {}),
  };
}

export async function startChatGptDeviceLogin(options: ChatGptAuthOptions): Promise<ChatGptDeviceLogin> {
  checkAbort(options.signal);
  const response = await options.fetch(`${CHATGPT_AUTH_ORIGIN}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: CHATGPT_OAUTH_CLIENT_ID }),
    credentials: "omit",
    signal: options.signal ?? null,
  });
  await checkResponseAbort(response, options.signal);
  if (response.status === 404) {
    await closeResponse(response);
    throw new ChatGptAuthError("Device-code login is unavailable. Check that device-code login is enabled in your ChatGPT security settings.", "device_login_unavailable", response.status);
  }
  if (!response.ok) {
    await closeResponse(response);
    throw new ChatGptAuthError(`Could not start ChatGPT login (HTTP ${response.status}). Please try again.`, "request_failed", response.status);
  }
  const data = await readJson(response);
  checkAbort(options.signal);
  const interval = typeof data.interval === "string" ? Number(data.interval) : data.interval;
  return {
    verificationUrl: CHATGPT_DEVICE_VERIFICATION_URL,
    userCode: required(data.user_code ?? data.usercode, "device code"),
    deviceAuthId: required(data.device_auth_id, "device authentication ID"),
    // OAuth device authorization's default interval is five seconds when omitted.
    intervalMs: typeof interval === "number" && Number.isFinite(interval) && interval > 0 ? interval * 1_000 : 5_000,
    expiresAt: (options.now ?? Date.now)() + DEVICE_CODE_LIFETIME_MS,
  };
}

export async function completeChatGptDeviceLogin(login: ChatGptDeviceLogin, options: ChatGptAuthOptions): Promise<ChatGptCredentials> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? pause;
  for (;;) {
    checkAbort(options.signal);
    if (now() >= login.expiresAt) throw new ChatGptAuthError("Your ChatGPT device code expired. Connect again to get a new code.", "device_code_expired");
    const response = await options.fetch(`${CHATGPT_AUTH_ORIGIN}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_auth_id: login.deviceAuthId, user_code: login.userCode }),
      credentials: "omit",
      signal: options.signal ?? null,
    });
    await checkResponseAbort(response, options.signal);
    if (response.status === 403 || response.status === 404) {
      // These statuses mean the owner has not approved the code yet in Codex's device flow.
      await closeResponse(response);
      await sleep(Math.max(0, Math.min(login.intervalMs, login.expiresAt - now())), options.signal);
      continue;
    }
    if (!response.ok) {
      await closeResponse(response);
      throw new ChatGptAuthError(`ChatGPT device login failed (HTTP ${response.status}). Please connect again.`, "request_failed", response.status);
    }
    const code = await readJson(response);
    checkAbort(options.signal);
    const exchange = await options.fetch(`${CHATGPT_AUTH_ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: required(code.authorization_code, "authorization code"),
        redirect_uri: `${CHATGPT_AUTH_ORIGIN}/deviceauth/callback`,
        client_id: CHATGPT_OAUTH_CLIENT_ID,
        code_verifier: required(code.code_verifier, "code verifier"),
      }).toString(),
      credentials: "omit",
      signal: options.signal ?? null,
    });
    await checkResponseAbort(exchange, options.signal);
    if (!exchange.ok) {
      await closeResponse(exchange);
      throw new ChatGptAuthError(`Could not complete ChatGPT login (HTTP ${exchange.status}). Please connect again.`, "request_failed", exchange.status);
    }
    const tokens = await readJson(exchange);
    checkAbort(options.signal);
    return credentialsFromResponse(tokens, now());
  }
}

/** Refresh shortly before provider expiry; an unknown expiry is handled by a caller's HTTP-401 recovery. */
export function chatGptCredentialsNeedRefresh(credentials: ChatGptCredentials, now = Date.now()): boolean {
  return credentials.expiresAt !== null && credentials.expiresAt <= now + 60_000;
}

export async function refreshChatGptCredentials(credentials: ChatGptCredentials, options: ChatGptAuthOptions): Promise<ChatGptCredentials> {
  checkAbort(options.signal);
  const response = await options.fetch(`${CHATGPT_AUTH_ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: CHATGPT_OAUTH_CLIENT_ID, grant_type: "refresh_token", refresh_token: credentials.refreshToken }),
    credentials: "omit",
    signal: options.signal ?? null,
  });
  await checkResponseAbort(response, options.signal);
  if (!response.ok) {
    let data: Record<string, unknown> = {};
    try { data = await readJson(response); } catch { checkAbort(options.signal); }
    const error = record(data.error);
    const code = nonempty(error.code) ?? nonempty(data.error) ?? nonempty(data.code);
    const normalizedCode = code?.toLowerCase();
    const terminal = response.status === 401
      || normalizedCode === "refresh_token_expired"
      || normalizedCode === "refresh_token_reused"
      || normalizedCode === "refresh_token_invalidated"
      || (response.status === 400 && normalizedCode === "invalid_grant");
    if (terminal) throw new ChatGptAuthError("Your ChatGPT login needs to be renewed. Please connect ChatGPT again.", "login_required", response.status);
    // Never copy the response body into user-visible errors: token endpoints can echo secrets.
    throw new ChatGptAuthError(`Could not refresh ChatGPT login (HTTP ${response.status}). Please try again.`, "request_failed", response.status);
  }
  const tokens = await readJson(response);
  checkAbort(options.signal);
  return credentialsFromResponse(tokens, (options.now ?? Date.now)(), credentials);
}
