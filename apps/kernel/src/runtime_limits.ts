export const MAX_INSTALLED_APP_INSTANCES = 256;
export const MAX_RESIDENT_APP_FRAMES = 32;

type AppSurface = Readonly<{
  background?: unknown;
}>;

type TargetAppSurface = AppSurface &
  Readonly<{
    id: string;
  }>;

export function assertAppSurfaceInventoryCapacity(
  apps: Readonly<Record<string, AppSurface>>,
): void {
  assertAppCounts(
    Object.keys(apps).length,
    residentFrameCount(Object.values(apps)),
  );
}

/**
 * Preflight the complete post-install surface inventory. A target replaces an
 * existing app with the same id; all other installed apps remain.
 */
export function assertTargetAppSurfaceCapacity(
  existing: Readonly<Record<string, AppSurface>>,
  targets: readonly TargetAppSurface[],
): void {
  const targetIds = new Set<string>();
  for (const target of targets) {
    if (!target.id || targetIds.has(target.id)) {
      throw new Error("Install target app ids are invalid or repeated");
    }
    targetIds.add(target.id);
  }

  const retained = Object.entries(existing)
    .filter(([appId]) => !targetIds.has(appId))
    .map(([, app]) => app);
  assertAppCounts(
    retained.length + targets.length,
    residentFrameCount(retained) + residentFrameCount(targets),
  );
}

function assertAppCounts(appInstances: number, residentFrames: number): void {
  if (
    !Number.isSafeInteger(appInstances) ||
    appInstances < 0 ||
    appInstances > MAX_INSTALLED_APP_INSTANCES
  ) {
    throw new Error(
      `Installation declares ${appInstances} apps; maximum is ${MAX_INSTALLED_APP_INSTANCES} including Kernel`,
    );
  }
  if (
    !Number.isSafeInteger(residentFrames) ||
    residentFrames < 0 ||
    residentFrames > MAX_RESIDENT_APP_FRAMES
  ) {
    throw new Error(
      `Installation declares ${residentFrames} resident backgrounds; maximum is ${MAX_RESIDENT_APP_FRAMES}`,
    );
  }
}

function residentFrameCount(apps: readonly AppSurface[]): number {
  return apps.reduce(
    (count, app) => count + (app.background === undefined ? 0 : 1),
    0,
  );
}
