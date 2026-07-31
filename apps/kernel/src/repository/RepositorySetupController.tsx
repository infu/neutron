import { useEffect, useRef } from "react";
import { useAppsStore } from "../reducer/apps.ts";
import { useAuthStore } from "../reducer/auth.ts";
import { RepositorySetupDialog } from "./RepositorySetupDialog.tsx";
import {
  clearRepositorySetupForOwnerChange,
  refreshPendingRepositorySetup,
} from "./service.ts";

export function RepositorySetupController() {
  const { authorized, loading, logged, principal } = useAuthStore();
  const registryStatus = useAppsStore((state) => state.registryStatus);
  const owner = useRef<string | null>(null);

  useEffect(() => {
    if (loading) return;
    if (!logged || !authorized) {
      if (owner.current !== null) {
        owner.current = null;
        clearRepositorySetupForOwnerChange();
      }
      return;
    }
    if (owner.current !== null && owner.current !== principal) {
      clearRepositorySetupForOwnerChange();
    }
    owner.current = principal;
  }, [authorized, loading, logged, principal]);

  useEffect(() => {
    if (!logged || !authorized || loading || registryStatus !== "ready") return;
    refreshPendingRepositorySetup();
    const refresh = () =>
      refreshPendingRepositorySetup({ freshCapture: true });
    window.addEventListener("neutron:repository-setup-captured", refresh);
    return () =>
      window.removeEventListener("neutron:repository-setup-captured", refresh);
  }, [authorized, loading, logged, principal, registryStatus]);

  return <RepositorySetupDialog />;
}
