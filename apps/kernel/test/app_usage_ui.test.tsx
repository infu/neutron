import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppSettingsEntry, combinedAppCycles } from "../src/settings/AppSettingsEntry.tsx";
import { AppUsagePanel } from "../src/settings/AppUsagePanel.tsx";
import { formatInstructions, formatTrillionCycles } from "../src/settings/format.ts";
import { appUsageScopeKey, validateAppUsageSnapshot } from "../src/settings/model.ts";
import { registryApp } from "./app_registry_fixture.ts";

const wire = {
  snapshot_version: 2n,
  current_day: 20_000n,
  apps: [
    {
      app_id: "alpha",
      installation_uid: 7n,
      lifetime_instructions: 90_000_000_000n,
      lifetime_executions: 12n,
      lifetime_outgoing_cycles: 8_000_000_000_000n,
      lifetime_incoming_cycles_accepted: 9_000_000_000_000n,
      window_instructions: 5_000_000_003n,
      window_executions: 3n,
      window_outgoing_cycles: 7_000_000_000_003n,
      window_incoming_cycles_accepted: 2_000_000_000_003n,
      days: [
        {
          day: 19_999n,
          instructions: 3n,
          executions: 1n,
          outgoing_cycles: 3n,
          incoming_cycles_accepted: 3n,
        },
        {
          day: 20_000n,
          instructions: 5_000_000_000n,
          executions: 2n,
          outgoing_cycles: 7_000_000_000_000n,
          incoming_cycles_accepted: 2_000_000_000_000n,
        },
      ],
    },
  ],
};

test("app-usage v2 snapshots validate costs and accepted incoming cycles", () => {
  const snapshot = validateAppUsageSnapshot(wire);
  expect(snapshot.snapshotVersion).toBe(2n);
  expect(snapshot.currentDay).toBe(20_000n);
  expect(snapshot.apps[0]).toMatchObject({
    appId: "alpha",
    installationUid: 7n,
    lifetimeOutgoingCycles: 8_000_000_000_000n,
    lifetimeIncomingCyclesAccepted: 9_000_000_000_000n,
    windowInstructions: 5_000_000_003n,
    windowExecutions: 3n,
    windowOutgoingCycles: 7_000_000_000_003n,
    windowIncomingCyclesAccepted: 2_000_000_000_003n,
  });
  expect(appUsageScopeKey("alpha", 7n)).toBe(appUsageScopeKey("alpha", "7"));
  expect(appUsageScopeKey("alpha", 7n)).not.toBe(appUsageScopeKey("alpha", 8n));
  expect(formatInstructions(12_345_678_901_234_567_890n)).toBe("12.34 E");
  expect(formatTrillionCycles(12_345_678_901_234_567_890n)).toBe("12,345,678.9012TC");

  expect(() =>
    validateAppUsageSnapshot({
      ...wire,
      apps: [...wire.apps, { ...wire.apps[0]! }],
    })
  ).toThrow("Duplicate app-usage scope");
  expect(() =>
    validateAppUsageSnapshot({
      ...wire,
      apps: [{ ...wire.apps[0]!, window_outgoing_cycles: 4n }],
    })
  ).toThrow("daily window does not match");
  expect(() =>
    validateAppUsageSnapshot({
      ...wire,
      apps: [
        {
          ...wire.apps[0]!,
          window_incoming_cycles_accepted: 4n,
        },
      ],
    })
  ).toThrow("daily window does not match");
  expect(() =>
    validateAppUsageSnapshot({
      ...wire,
      apps: [
        {
          ...wire.apps[0]!,
          days: [
            {
              day: 19_970n,
              instructions: 5_000_000_003n,
              executions: 3n,
              outgoing_cycles: 7_000_000_000_003n,
              incoming_cycles_accepted: 2_000_000_000_003n,
            },
          ],
        },
      ],
    })
  ).toThrow("outside the 30-day window");
});

test("app-usage validation follows bounded saturation for instruction and cycle counters", () => {
  const maximum = 18_446_744_073_709_551_615n;
  const maximumCycles = 340_282_366_920_938_463_463_374_607_431_768_211_455n;
  const snapshot = validateAppUsageSnapshot({
    snapshot_version: 2n,
    current_day: 20_000n,
    apps: [
      {
        app_id: "alpha",
        installation_uid: 7n,
        lifetime_instructions: maximum,
        lifetime_executions: maximum,
        lifetime_outgoing_cycles: maximumCycles,
        lifetime_incoming_cycles_accepted: maximumCycles,
        window_instructions: maximum,
        window_executions: maximum,
        window_outgoing_cycles: maximumCycles,
        window_incoming_cycles_accepted: maximumCycles,
        days: [
          {
            day: 19_999n,
            instructions: maximum,
            executions: maximum,
            outgoing_cycles: maximumCycles,
            incoming_cycles_accepted: maximumCycles,
          },
          {
            day: 20_000n,
            instructions: 1n,
            executions: 1n,
            outgoing_cycles: 1n,
            incoming_cycles_accepted: 1n,
          },
        ],
      },
    ],
  });
  expect(snapshot.apps[0]?.windowInstructions).toBe(maximum);
  expect(snapshot.apps[0]?.windowOutgoingCycles).toBe(maximumCycles);
  expect(snapshot.apps[0]?.windowIncomingCyclesAccepted).toBe(maximumCycles);
  expect(() =>
    validateAppUsageSnapshot({
      ...wire,
      apps: [
        {
          ...wire.apps[0]!,
          lifetime_outgoing_cycles: maximumCycles + 1n,
        },
      ],
    })
  ).toThrow("exceeds the cycle counter bound");
});

test("Installed Apps applies low-side 13-node execution pricing with four TC decimals", () => {
  const usage = validateAppUsageSnapshot(wire).apps[0]!;
  expect(combinedAppCycles(usage)).toBe(8_090_060_000_000n);
  expect(formatTrillionCycles(combinedAppCycles(usage))).toBe("8.0901TC");
  expect(combinedAppCycles(null)).toBe(0n);

  const entry = registryApp({
    id: "alpha",
    name: "Alpha",
    description: "One-line app description",
  });
  const html = renderToStaticMarkup(
    <table>
      <AppSettingsEntry
        backendReservations={[]}
        capabilityActionsDisabled={false}
        capabilityOperation={null}
        capabilitySummaries={[]}
        dependencies={[]}
        dependents={[]}
        entry={entry}
        id="alpha"
        uiMode="normal"
        usage={{ kind: "ready", usage }}
        memories={[]}
        onRevokeReservation={() => undefined}
        onSetCapabilityEnabled={() => undefined}
        onUninstall={() => undefined}
        registry={{ alpha: entry }}
        reservationActionsDisabled={false}
        runtimeVersion={100n}
        scheduledTasks={[]}
        transitiveDependentIds={[]}
        uninstallDisabled={false}
        uninstallTitle="Uninstall Alpha"
        update={<span>Up to date</span>}
      />
    </table>
  );

  expect(html).toContain('data-tid="settings-app-alpha"');
  expect(html).toContain('scope="row"');
  expect(html).toContain("One-line app description");
  expect(html).toContain("8.0901TC");
  expect(html).toContain(
    "90,000,000,000 instructions at one cycle per instruction + 60,000,000 update execution base cycles (12 × 5,000,000) + 8,000,000,000,000 message, transfer, and call-base cycles"
  );
  expect(html).toContain('data-tid="settings-app-cycles-in"');
  expect(html).toContain("9.0000TC");
  expect(html).toContain(
    "9,000,000,000,000 cycles accepted by this installation through paid public ingress"
  );
  expect(html).toContain("Up to date");
  expect(html).toContain("v0.1.0");
  expect(html).toContain('data-tid="settings-app-details-toggle-alpha"');
  expect(html).toContain('data-tid="settings-uninstall-alpha"');
  expect(html).not.toContain("App usage");
  expect(html).not.toContain("30-day");
});

test("usage lookup accepts only the active installation scope", () => {
  const current = validateAppUsageSnapshot(wire).apps[0]!;
  const stale = { ...current, installationUid: 6n };
  const byScope = new Map([
    [appUsageScopeKey(stale.appId, stale.installationUid), stale],
    [appUsageScopeKey(current.appId, current.installationUid), current],
  ]);

  expect(byScope.get(appUsageScopeKey("alpha", 7n))).toBe(current);
  expect(byScope.get(appUsageScopeKey("alpha", 6n))).toBe(stale);
  expect(byScope.get(appUsageScopeKey("alpha", 8n))).toBeUndefined();
  expect(byScope.get(appUsageScopeKey("beta", 7n))).toBeUndefined();
});

test("expanded Installed Apps usage retains raw window and installation totals", () => {
  const usage = validateAppUsageSnapshot(wire).apps[0]!;
  const html = renderToStaticMarkup(<AppUsagePanel appId="alpha" usage={usage} />);

  expect(html).toContain('data-tid="settings-app-usage-alpha"');
  expect(html).toContain("Usage details");
  expect(html).toContain("Raw 30-day and installation totals");
  expect(html).toContain("5 B instructions");
  expect(html).toContain("7.0000TC");
  expect(html).toContain("3 executions");
  expect(html).toContain("90 B instructions");
  expect(html).toContain("8.0000TC");
  expect(html).toContain("2.0000TC accepted incoming");
  expect(html).toContain("9.0000TC accepted incoming");
  expect(html).toContain("12 executions");
});
