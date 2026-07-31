import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { KernelTrayMetrics } from "../src/workspace/KernelTrayMetrics.tsx";

const snapshot = {
  snapshot_version: 1n,
  cycles_balance: 3_000_000_000_000n,
  rts_version: "test",
  wasm_memory_bytes: 8_192n,
  heap_size_bytes: 1_536n,
  total_allocation_bytes: 4_096n,
  reclaimed_bytes: 2_560n,
  max_live_size_bytes: 1_280n,
  stable_memory_bytes: 2_304n,
  logical_stable_memory_bytes: 512n,
};

const memory = {
  snapshot_version: 1n,
  wasm_memory_bytes: 6_144n,
  stable_memory_bytes: 2_304n,
  wasm_memory_limit_bytes: 8_192n,
  stable_memory_limit_bytes: 65_536n,
};

test("Kernel tray scales heap-labelled Memory against the canister memory limit", () => {
  const html = renderToStaticMarkup(
    <KernelTrayMetrics memory={memory} snapshot={snapshot} />,
  );
  const metric = metricMarkup(html, "kernel-tray-memory");
  expect(metric).toContain(
    'title="1,536 bytes used of 8,192 bytes"',
  );
  expect(metric).toContain("<dt>Memory</dt>");
  expect(metric).toContain("<span>1.5 KiB</span><strong>19%</strong>");
  expect(metric).toContain('role="progressbar"');
  expect(metric).toContain('aria-valuenow="18.75"');
  expect(metric).toContain('aria-valuetext="19% of the 8 KiB limit"');
  expect(html).toContain("of 8 KiB limit");
  expect(html).not.toContain("6 KiB");
  expect(html).not.toContain("Stable memory");
  expect(html).not.toContain("Logical stable memory");
  expect(html).not.toContain("kernel-tray-stable-memory");
  expect(html).not.toContain("kernel-tray-logical-stable-memory");
});

test("Kernel tray clamps an over-limit heap scale", () => {
  const html = renderToStaticMarkup(
    <KernelTrayMetrics
      memory={{ ...memory, wasm_memory_limit_bytes: 1_024n }}
      snapshot={snapshot}
    />,
  );
  expect(metricMarkup(html, "kernel-tray-memory")).toContain(
    'aria-valuenow="100"',
  );
});

function metricMarkup(html: string, testId: string): string {
  const match = html.match(
    new RegExp(`<div[^>]*data-tid="${testId}"[^>]*>.*?</div>`),
  );
  if (!match) throw new Error(`Missing ${testId} metric`);
  return match[0];
}
