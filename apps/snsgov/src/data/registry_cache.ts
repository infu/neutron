/**
 * The registry, kept across tile reloads.
 *
 * Building it takes roughly twenty seconds: SNS-W lists ~54 SNSes, then each
 * one is probed for liveness and asked for its metadata and token. That is
 * fine once; paying it again every time the tile is opened is not, and it is
 * the reason the app used to sit on a spinner at startup.
 *
 * So the last good result is written to `localStorage` and served immediately
 * on the next open, while a fresh build runs behind it — stale-while-revalidate.
 * The stored copy is a plain projection, not the live object: `byRoot` is a
 * `Map` and every amount is a `bigint`, neither of which survives JSON.
 *
 * Storage is best-effort throughout. A private window, a full quota, or a
 * browser configured to block site data all throw on access, and none of them
 * is a reason to fail: the app simply builds the registry the slow way.
 */

import type { Registry, RegistryEntry } from "./registry";

const KEY = "snsgov.registry.v1";
/** Older than this and the cached copy is not worth showing at all. */
// Names, symbols and canister ids never change, and an SNS winding down is a
// once-a-year event, so a month-old list is still a good thing to paint while
// the real one loads behind it. A single day meant anyone who opened the app
// less often than daily paid the twenty-second build every time.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface StoredRegistry {
  version: 1;
  fetchedAt: number;
  entries: unknown[];
}

/** `bigint` has no JSON representation; tag it so it can be restored exactly. */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? { $bigint: value.toString() } : value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && "$bigint" in (value as Record<string, unknown>)) {
    const raw = (value as { $bigint: unknown }).$bigint;
    if (typeof raw === "string") return BigInt(raw);
  }
  return value;
}

/** The last good registry, if one was stored recently enough to be useful. */
export function readCachedRegistry(): Registry | undefined {
  let raw: string | null;
  try {
    raw = globalThis.localStorage?.getItem(KEY) ?? null;
  } catch {
    return undefined;
  }
  if (!raw) return undefined;

  try {
    const stored = JSON.parse(raw, reviver) as StoredRegistry;
    if (stored.version !== 1) return undefined;
    if (!Array.isArray(stored.entries) || stored.entries.length === 0) return undefined;
    if (!Number.isFinite(stored.fetchedAt)) return undefined;
    if (Date.now() - stored.fetchedAt > MAX_AGE_MS) return undefined;

    const entries = stored.entries as RegistryEntry[];
    // A stored row whose shape has drifted would break the whole list, so the
    // one field everything is keyed on is checked before any of it is used.
    if (!entries.every((entry) => typeof entry?.canisters?.root === "string")) return undefined;

    return {
      entries,
      byRoot: new Map(entries.map((entry) => [entry.canisters.root, entry])),
      fetchedAt: stored.fetchedAt,
      livenessKnown: true,
    };
  } catch {
    // Corrupt or from an incompatible build. Drop it rather than keep failing.
    try {
      globalThis.localStorage?.removeItem(KEY);
    } catch {
      // Nothing more to do; the fresh build below is the fallback.
    }
    return undefined;
  }
}

/**
 * How much of the origin's storage this app is willing to take.
 *
 * `localStorage` is shared with every other app on the Neutron origin and the
 * whole origin typically gets 5-10 MB, so a cache is not entitled to help
 * itself. The full registry with logos measures ~3 MB — 54 DAOs at ~55 KB each,
 * almost all of it base64 PNG — which is far too much to hold for a list.
 */
const BUDGET_BYTES = 600_000;

/** A single logo bigger than this is never worth a tenth of the whole budget. */
const MAX_CACHED_LOGO_BYTES = 24_000;

function logoBytes(entries: RegistryEntry[]): number {
  return entries.reduce((sum, entry) => sum + (entry.metadata?.logo?.length ?? 0), 0);
}

export function writeCachedRegistry(registry: Registry): void {
  // A provisional list has placeholder liveness; storing it would show sixteen
  // wound-down DAOs as active on the next open, with nothing to correct it.
  if (registry.livenessKnown === false) return;
  const stored: StoredRegistry = {
    version: 1,
    fetchedAt: registry.fetchedAt,
    entries: registry.entries,
  };

  let payload = JSON.stringify(stored, replacer);
  if (payload.length > BUDGET_BYTES) {
    // Logos are the whole difference — everything else is 33 KB for all 54
    // DAOs. Rather than dropping them all and showing a page of initials until
    // the refresh lands, keep the ones that are cheap: most DAOs ship a logo
    // around 12 KB, a few ship 80 KB. Smallest first, until the budget is out.
    const budget = { left: BUDGET_BYTES - payload.length + logoBytes(registry.entries) };
    const keep = new Set(
      [...registry.entries]
        .filter((entry) => entry.metadata?.logo !== undefined)
        .sort((a, b) => (a.metadata!.logo!.length ?? 0) - (b.metadata!.logo!.length ?? 0))
        .filter((entry) => {
          const size = entry.metadata!.logo!.length;
          if (size > MAX_CACHED_LOGO_BYTES || size > budget.left) return false;
          budget.left -= size;
          return true;
        })
        .map((entry) => entry.canisters.root),
    );
    payload = JSON.stringify(
      {
        ...stored,
        entries: registry.entries.map((entry) =>
          keep.has(entry.canisters.root) ? entry : withoutLogo(entry),
        ),
      },
      replacer,
    );
  }

  try {
    globalThis.localStorage?.setItem(KEY, payload);
  } catch {
    // Over quota, or storage is unavailable. The app is fully functional
    // without it — the next open is just slow again.
  }
}

function withoutLogo(entry: RegistryEntry): RegistryEntry {
  if (entry.metadata?.logo === undefined) return entry;
  const { logo: _dropped, ...metadata } = entry.metadata;
  return { ...entry, metadata };
}

/** How stale a cached registry is, for the "as of" line under the list. */
export function cacheAgeMs(registry: Registry): number {
  return Date.now() - registry.fetchedAt;
}
