import { create } from "zustand";
import type { PendingInstallOffer } from "./types.ts";

type InstallOfferState = {
  pending: PendingInstallOffer | null;
};

export const useInstallOfferStore = create<InstallOfferState>(() => ({
  pending: null,
}));
