import {
  getNeutronCan,
  type KernelActor,
} from "../reducer/auth.ts";
import {
  validateAppUsageSnapshot,
  validateMemorySnapshot,
  validateSettingsSnapshot,
  type KernelAppUsageSnapshot,
  type KernelMemorySnapshot,
  type KernelSettingsSnapshot,
} from "./model.ts";

type SettingsSnapshotActor = Pick<KernelActor, "kernel_settings_snapshot">;
type AppUsageSnapshotActor = Pick<
  KernelActor,
  "kernel_app_usage_snapshot"
>;

export async function loadKernelSettingsSnapshot(
  actor:
    | SettingsSnapshotActor
    | Promise<SettingsSnapshotActor> = getNeutronCan(),
): Promise<KernelSettingsSnapshot> {
  const kernel = await actor;
  return validateSettingsSnapshot(await kernel.kernel_settings_snapshot(null));
}

export async function loadKernelMemorySnapshot(): Promise<KernelMemorySnapshot> {
  const kernel = await getNeutronCan();
  return validateMemorySnapshot(await kernel.kernel_memory_snapshot(null));
}

export async function loadKernelAppUsageSnapshot(
  actor:
    | AppUsageSnapshotActor
    | Promise<AppUsageSnapshotActor> = getNeutronCan(),
): Promise<KernelAppUsageSnapshot> {
  const kernel = await actor;
  return validateAppUsageSnapshot(
    await kernel.kernel_app_usage_snapshot(null),
  );
}
