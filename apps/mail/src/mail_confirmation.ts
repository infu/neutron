import type { MailUiRoute } from "./mail_ui.tsx";

export type ComposerLeaveConfirmationKind = "discard" | "sending";

export function composerLeaveConfirmationKind(
  route: MailUiRoute,
  draftDirty: boolean,
  sendPending: boolean,
): ComposerLeaveConfirmationKind | null {
  if (route !== "compose") return null;
  if (sendPending) return "sending";
  return draftDirty ? "discard" : null;
}
