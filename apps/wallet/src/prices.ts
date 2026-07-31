export const PRICE_ASSETS = [
  "BTC",
  "DOGE",
  "ETH",
  "ICP",
  "SOL",
  "USDC",
  "USDT",
] as const;

export type PriceAsset = (typeof PRICE_ASSETS)[number];
export type PriceSource = "coinbase" | "coingecko" | "kraken";

export type UsdQuote = {
  source: PriceSource;
  usd: bigint;
};

export type UsdPriceBook = {
  providers: PriceSource[];
  quotes: Partial<Record<PriceAsset, UsdQuote>>;
  updatedAt: number;
};

export type PriceFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

type PriceStorage = Pick<Storage, "getItem" | "setItem">;

export const USD_PRICE_SCALE = 100_000_000n;
export const USD_PRICE_CACHE_KEY = "neutron.wallet.usd-prices.v1";
export const USD_PRICE_REFRESH_MS = 60_000;
export const USD_PRICE_FRESH_MS = 55_000;

const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1_000;
const MAX_RESPONSE_BYTES = 256 * 1_024;
const MAX_USD_PRICE = 1_000_000_000_000n * USD_PRICE_SCALE;
const PROVIDER_TIMEOUT_MS = 6_000;
const RATE_SCALE_DIGITS = 18;
const RATE_SCALE = 10n ** BigInt(RATE_SCALE_DIGITS);

const COINGECKO_IDS: Record<PriceAsset, string> = {
  BTC: "bitcoin",
  DOGE: "dogecoin",
  ETH: "ethereum",
  ICP: "internet-computer",
  SOL: "solana",
  USDC: "usd-coin",
  USDT: "tether",
};

const KRAKEN_PAIRS: Record<PriceAsset, string> = {
  BTC: "XBTUSD",
  DOGE: "DOGEUSD",
  ETH: "ETHUSD",
  ICP: "ICPUSD",
  SOL: "SOLUSD",
  USDC: "USDCUSD",
  USDT: "USDTUSD",
};

const KRAKEN_RESULT_KEYS: Record<PriceAsset, string> = {
  BTC: "XXBTZUSD",
  DOGE: "XDGUSD",
  ETH: "XETHZUSD",
  ICP: "ICPUSD",
  SOL: "SOLUSD",
  USDC: "USDCUSD",
  USDT: "USDTZUSD",
};

const PRICE_ASSET_SET = new Set<string>(PRICE_ASSETS);
const PRICE_SOURCE_SET = new Set<string>([
  "coinbase",
  "coingecko",
  "kraken",
]);

export async function fetchUsdPriceBook(
  assets: PriceAsset[],
  options: {
    fetcher?: PriceFetch;
    now?: () => number;
  } = {},
): Promise<UsdPriceBook> {
  const requested = normalizeAssets(assets);
  const fetcher: PriceFetch =
    options.fetcher ??
    ((input, init) => globalThis.fetch(input, init));
  const quotes: Partial<Record<PriceAsset, UsdQuote>> = {};
  const providers: PriceSource[] = [];
  const failures: string[] = [];

  const sources: Array<{
    id: PriceSource;
    load: (
      requestedAssets: PriceAsset[],
      request: PriceFetch,
    ) => Promise<Partial<Record<PriceAsset, bigint>>>;
  }> = [
    { id: "coingecko", load: fetchCoinGecko },
    { id: "kraken", load: fetchKraken },
    { id: "coinbase", load: fetchCoinbase },
  ];

  for (const source of sources) {
    const missing = requested.filter((asset) => quotes[asset] === undefined);
    if (missing.length === 0) break;
    try {
      const result = await source.load(missing, fetcher);
      let used = false;
      for (const asset of missing) {
        const usd = result[asset];
        if (usd === undefined || !validPrice(usd)) continue;
        quotes[asset] = { source: source.id, usd };
        used = true;
      }
      if (used) providers.push(source.id);
    } catch (reason) {
      failures.push(`${source.id}: ${errorMessage(reason)}`);
    }
  }

  if (requested.length > 0 && requested.every((asset) => !quotes[asset])) {
    const detail = failures.length > 0 ? ` (${failures.join("; ")})` : "";
    throw new Error(`USD price providers are unavailable${detail}`);
  }

  return {
    providers,
    quotes,
    updatedAt: (options.now ?? Date.now)(),
  };
}

export function isPriceAsset(value: unknown): value is PriceAsset {
  return typeof value === "string" && PRICE_ASSET_SET.has(value);
}

export function optionalBrowserStorage(source: {
  readonly localStorage: Storage;
}): Storage | null {
  try {
    return source.localStorage;
  } catch {
    return null;
  }
}

export function hasUsdPrices(
  book: UsdPriceBook,
  assets: PriceAsset[],
): boolean {
  return normalizeAssets(assets).every((asset) => book.quotes[asset]);
}

export function positionUsdValue(
  balance: string | null,
  decimals: number | null,
  quote: UsdQuote | null,
): bigint | null {
  if (
    balance === null ||
    !/^\d+$/.test(balance) ||
    decimals === null ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255 ||
    quote === null ||
    !validPrice(quote.usd)
  ) {
    return null;
  }
  const units = BigInt(balance);
  const denominator = 10n ** BigInt(decimals);
  return (units * quote.usd + denominator / 2n) / denominator;
}

export function formatUsd(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  if (absolute > 0n && absolute < USD_PRICE_SCALE / 100n) {
    return negative ? "-$0.01" : "<$0.01";
  }
  const cents = (absolute * 100n + USD_PRICE_SCALE / 2n) / USD_PRICE_SCALE;
  const dollars = cents / 100n;
  const fraction = (cents % 100n).toString().padStart(2, "0");
  const grouped = groupThousands(dollars.toString());
  return `${negative ? "-" : ""}$${grouped}.${fraction}`;
}

export function priceSourceLabel(source: PriceSource): string {
  switch (source) {
    case "coinbase":
      return "Coinbase";
    case "coingecko":
      return "CoinGecko";
    case "kraken":
      return "Kraken";
  }
}

export function readUsdPriceCache(
  storage: Pick<PriceStorage, "getItem">,
  now = Date.now(),
): UsdPriceBook | null {
  try {
    const value = storage.getItem(USD_PRICE_CACHE_KEY);
    return value ? parseUsdPriceCache(value, now) : null;
  } catch {
    return null;
  }
}

export function writeUsdPriceCache(
  storage: Pick<PriceStorage, "setItem">,
  book: UsdPriceBook,
): void {
  const quotes: Record<string, { source: PriceSource; usd: string }> = {};
  for (const asset of PRICE_ASSETS) {
    const quote = book.quotes[asset];
    if (quote && validPrice(quote.usd)) {
      quotes[asset] = { source: quote.source, usd: quote.usd.toString() };
    }
  }
  storage.setItem(
    USD_PRICE_CACHE_KEY,
    JSON.stringify({ version: 1, updatedAt: book.updatedAt, quotes }),
  );
}

export function parseUsdPriceCache(
  value: string,
  now = Date.now(),
): UsdPriceBook | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || parsed.version !== 1) return null;
    if (
      typeof parsed.updatedAt !== "number" ||
      !Number.isSafeInteger(parsed.updatedAt) ||
      parsed.updatedAt <= 0 ||
      parsed.updatedAt > now + FUTURE_TOLERANCE_MS ||
      now - parsed.updatedAt > CACHE_MAX_AGE_MS ||
      !isRecord(parsed.quotes)
    ) {
      return null;
    }
    const quotes: Partial<Record<PriceAsset, UsdQuote>> = {};
    const providers = new Set<PriceSource>();
    for (const asset of PRICE_ASSETS) {
      const candidate = parsed.quotes[asset];
      if (!isRecord(candidate)) continue;
      if (
        !PRICE_SOURCE_SET.has(String(candidate.source)) ||
        typeof candidate.usd !== "string" ||
        !/^\d+$/.test(candidate.usd)
      ) {
        continue;
      }
      const usd = BigInt(candidate.usd);
      if (!validPrice(usd)) continue;
      const source = candidate.source as PriceSource;
      quotes[asset] = { source, usd };
      providers.add(source);
    }
    if (Object.keys(quotes).length === 0) return null;
    return {
      providers: [...providers],
      quotes,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

async function fetchCoinGecko(
  assets: PriceAsset[],
  fetcher: PriceFetch,
): Promise<Partial<Record<PriceAsset, bigint>>> {
  const params = new URLSearchParams({
    ids: assets.map((asset) => COINGECKO_IDS[asset]).join(","),
    vs_currencies: "usd",
  });
  const payload = await requestJson(
    fetcher,
    `https://api.coingecko.com/api/v3/simple/price?${params}`,
  );
  if (!isRecord(payload)) throw new Error("invalid response");
  const prices: Partial<Record<PriceAsset, bigint>> = {};
  for (const asset of assets) {
    const entry = payload[COINGECKO_IDS[asset]];
    if (!isRecord(entry)) continue;
    const price = decimalToScaled(entry.usd, 8);
    if (price !== null && validPrice(price)) prices[asset] = price;
  }
  return prices;
}

async function fetchKraken(
  assets: PriceAsset[],
  fetcher: PriceFetch,
): Promise<Partial<Record<PriceAsset, bigint>>> {
  const params = new URLSearchParams({
    pair: assets.map((asset) => KRAKEN_PAIRS[asset]).join(","),
  });
  const payload = await requestJson(
    fetcher,
    `https://api.kraken.com/0/public/Ticker?${params}`,
  );
  if (
    !isRecord(payload) ||
    !Array.isArray(payload.error) ||
    payload.error.some((error) => typeof error !== "string") ||
    payload.error.length > 0 ||
    !isRecord(payload.result)
  ) {
    throw new Error("invalid response");
  }
  const prices: Partial<Record<PriceAsset, bigint>> = {};
  for (const asset of assets) {
    const ticker = payload.result[KRAKEN_RESULT_KEYS[asset]];
    if (!isRecord(ticker) || !Array.isArray(ticker.c)) continue;
    const price = decimalToScaled(ticker.c[0], 8);
    if (price !== null && validPrice(price)) prices[asset] = price;
  }
  return prices;
}

async function fetchCoinbase(
  assets: PriceAsset[],
  fetcher: PriceFetch,
): Promise<Partial<Record<PriceAsset, bigint>>> {
  const payload = await requestJson(
    fetcher,
    "https://api.coinbase.com/v2/exchange-rates?currency=USD",
  );
  if (
    !isRecord(payload) ||
    !isRecord(payload.data) ||
    payload.data.currency !== "USD" ||
    !isRecord(payload.data.rates)
  ) {
    throw new Error("invalid response");
  }
  const prices: Partial<Record<PriceAsset, bigint>> = {};
  for (const asset of assets) {
    const rate = decimalToScaled(payload.data.rates[asset], RATE_SCALE_DIGITS);
    if (rate === null || rate <= 0n) continue;
    const price = (USD_PRICE_SCALE * RATE_SCALE + rate / 2n) / rate;
    if (validPrice(price)) prices[asset] = price;
  }
  return prices;
}

async function requestJson(fetcher: PriceFetch, url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(
    () => controller.abort(),
    PROVIDER_TIMEOUT_MS,
  );
  try {
    const response = await fetcher(url, {
      cache: "no-store",
      credentials: "omit",
      headers: { accept: "application/json" },
      method: "GET",
      mode: "cors",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (text.length === 0 || text.length > MAX_RESPONSE_BYTES) {
      throw new Error("invalid response size");
    }
    return JSON.parse(text) as unknown;
  } finally {
    globalThis.clearTimeout(timer);
  }
}

function decimalToScaled(value: unknown, scaleDigits: number): bigint | null {
  const text =
    typeof value === "string"
      ? value.trim()
      : typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : "";
  if (text.length === 0 || text.length > 80) return null;
  const match = /^\+?(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) return null;
  const whole = match[1] ?? "";
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? "0");
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 100) return null;
  const coefficient = BigInt(`${whole}${fraction}` || "0");
  const shift = scaleDigits + exponent - fraction.length;
  if (shift >= 0) return coefficient * 10n ** BigInt(shift);
  const divisor = 10n ** BigInt(-shift);
  const quotient = coefficient / divisor;
  const remainder = coefficient % divisor;
  return remainder * 2n >= divisor ? quotient + 1n : quotient;
}

function normalizeAssets(assets: PriceAsset[]): PriceAsset[] {
  const requested = new Set<PriceAsset>();
  for (const asset of assets) {
    if (isPriceAsset(asset)) requested.add(asset);
  }
  return PRICE_ASSETS.filter((asset) => requested.has(asset));
}

function validPrice(value: bigint): boolean {
  return value > 0n && value <= MAX_USD_PRICE;
}

function groupThousands(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
