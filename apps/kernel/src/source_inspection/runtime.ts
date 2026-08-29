import { getNeutronCan } from "../reducer/auth.ts";
import { useAppsStore } from "../reducer/apps.ts";
import {
  BoundedResponseLimitError,
  readBoundedResponse,
} from "../settings/installed_package_record.ts";
import {
  InstalledArtifactInspector,
  type InstalledArtifactInspectionEnvironment,
} from "./installed_artifacts.ts";

const MAX_STATIC_KEYS = 20_000;

const browserEnvironment: InstalledArtifactInspectionEnvironment =
  Object.freeze({
    currentBinding(appId) {
      const state = useAppsStore.getState();
      const app = state.list[appId];
      const instance = state.appInstances[appId];
      if (
        !app ||
        !instance ||
        instance.scope.appId !== appId ||
        instance.version !== app.version ||
        instance.capabilityPlanFingerprint !== app.capability_plan_fingerprint
      ) {
        return null;
      }
      return Object.freeze({
        appId,
        version: app.version,
        installationUid: instance.scope.installationUid,
        capabilityPlanFingerprint: instance.capabilityPlanFingerprint,
        runtimeIdentity: instance.deploymentId,
      });
    },

    async listStatic(prefix, signal) {
      throwIfAborted(signal);
      const paths = await (
        await getNeutronCan()
      ).kernel_static_query({
        list: { prefix },
      });
      throwIfAborted(signal);
      if (!Array.isArray(paths) || paths.length > MAX_STATIC_KEYS) {
        throw new Error("Installed artifact inventory is too large");
      }
      return paths;
    },

    async readAsset(path, maximumBytes, signal) {
      throwIfAborted(signal);
      let response: Response;
      try {
        response = await fetch(path, {
          cache: "no-store",
          credentials: "same-origin",
          headers: { accept: "*/*" },
          method: "GET",
          redirect: "error",
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        throwIfAborted(signal);
        throw new Error(`Could not read installed artifact ${path}`, {
          cause: error,
        });
      }
      if (response.status === 404) return { status: "missing" as const };
      if (!response.ok) {
        throw new Error(
          `Could not read installed artifact ${path}: HTTP ${response.status}`,
        );
      }
      if (response.redirected) {
        throw new Error(`Installed artifact ${path} unexpectedly redirected`);
      }
      try {
        const content = await readBoundedResponse(
          response,
          `Installed artifact ${path}`,
          maximumBytes,
        );
        throwIfAborted(signal);
        return { status: "ok" as const, content };
      } catch (error) {
        if (error instanceof BoundedResponseLimitError) {
          return { status: "too_large" as const };
        }
        throw error;
      }
    },
  });

export const installedArtifactInspector = new InstalledArtifactInspector(
  browserEnvironment,
);

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException(
    "Installed artifact inspection was cancelled",
    "AbortError",
  );
}
