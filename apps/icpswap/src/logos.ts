// Token icon resolution, entirely in the browser.
//
// Order of preference:
//   1. the ledger's own `icrc1:logo` metadata field — a data URI, authoritative
//      and available for most ICRC ledgers;
//   2. the SNS logo, for the 14 of 54 SNS ledgers (OpenChat, Gold DAO, Motoko,
//      Kinic and others) that predate `icrc1:logo` and never added it;
//   3. nothing, and the caller falls back to a monogram.
//
// Both lookups are anonymous read-only queries against public canisters, made
// straight from the tile. Nothing here touches the app's backend or its
// declared authority: an icon is presentation, and routing it through the
// canister would cost the owner storage and cycles for no benefit.
//
// Results are cached in `localStorage` under a byte budget, because logos are
// static and some data URIs run to tens of kilobytes.

import { Actor, HttpAgent } from "@dfinity/agent";
import type { IDL } from "@dfinity/candid";
import type { Principal } from "@dfinity/principal";

const IC_HOST = "https://icp-api.io";

/** NNS SNS-W: the registry of every deployed SNS. */
const SNS_WASM_CANISTER = "qaa6y-5yaaa-aaaaa-aaafa-cai";

/** SNS aggregator, which serves each SNS logo as a plain image. */
const SNS_AGGREGATOR = "https://3r4gx-wqaaa-aaaaq-aaaia-cai.icp0.io";

const CACHE_PREFIX = "ics.logo.v1.";
const CACHE_INDEX_KEY = "ics.logo.v1.index";
const SNS_INDEX_KEY = "ics.sns.v1.index";
const SNS_INDEX_TTL_MS = 24 * 60 * 60 * 1000;

/** Total bytes of cached logo values kept in localStorage. */
const CACHE_BUDGET_BYTES = 1_500_000;

/** A single value larger than this is used but never persisted. */
const MAX_CACHED_VALUE_BYTES = 48_000;

/** Concurrent canister queries. The market table asks for every row at once. */
const MAX_CONCURRENT_LOOKUPS = 6;

/**
 * The Internet Computer mark, drawn here because the ICP ledger publishes no
 * `icrc1:logo` and belongs to no SNS, so neither lookup can ever produce one.
 * It is the quote currency and the most prominent row in the table.
 */
const ICP_MARK =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PGcgZmlsbD0ibm9uZSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2Utd2lkdGg9IjcuNSIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMzIgMzIpIHNjYWxlKC44NCkgdHJhbnNsYXRlKC0zMiAtMzIpIj48cGF0aCBzdHJva2U9IiNGMTVBMjQiIGQ9Ik0zMiAzMmMtNS02LjUtMTAtMTAtMTUtMTAtNi4xIDAtMTEgNC41LTExIDEwczQuOSAxMCAxMSAxMGM1IDAgMTAtMy41IDE1LTEwIi8+PHBhdGggc3Ryb2tlPSIjMjlBQkUyIiBkPSJNMzIgMzJjNSA2LjUgMTAgMTAgMTUgMTAgNi4xIDAgMTEtNC41IDExLTEwcy00LjktMTAtMTEtMTBjLTUgMC0xMCAzLjUtMTUgMTAiLz48L2c+PC9zdmc+";

/**
 * Icons shipped with the app, for ledgers that publish none and belong to no
 * SNS. Checked first: these are ledgers already known to answer nothing, so a
 * lookup would only cost a round trip.
 */
const BUILTIN_LOGOS: Readonly<Record<string, string>> = {
  "ryjl3-tyaaa-aaaaa-aaaba-cai": ICP_MARK,
};

export type LogoResult = string | null;

const memory = new Map<string, LogoResult>();
const inFlight = new Map<string, Promise<LogoResult>>();
const listeners = new Set<() => void>();

/** Subscribe to resolutions. Components re-read through `peekLogo`. */
export function onLogoResolved(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The already-known icon for a token, without starting a lookup. */
export function peekLogo(ledgerId: string): LogoResult | undefined {
  const builtin = BUILTIN_LOGOS[ledgerId];
  if (builtin !== undefined) return builtin;
  const remembered = memory.get(ledgerId);
  if (remembered !== undefined) return remembered;
  const stored = cachedLogo(ledgerId);
  if (stored !== undefined) {
    memory.set(ledgerId, stored);
    return stored;
  }
  return undefined;
}

/**
 * Record that a resolved icon did not load, so the monogram takes over and the
 * bad value is not served from cache again. SNS roots without an uploaded logo
 * answer 404, which only the image element finds out.
 */
export function markLogoBroken(ledgerId: string): void {
  // A shipped icon cannot be replaced by a monogram; it is always loadable.
  if (BUILTIN_LOGOS[ledgerId] !== undefined) return;
  if (memory.get(ledgerId) === null) return;
  memory.set(ledgerId, null);
  cacheLogo(ledgerId, null);
  announce();
}

function announce(): void {
  for (const listener of listeners) listener();
}

let active = 0;
const waiting: Array<() => void> = [];

/** Run `task` once a lookup slot is free. */
async function gated<T>(task: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT_LOOKUPS) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  active += 1;
  try {
    return await task();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

// ------------------------------------------------------------------ storage

function readStore(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Private windows and blocked site data both throw; caching is optional.
    return null;
  }
}

function writeStore(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Quota or blocked storage: fall back to the in-memory cache only.
  }
}

function removeStore(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing to do; the entry simply stays.
  }
}

type CacheIndex = { keys: string[]; bytes: number };

function readIndex(): CacheIndex {
  const raw = readStore(CACHE_INDEX_KEY);
  if (!raw) return { keys: [], bytes: 0 };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as CacheIndex).keys) &&
      typeof (parsed as CacheIndex).bytes === "number"
    ) {
      return parsed as CacheIndex;
    }
  } catch {
    // A corrupt index just means we start over.
  }
  return { keys: [], bytes: 0 };
}

/** Persist one resolved logo, evicting oldest entries to stay under budget. */
function cacheLogo(ledgerId: string, value: LogoResult): void {
  const encoded = value ?? "";
  // A negative result is one byte and worth keeping: it stops us re-querying a
  // ledger that has no logo on every render.
  if (encoded.length > MAX_CACHED_VALUE_BYTES) return;

  const index = readIndex();
  const key = CACHE_PREFIX + ledgerId;
  const existing = index.keys.indexOf(key);
  if (existing >= 0) index.keys.splice(existing, 1);

  index.keys.push(key);
  index.bytes += encoded.length;

  while (index.bytes > CACHE_BUDGET_BYTES && index.keys.length > 1) {
    const oldest = index.keys.shift();
    if (!oldest) break;
    index.bytes -= (readStore(oldest) ?? "").length;
    removeStore(oldest);
  }
  if (index.bytes < 0) index.bytes = 0;

  writeStore(key, encoded);
  writeStore(CACHE_INDEX_KEY, JSON.stringify(index));
}

function cachedLogo(ledgerId: string): LogoResult | undefined {
  const raw = readStore(CACHE_PREFIX + ledgerId);
  if (raw === null) return undefined;
  return raw === "" ? null : raw;
}

// -------------------------------------------------------------- IC plumbing

let agentPromise: Promise<HttpAgent> | null = null;

function agent(): Promise<HttpAgent> {
  agentPromise ??= HttpAgent.create({ host: IC_HOST });
  return agentPromise;
}

const metadataIdl: IDL.InterfaceFactory = ({ IDL: idl }) => {
  const Value = idl.Rec();
  Value.fill(
    idl.Variant({
      Int: idl.Int,
      Nat: idl.Nat,
      Blob: idl.Vec(idl.Nat8),
      Text: idl.Text,
      Array: idl.Vec(Value),
      Map: idl.Vec(idl.Tuple(idl.Text, Value)),
    }),
  );
  return idl.Service({
    icrc1_metadata: idl.Func([], [idl.Vec(idl.Tuple(idl.Text, Value))], ["query"]),
  });
};

const snsWasmIdl: IDL.InterfaceFactory = ({ IDL: idl }) =>
  idl.Service({
    list_deployed_snses: idl.Func(
      [idl.Record({})],
      [
        idl.Record({
          instances: idl.Vec(
            idl.Record({
              root_canister_id: idl.Opt(idl.Principal),
              ledger_canister_id: idl.Opt(idl.Principal),
              governance_canister_id: idl.Opt(idl.Principal),
              index_canister_id: idl.Opt(idl.Principal),
              swap_canister_id: idl.Opt(idl.Principal),
            }),
          ),
        }),
      ],
      ["query"],
    ),
  });

type MetadataActor = {
  icrc1_metadata: () => Promise<Array<[string, unknown]>>;
};

type SnsWasmActor = {
  list_deployed_snses: (arg: Record<string, never>) => Promise<{
    instances: Array<{
      root_canister_id: [] | [Principal];
      ledger_canister_id: [] | [Principal];
    }>;
  }>;
};

function optionalPrincipal(value: [] | [Principal]): string | null {
  return value.length === 1 ? value[0]!.toText() : null;
}

// --------------------------------------------------------------- SNS index

type SnsIndex = { at: number; ledgers: Record<string, string> };

let snsIndexPromise: Promise<Record<string, string>> | null = null;

/** Ledger canister id to SNS root canister id, for every deployed SNS. */
export function loadSnsIndex(): Promise<Record<string, string>> {
  snsIndexPromise ??= (async () => {
    const cached = readStore(SNS_INDEX_KEY);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as SnsIndex;
        if (
          parsed &&
          typeof parsed.at === "number" &&
          Date.now() - parsed.at < SNS_INDEX_TTL_MS &&
          typeof parsed.ledgers === "object"
        ) {
          return parsed.ledgers;
        }
      } catch {
        // Fall through and refetch.
      }
    }

    const actor = Actor.createActor<SnsWasmActor>(snsWasmIdl, {
      agent: await agent(),
      canisterId: SNS_WASM_CANISTER,
    });
    const result = await actor.list_deployed_snses({});
    const ledgers: Record<string, string> = {};
    for (const instance of result.instances) {
      const ledger = optionalPrincipal(instance.ledger_canister_id);
      const root = optionalPrincipal(instance.root_canister_id);
      if (ledger && root) ledgers[ledger] = root;
    }
    writeStore(SNS_INDEX_KEY, JSON.stringify({ at: Date.now(), ledgers }));
    return ledgers;
  })().catch((error: unknown) => {
    // A failed index must not be memoised, or the SNS fallback dies for the
    // whole session on one transient error.
    snsIndexPromise = null;
    throw error;
  });
  return snsIndexPromise;
}

export function snsLogoUrl(rootCanisterId: string): string {
  return `${SNS_AGGREGATOR}/v1/sns/root/${rootCanisterId}/logo.png`;
}

// ------------------------------------------------------------ ledger lookup

/** The `icrc1:logo` data URI declared by a ledger, if it has one. */
export async function fetchLedgerLogo(ledgerId: string): Promise<LogoResult> {
  const actor = Actor.createActor<MetadataActor>(metadataIdl, {
    agent: await agent(),
    canisterId: ledgerId,
  });
  const entries = await actor.icrc1_metadata();
  return extractLogo(entries);
}

/**
 * Pull a usable icon out of ICRC-1 metadata.
 *
 * Exported for tests: the metadata value is a variant, ledgers disagree on the
 * key (`icrc1:logo` vs a bare `logo`), and only a `data:` image is safe to put
 * straight into an `img` element.
 */
export function extractLogo(entries: Array<[string, unknown]>): LogoResult {
  for (const [key, value] of entries) {
    if (!/(^|:)logo$/i.test(key)) continue;
    if (typeof value !== "object" || value === null) continue;
    const text = (value as { Text?: unknown }).Text;
    if (typeof text !== "string") continue;
    const trimmed = text.trim();
    if (isSafeImageSource(trimmed)) return trimmed;
  }
  return null;
}

/**
 * Only inline images and the SNS aggregator are allowed as an icon source.
 *
 * A ledger's metadata is third-party text: an arbitrary URL there would let a
 * token author point the browser at a host of their choosing on every render,
 * and `data:image/svg+xml` can carry script if it is ever rendered as a
 * document rather than an `img`.
 */
export function isSafeImageSource(value: string): boolean {
  if (value.startsWith(`${SNS_AGGREGATOR}/`)) return true;
  if (!/^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,/i.test(value)) {
    return false;
  }
  return /^[A-Za-z0-9+/=]+$/.test(value.slice(value.indexOf(",") + 1));
}

// ----------------------------------------------------------------- resolve

/**
 * Resolve one token's icon, preferring the ledger's own declaration and falling
 * back to its SNS. Repeated calls for the same token share one request and hit
 * the cache thereafter.
 */
export function resolveLogo(ledgerId: string): Promise<LogoResult> {
  const builtin = BUILTIN_LOGOS[ledgerId];
  if (builtin !== undefined) return Promise.resolve(builtin);

  const remembered = memory.get(ledgerId);
  if (remembered !== undefined) return Promise.resolve(remembered);

  const stored = cachedLogo(ledgerId);
  if (stored !== undefined) {
    memory.set(ledgerId, stored);
    return Promise.resolve(stored);
  }

  const existing = inFlight.get(ledgerId);
  if (existing) return existing;

  const task = gated(async (): Promise<LogoResult> => {
    let resolved: LogoResult = null;
    try {
      resolved = await fetchLedgerLogo(ledgerId);
    } catch {
      // A ledger that does not implement ICRC-1 metadata is ordinary here.
    }
    if (!resolved) {
      try {
        const index = await loadSnsIndex();
        const root = index[ledgerId];
        if (root) resolved = snsLogoUrl(root);
      } catch {
        // No SNS index available; the caller draws a monogram.
      }
    }
    memory.set(ledgerId, resolved);
    cacheLogo(ledgerId, resolved);
    announce();
    return resolved;
  }).finally(() => {
    inFlight.delete(ledgerId);
  });

  inFlight.set(ledgerId, task);
  return task;
}

/** The icon shipped with the app for a ledger, if there is one. */
export function builtinLogo(ledgerId: string): string | null {
  return BUILTIN_LOGOS[ledgerId] ?? null;
}

/** Drop every cached icon. Exported for tests and manual recovery. */
export function clearLogoCache(): void {
  memory.clear();
  inFlight.clear();
  snsIndexPromise = null;
  agentPromise = null;
  const index = readIndex();
  for (const key of index.keys) removeStore(key);
  removeStore(CACHE_INDEX_KEY);
  removeStore(SNS_INDEX_KEY);
}
