import { expect, test } from "bun:test";
import { indexedWithdrawalMintCandidates } from "../src/funding_index.ts";

const owner = `0x${"12".repeat(20)}`, other = `0x${"34".repeat(20)}`, zero = `0x${"0".repeat(40)}`;
const ethereumUsdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const arbitrumUsdc = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const hash = (byte: string) => `0x${byte.repeat(64)}`;
const input = { chainId: "1" as const, recipient: owner, amountAtoms: "10000000", fromBlock: "100" };
const row = (changes: Record<string, unknown> = {}) => ({
  block_number: 120, log_index: 3, token: { address_hash: ethereumUsdc }, from: { hash: zero }, to: { hash: owner },
  total: { value: "8800000" }, transaction_hash: hash("a"), ...changes,
});
function pages(responses: unknown[]) {
  const calls: { url: URL; init: RequestInit | undefined }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(url)), init });
    if (!responses.length) throw new Error("Unexpected additional index page.");
    return Response.json(responses.shift());
  }) as typeof fetch;
  return { calls, fetcher };
}
async function collect(fetcher: typeof fetch, override = input, signal?: AbortSignal) {
  const result: string[][] = [];
  for await (const page of indexedWithdrawalMintCandidates(override, fetcher, signal)) result.push(page);
  return result;
}

test("index discovery pages native USDC mints and preserves fixed filters without trusting cursor URLs", async () => {
  const fixture = pages([
    { items: [row(), row()], next_page_params: { block_number: 120, index: 3, url: "https://attacker.invalid", token: other, filter: "from" } },
    { items: [row(), row({ block_number: 119, transaction_hash: hash("b") })], next_page_params: null },
  ]);
  expect(await collect(fixture.fetcher)).toEqual([[hash("a")], [hash("b")]]);
  expect(fixture.calls).toHaveLength(2);
  for (const { url, init } of fixture.calls) {
    expect(url.origin).toBe("https://eth.blockscout.com");
    expect(url.pathname).toBe(`/api/v2/addresses/${owner}/token-transfers`);
    expect(url.searchParams.get("type")).toBe("ERC-20");
    expect(url.searchParams.get("filter")).toBe("to");
    expect(url.searchParams.get("token")).toBe(ethereumUsdc);
    expect(url.searchParams.has("url")).toBe(false);
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  }
  expect(fixture.calls[1]!.url.searchParams.get("block_number")).toBe("120");
  expect(fixture.calls[1]!.url.searchParams.get("index")).toBe("3");
});

test("only exact native-token mint recipient and positive bounded integer amounts become receipt hints", async () => {
  const invalid = [
    row({ token: { address_hash: other } }), row({ from: { hash: other } }), row({ to: { hash: other } }),
    row({ total: { value: "0" } }), row({ total: { value: "10000001" } }), row({ total: { value: "-1" } }),
    row({ total: { value: "8800000.5" } }), row({ total: { value: 9007199254740992 } }),
    row({ transaction_hash: "0x1234" }), row({ block_number: null }), row({ block_number: "120.5" }),
    row({ token: null }), row({ from: null }), row({ to: null }), row({ total: null }), null,
  ];
  const fixture = pages([{ items: [...invalid, row({ to: { hash: owner.toUpperCase().replace("0X", "0x") }, token: { address_hash: ethereumUsdc.toUpperCase().replace("0X", "0x") }, transaction_hash: hash("A") })], next_page_params: null }]);
  expect(await collect(fixture.fetcher)).toEqual([[hash("a")]]);
});

test("large atomic amounts remain exact integers and cannot be rounded into the allowed budget", async () => {
  const budget = "123456789012345678901234567890";
  const fixture = pages([{ items: [row({ total: { value: budget } }), row({ transaction_hash: hash("b"), total: { value: "123456789012345678901234567891" } })], next_page_params: null }]);
  expect(await collect(fixture.fetcher, { ...input, amountAtoms: budget })).toEqual([[hash("a")]]);
});

test("Arbitrum uses its fixed public index and native USDC instead of bridged USDC.e", async () => {
  const fixture = pages([{ items: [row({ token: { address_hash: "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8" } }), row({ token: { address_hash: arbitrumUsdc }, transaction_hash: hash("b") })], next_page_params: null }]);
  const result: string[][] = [];
  for await (const page of indexedWithdrawalMintCandidates({ ...input, chainId: "42161" }, fixture.fetcher)) result.push(page);
  expect(result).toEqual([[hash("b")]]);
  expect(fixture.calls[0]!.url.origin).toBe("https://arbitrum.blockscout.com");
  expect(fixture.calls[0]!.url.searchParams.get("token")).toBe(arbitrumUsdc);
});

test("saved lower block bound is inclusive and an older row ends descending history pagination", async () => {
  const fixture = pages([{ items: [row({ block_number: 100 }), row({ block_number: 99, transaction_hash: hash("b") })], next_page_params: { block_number: 99, index: 2 } }]);
  expect(await collect(fixture.fetcher, { ...input, fromBlock: "0x64" })).toEqual([[hash("a")]]);
  expect(fixture.calls).toHaveLength(1);
});

test("cursor below saved block ends pagination without an unnecessary request", async () => {
  const fixture = pages([{ items: [], next_page_params: { block_number: "99", index: "4" } }]);
  expect(await collect(fixture.fetcher)).toEqual([[]]);
  expect(fixture.calls).toHaveLength(1);
});

test("cursor may progress through different transfer indexes within the same block", async () => {
  const fixture = pages([
    { items: [], next_page_params: { block_number: 110, index: 5 } },
    { items: [], next_page_params: { block_number: "110", index: "4" } },
    { items: [row({ block_number: 110 })], next_page_params: null },
  ]);
  expect(await collect(fixture.fetcher)).toEqual([[], [], [hash("a")]]);
  expect(fixture.calls).toHaveLength(3);
});

test("malformed cursors and pages fail explicitly instead of inventing complete history", async () => {
  for (const next_page_params of [undefined, {}, [], "https://attacker.invalid", { block_number: -1, index: 0 }, { block_number: 110, index: 1.5 }, { block_number: 110, index: "4&token=bad" }, { block_number: 9007199254740992, index: 0 }]) {
    await expect(collect(pages([{ items: [], next_page_params }]).fetcher)).rejects.toThrow("pagination cursor");
  }
  for (const page of [null, [], { next_page_params: null }, { items: null, next_page_params: null }]) {
    await expect(collect(pages([page]).fetcher)).rejects.toThrow("index page");
  }
});

test("repeated or backwards cursors reject without an infinite history loop", async () => {
  for (const next of [{ block_number: 110, index: 5 }, { block_number: 110, index: 6 }, { block_number: 111, index: 0 }]) {
    const fixture = pages([{ items: [], next_page_params: { block_number: 110, index: 5 } }, { items: [], next_page_params: next }]);
    await expect(collect(fixture.fetcher)).rejects.toThrow("did not advance");
    expect(fixture.calls).toHaveLength(2);
  }
});

test("invalid search identity rejects before fetching", async () => {
  for (const changes of [{ recipient: `${owner}/../../other` }, { amountAtoms: "0" }, { amountAtoms: "1.5" }, { fromBlock: "-1" }, { chainId: "10" }, { chainId: "toString" }]) {
    const fixture = pages([]);
    await expect(collect(fixture.fetcher, { ...input, ...changes } as typeof input)).rejects.toThrow("search identity");
    expect(fixture.calls).toHaveLength(0);
  }
});

test("index HTTP and network failures do not become a no-mint result", async () => {
  await expect(collect((async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch)).rejects.toThrow("HTTP 503");
  await expect(collect((async () => { throw new Error("Network unavailable"); }) as unknown as typeof fetch)).rejects.toThrow("Network unavailable");
});

test("abort stops a pending fetch and prevents additional pages after a yielded candidate", async () => {
  const pending = new AbortController();
  let started!: () => void;
  const start = new Promise<void>(resolve => { started = resolve; });
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    started();
    return await new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }));
  }) as typeof fetch;
  const reading = collect(fetcher, input, pending.signal);
  await start;
  pending.abort(new Error("Owner stopped reconciliation"));
  await expect(reading).rejects.toThrow("Owner stopped reconciliation");

  const later = new AbortController(), fixture = pages([{ items: [row()], next_page_params: { block_number: 110, index: 4 } }]);
  const iterator = indexedWithdrawalMintCandidates(input, fixture.fetcher, later.signal);
  expect((await iterator.next()).value).toEqual([hash("a")]);
  later.abort(new Error("Do not fetch another page"));
  await expect(iterator.next()).rejects.toThrow("Do not fetch another page");
  expect(fixture.calls).toHaveLength(1);

  const before = pages([]);
  await expect(collect(before.fetcher, input, later.signal)).rejects.toThrow("Do not fetch another page");
  expect(before.calls).toHaveLength(0);
});
