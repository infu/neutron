import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createRepositoryAccessApprovalLoader,
  currentRepositoryAccessApprovalSnapshot,
} from "../src/repository_access/approvals.ts";
import { RepositoryAccessCost } from "../src/repository_access/RepositoryAccessCost.tsx";
import type { RepositoryAccessApproval } from "../src/repository_access/client.ts";

const SOURCE = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const SECOND_SOURCE = "r7inp-6aaaa-aaaaa-aaabq-cai";
const NEUTRON = "ryjl3-tyaaa-aaaaa-aaaba-cai";

function approval(source = SOURCE, cycles = "123456789012345678901", fee = "7"): RepositoryAccessApproval {
  return {
    source,
    descriptor: { protocol: "neutron-repo-access-v1", fee_version: fee, cycles },
  };
}

test("simultaneous rows and bulk actions share read-only source cost discovery", async () => {
  const reads: string[] = [];
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => { finish = resolve; });
  const load = createRepositoryAccessApprovalLoader(async (source) => {
    reads.push(source);
    await wait;
    return source === SOURCE ? approval() : null;
  });
  const row = load([SOURCE], "check-1");
  const bulk = load([SOURCE, SOURCE, SECOND_SOURCE], "check-1");
  await Promise.resolve();
  expect(reads.sort()).toEqual([SOURCE, SECOND_SOURCE].sort());
  finish();
  expect(await row).toEqual([approval()]);
  expect(await bulk).toEqual([approval()]);
});

test("cost rereview reads the current fee revision and does not reuse prior consent", async () => {
  let reads = 0;
  const load = createRepositoryAccessApprovalLoader(async () => {
    reads += 1;
    return approval(SOURCE, String(reads * 100), String(reads));
  });
  const first = await load([SOURCE], "check-1");
  const refreshed = await load([SOURCE], "fee-changed");
  expect(first[0]?.descriptor).toMatchObject({ cycles: "100", fee_version: "1" });
  expect(refreshed[0]?.descriptor).toMatchObject({ cycles: "200", fee_version: "2" });
  expect(reads).toBe(2);
});

test("one source lookup failure cannot produce partial bulk consent", async () => {
  const load = createRepositoryAccessApprovalLoader(async (source) => {
    if (source === SECOND_SOURCE) throw new Error("Uncertified cost response");
    return approval(source);
  });
  await expect(load([SOURCE, SECOND_SOURCE])).rejects.toThrow("Uncertified cost response");
});

test("source or fee revision changes synchronously disable the old action", () => {
  const snapshot = { key: "old", approvals: [approval()], error: null };
  expect(currentRepositoryAccessApprovalSnapshot("new", true, snapshot)).toEqual({
    approvals: [], loading: true, error: null, ready: false,
  });
  expect(currentRepositoryAccessApprovalSnapshot("old", true, snapshot)).toEqual({
    approvals: [approval()], loading: false, error: null, ready: true,
  });
  expect(currentRepositoryAccessApprovalSnapshot("old", true, {
    key: "old", approvals: [], error: "Cost unavailable",
  })).toMatchObject({ ready: false, loading: false, error: "Cost unavailable" });
  expect(currentRepositoryAccessApprovalSnapshot("new", false, snapshot)).toEqual({
    approvals: [], loading: false, error: null, ready: true,
  });
});

test("cost disclosure retains exact integer cycles and both principals", () => {
  const html = renderToStaticMarkup(
    <RepositoryAccessCost approvals={[approval(), approval()]} neutronPrincipal={NEUTRON} />,
  );
  expect(html).toContain("123,456,789,012,345,678,901 cycles");
  expect(html).toContain(NEUTRON);
  expect(html.split(SOURCE)).toHaveLength(2);
  expect(html).toContain("once per source");
  expect(html).toContain("Network costs are additional");
  expect(html).not.toContain("<button");
});

test("public sources add no consent UI and failures only offer a read retry", () => {
  expect(renderToStaticMarkup(<RepositoryAccessCost approvals={[]} />)).toBe("");
  const html = renderToStaticMarkup(
    <RepositoryAccessCost approvals={[]} error="Source unavailable" onRetry={() => undefined} />,
  );
  expect(html).toContain("Source unavailable");
  expect(html).toContain("Retry cost lookup");
  expect(html).not.toContain("data-tid=\"repository-access-cost\"");
});
