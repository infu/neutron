import type { AppRegistry } from "neutron-compiler/src/install.js";

export type LauncherEntry = {
  appId: string;
  appName: string;
  tileId: string;
  title: string;
  path: string;
  icon: string;
};

export const launcherSystemActions = {
  installPackage: "launcher-install-package",
  installPackageUrl: "launcher-install-package-url",
  resetWorkspace: "launcher-reset-workspace",
} as const;

export function launcherEntriesFromApps(
  apps: AppRegistry,
  query = ""
): LauncherEntry[] {
  const normalizedQuery = query.trim().toLowerCase();
  const entries: LauncherEntry[] = [];

  for (const [appId, app] of Object.entries(apps)) {
    if (appId === "kernel") continue;
    for (const tile of app.tiles) {
      entries.push({
        appId,
        appName: app.name,
        tileId: tile.id,
        title: tile.title,
        path: tile.path,
        icon: tile.icon,
      });
    }
  }

  if (!normalizedQuery) return entries;
  return entries.filter((entry) =>
    [entry.appId, entry.appName, entry.tileId, entry.title, entry.path]
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery)
  );
}
