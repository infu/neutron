import { useEffect, useRef } from "react";
import { useAuthStore } from "../reducer/auth.ts";
import { InstallOfferDialog } from "./InstallOfferDialog.tsx";
import { clearInstallOffer } from "./service.ts";

/**
 * Clear pending offers as soon as the authorized owner session ends or
 * changes. Owner observation stays separate from the inert dialog view.
 */
export function InstallOfferController() {
  const { authorized, loading, logged, principal } = useAuthStore();
  const owner = useRef<string | null>(null);

  useEffect(() => {
    if (loading) return;
    if (!logged || !authorized) {
      if (owner.current !== null) {
        owner.current = null;
        clearInstallOffer("Owner authorization ended");
      }
      return;
    }
    if (owner.current !== null && owner.current !== principal) {
      clearInstallOffer("The authorized owner changed");
    }
    owner.current = principal;
  }, [authorized, loading, logged, principal]);

  return <InstallOfferDialog />;
}
