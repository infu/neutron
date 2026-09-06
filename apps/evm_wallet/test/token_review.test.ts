import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseTokenEvidence, type TokenEvidence } from "../src/data.ts";
import { TokenReview } from "../src/token_review.tsx";

const owner = `0x${"11".repeat(20)}`;
const contract = `0x${"22".repeat(20)}`;
const spender = `0x${"33".repeat(20)}`;
const uint256 = ((1n << 256n) - 1n).toString();
function wire(patch: Record<string, unknown> = {}) {
  return {
    chain_id: "1", contract, method: "approve", owner, spender,
    amount: uint256, recognition: "erc20_calldata",
    block_number: "0x20000000000001", block_hash: `0x${"44".repeat(32)}`,
    observed_at: "1700000000000000000",
    balance: { value: "9007199254740993" },
    allowance: { value: "9007199254740992" },
    ...patch,
  };
}
const render = (evidence: TokenEvidence | null) => renderToStaticMarkup(
  createElement(TokenReview, { evidence, busy: false, onRefresh() {} }),
);

test("ERC20 review preserves exact large balances, allowance change and observed block", () => {
  const evidence = parseTokenEvidence(wire())!;
  expect(evidence.blockNumber).toBe("9007199254740993");
  expect(evidence.balance.value).toBe("9007199254740993");
  const markup = render(evidence);
  expect(markup).toContain("9007199254740993 atomic units");
  expect(markup).toContain(`${uint256} atomic units`);
  expect(markup).toContain(`Increase by ${BigInt(uint256) - 9007199254740992n} atomic units`);
  expect(markup).toContain(spender);
  expect(markup).toContain("Saved observations from the block and time shown above");
  expect(markup).toContain("may have changed since then");
  expect(markup).toContain("contract implementation and token identity are not authenticated");
});

test("revocation and unchanged approval compare against the observed allowance exactly", () => {
  expect(render(parseTokenEvidence(wire({ amount: "0", allowance: { value: "17" } })))).toContain("Decrease by 17 atomic units");
  expect(render(parseTokenEvidence(wire({ amount: "17", allowance: { value: "17" } })))).toContain("No change from the observed allowance");
});

test("failed reads and missing old-release observations are not shown as zero or fresh evidence", () => {
  const evidence = parseTokenEvidence(wire({
    block_number: undefined, block_hash: undefined, block_error: "Head lookup unavailable",
    balance: { error: "Balance RPC unavailable" }, allowance: { error: "Allowance RPC unavailable" },
  }))!;
  expect(evidence.blockNumber).toBeNull();
  expect(evidence.balance.value).toBeNull();
  const markup = render(evidence);
  expect(markup).toContain("Unavailable: Balance RPC unavailable");
  expect(markup).toContain("Unavailable: Allowance RPC unavailable");
  expect(markup).toContain("Unavailable until the allowance read succeeds");
  expect(markup).toContain("Head lookup unavailable");
  expect(markup).not.toContain("Increase by");
  expect(parseTokenEvidence(undefined)).toBeNull();
  expect(render(null)).toContain("This saved review has no token observations");
});

test("transfer evidence omits inapplicable allowance and malformed observations cannot pretend to be balance readings", () => {
  const evidence = parseTokenEvidence(wire({ method: "transfer", allowance: undefined, spender: undefined, recipient: owner }))!;
  const markup = render(evidence);
  expect(markup).not.toContain("Observed allowance");
  expect(markup).not.toContain("Requested allowance");
  expect(() => parseTokenEvidence(wire({ balance: {} }))).toThrow("value or an error");
  expect(() => parseTokenEvidence(wire({ balance: { value: "0", error: "failed" } }))).toThrow("value or an error");
});
