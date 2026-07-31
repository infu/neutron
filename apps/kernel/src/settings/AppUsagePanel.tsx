import {
  formatExactNat,
  formatInstructions,
  formatTrillionCycles,
} from "./format.ts";
import type { AppUsage } from "./model.ts";

export function AppUsagePanel({
  appId,
  usage,
}: {
  appId: string;
  usage: AppUsage | null;
}) {
  return (
    <section
      aria-labelledby={`app-usage-${appId}`}
      className="settings-app-usage"
      data-tid={`settings-app-usage-${appId}`}
    >
      <header className="settings-app-usage-heading">
        <div>
          <h3 id={`app-usage-${appId}`}>Usage details</h3>
          <p>Raw 30-day and installation totals</p>
        </div>
      </header>

      <div className="settings-app-usage-totals">
        <UsageTotal
          executions={usage?.windowExecutions ?? 0n}
          instructions={usage?.windowInstructions ?? 0n}
          incomingCyclesAccepted={
            usage?.windowIncomingCyclesAccepted ?? 0n
          }
          label="30 days"
          outgoingCycles={usage?.windowOutgoingCycles ?? 0n}
        />
        <UsageTotal
          executions={usage?.lifetimeExecutions ?? 0n}
          instructions={usage?.lifetimeInstructions ?? 0n}
          incomingCyclesAccepted={
            usage?.lifetimeIncomingCyclesAccepted ?? 0n
          }
          label="Installation"
          outgoingCycles={usage?.lifetimeOutgoingCycles ?? 0n}
        />
      </div>

      {usage === null ? (
        <p className="settings-app-usage-empty">
          No measured app activity in this installation yet.
        </p>
      ) : null}
      <p className="settings-app-usage-note">
        The estimate uses 13-node pricing: one cycle per instruction, a
        5,000,000-cycle base per measured update execution (including scheduled
        work), a 1,200,000-cycle ingress-reception base for authorized updates,
        and a 260,000-cycle base per brokered call or measured timer/handler
        self-call. Queries, variable message-byte charges, nested canister
        execution, response-callback bases, and shared global-timer dispatch are
        excluded. Message/call totals also include net explicit transfers after
        refunds. Accepted incoming cycles are shown separately as revenue
        attributed to this app and do not reduce the cost estimate.
      </p>
    </section>
  );
}

function UsageTotal({
  executions,
  incomingCyclesAccepted,
  instructions,
  label,
  outgoingCycles,
}: {
  executions: bigint;
  incomingCyclesAccepted: bigint;
  instructions: bigint;
  label: string;
  outgoingCycles: bigint;
}) {
  return (
    <div>
      <span>{label}</span>
      <strong
        aria-label={`${formatExactNat(instructions)} instructions`}
        title={`${formatExactNat(instructions)} instructions`}
      >
        {formatInstructions(instructions)} instructions
      </strong>
      <strong
        aria-label={`${formatTrillionCycles(outgoingCycles)} message, transfer, and call-base cycles`}
        title={`${formatTrillionCycles(outgoingCycles)} message, transfer, and call-base cycles`}
      >
        {formatTrillionCycles(outgoingCycles)}
      </strong>
      <small>{formatExactNat(executions)} executions</small>
      <small
        aria-label={`${formatTrillionCycles(incomingCyclesAccepted)} accepted incoming cycles`}
        title={`${formatTrillionCycles(incomingCyclesAccepted)} accepted incoming cycles`}
      >
        {formatTrillionCycles(incomingCyclesAccepted)} accepted incoming
      </small>
    </div>
  );
}
