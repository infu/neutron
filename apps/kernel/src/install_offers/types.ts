import type { RepositorySetupReference } from "neutron-tools/repository";

/**
 * An install source that has already passed the Kernel's URL and protocol
 * admission checks. Keeping normalization outside this module makes the
 * consent layer incapable of contacting the offered source.
 */
export type NormalizedInstallOffer =
  | {
      kind: "package_url";
      url: string;
    }
  | {
      kind: "repository_setup_url";
      url: string;
      reference: Readonly<RepositorySetupReference>;
    };

export type AppInstallOfferRequester = {
  kind: "app";
  appId: string;
  appName: string;
  surface: "tile" | "tray" | "background";
};

export type AgentInstallOfferRequester = {
  kind: "agent";
  /** App whose scoped endpoint executed the install-offer tool. */
  appId: string;
  appName: string;
  /** App and entrypoint that own the active Agent Mode root. */
  rootAppId: string;
  rootAppName: string;
  entrypoint: string;
  /** Human-readable tool on the current scoped invocation. */
  tool: string;
  rootId: string;
};

/**
 * Requester identity is supplied only by trusted Kernel routing code. Apps and
 * agents nominate an URL, never their own attribution.
 */
export type AttestedInstallOfferRequester =
  | AppInstallOfferRequester
  | AgentInstallOfferRequester;

export type PendingInstallOffer = {
  requestId: string;
  offer: Readonly<NormalizedInstallOffer>;
  requester: Readonly<AttestedInstallOfferRequester>;
  expiresAt: number;
};

export type InstallOfferApproval = {
  requestId: string;
  offer: Readonly<NormalizedInstallOffer>;
  requester: Readonly<AttestedInstallOfferRequester>;
};

export type InstallOfferRequestInput = {
  offer: NormalizedInstallOffer;
  requester: AttestedInstallOfferRequester;
  /**
   * Throws, or returns false, when the attested app/agent endpoint is no longer
   * current. It is checked immediately before owner approval is handed off.
   */
  assertCurrent: () => void | boolean;
  /**
   * Starts the existing Kernel-owned URL or repository review flow. The
   * pre-contact dialog and owner-attention token are released before this runs.
   */
  onApprove: (approval: InstallOfferApproval) => void | Promise<void>;
  /** Intended for deterministic tests; production callers should omit it. */
  timeoutMs?: number;
};

export type InstallOfferRequestHandle = {
  requestId: string;
  completion: Promise<InstallOfferApproval>;
};
