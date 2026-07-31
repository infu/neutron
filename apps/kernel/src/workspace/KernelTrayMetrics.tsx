import {
  formatBytes,
  formatCycles,
  formatExactNat,
  type NatValue,
} from "../settings/format.ts";
import {
  formatMemoryPressure,
  summarizeHeapMemory,
} from "../settings/memory.ts";
import type {
  KernelMemorySnapshot,
  KernelSettingsSnapshot,
} from "../settings/model.ts";

export function KernelTrayMetrics({
  memory,
  snapshot,
}: {
  memory: KernelMemorySnapshot;
  snapshot: KernelSettingsSnapshot;
}) {
  return (
    <dl className="kernel-tray-metrics">
      <KernelMetric
        dataTid="kernel-tray-cycles"
        exact={`${formatExactNat(snapshot.cycles_balance)} cycles`}
        label="Cycles balance"
        value={formatCycles(snapshot.cycles_balance)}
      />
      <KernelHeapMemoryMetric
        heapBytes={snapshot.heap_size_bytes}
        limitBytes={memory.wasm_memory_limit_bytes}
      />
    </dl>
  );
}

function KernelHeapMemoryMetric({
  heapBytes,
  limitBytes,
}: {
  heapBytes: NatValue;
  limitBytes: NatValue;
}) {
  const summary = summarizeHeapMemory(heapBytes, limitBytes);
  const pressureLabel = formatMemoryPressure(summary.pressureBasisPoints);
  const formattedLimit = formatBytes(summary.limitBytes);
  const progressWidth =
    summary.pressureBasisPoints === 0
      ? 0
      : Math.max(0.6, summary.pressurePercent);

  return (
    <div
      aria-label={`Memory: ${formatBytes(summary.usedBytes)} used, ${pressureLabel} of the ${formattedLimit} limit.`}
      className="kernel-tray-metric"
      data-tid="kernel-tray-memory"
      role="group"
      title={`${formatExactNat(summary.usedBytes)} bytes used of ${formatExactNat(summary.limitBytes)} bytes`}
    >
      <dt>Memory</dt>
      <dd className="kernel-tray-memory-body">
        <span className="kernel-tray-memory-value">
          <span>{formatBytes(summary.usedBytes)}</span>
          <strong>{pressureLabel}</strong>
        </span>
        <div
          aria-label="Memory usage"
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={summary.pressurePercent}
          aria-valuetext={`${pressureLabel} of the ${formattedLimit} limit`}
          className="kernel-tray-memory-progress"
          role="progressbar"
        >
          <span style={{ width: `${progressWidth}%` }} />
        </div>
        <span className="kernel-tray-memory-caption">
          of {formattedLimit} limit
        </span>
      </dd>
    </div>
  );
}

function KernelMetric({
  dataTid,
  exact,
  label,
  value,
}: {
  dataTid?: string;
  exact?: string;
  label: string;
  value: string;
}) {
  return (
    <div
      className="kernel-tray-metric"
      data-tid={dataTid}
      title={exact}
    >
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
