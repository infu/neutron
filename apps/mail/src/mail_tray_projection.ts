import type { MailPrivateListPage, MailPrivateResidentProjection } from "./mail_private.ts";
import { MailPrivateError } from "./mail_private.ts";
import type {
  MailCryptoResidentSession,
  MailCryptoSessionSnapshot,
} from "./mail_crypto_session.ts";

export const MAIL_TRAY_PROJECTION_TOOL = "mail_tray_projection";
export const MAIL_TRAY_PRIVATE_LIMIT = 5;

export type MailTrayProjection =
  | { version: 1; state: "loading" }
  | { version: 1; state: "not_configured" }
  | { version: 1; state: "unavailable" }
  | {
      version: 1;
      state: "ready";
      page: MailPrivateListPage;
    };

export type MailTrayProjectionDependencies = {
  session: Pick<MailCryptoResidentSession, "status">;
  privateMail: Pick<MailPrivateResidentProjection, "list">;
};

/**
 * Resident-only bounded tray adapter. It can return five authenticated header
 * projections, but it has no body, search, mutation, or key-lifecycle operation.
 */
export class MailTrayResidentProjection {
  readonly #dependencies: MailTrayProjectionDependencies;

  constructor(dependencies: MailTrayProjectionDependencies) {
    this.#dependencies = dependencies;
  }

  async snapshot(input: {
    expectedRevision: string;
    expectedContactsRevision: string;
  }): Promise<MailTrayProjection> {
    let session: MailCryptoSessionSnapshot;
    try {
      session = await this.#dependencies.session.status();
    } catch {
      return { version: 1, state: "unavailable" };
    }
    if (session.lockState === "not_configured" || session.currentEpoch === null) {
      return { version: 1, state: "not_configured" };
    }
    if (!session.currentUnlocked) return { version: 1, state: "unavailable" };

    try {
      const page = await this.#dependencies.privateMail.list({
        folder: "inbox",
        unreadOnly: false,
        offset: "0",
        limit: MAIL_TRAY_PRIVATE_LIMIT,
        expectedRevision: input.expectedRevision,
        expectedContactsRevision: input.expectedContactsRevision,
      });
      if (
        page.revision !== input.expectedRevision ||
        page.contactsRevision !== input.expectedContactsRevision ||
        page.items.length > MAIL_TRAY_PRIVATE_LIMIT ||
        page.items.some((item) => item.folder !== "inbox")
      ) return { version: 1, state: "unavailable" };
      return {
        version: 1,
        state: "ready",
        page,
      };
    } catch (error) {
      // Migration can briefly make a second generation necessary. The resident
      // owns that preparation; the tray remains metadata-safe while it settles.
      if (error instanceof MailPrivateError && error.code === "mail_locked") {
        return { version: 1, state: "unavailable" };
      }
      return { version: 1, state: "unavailable" };
    }
  }
}
