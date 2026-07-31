import {
  exposeTool,
  type JsonObject,
} from "neutron-tools/app";
import {
  normalizeContactName,
  normalizeDestination,
} from "./address.ts";

export const CONTACT_PREFILL_TOOL = "prefill_new_contact";

export type ContactPrefill = {
  name: string;
  principal: string;
};

export type ContactPrefillStatus = "ready" | "busy";
export type ContactPrefillListener = (
  prefill: ContactPrefill,
) => ContactPrefillStatus;

/**
 * One tile owns one broker. Registration happens before React mounts so a
 * newly opened Contacts endpoint advertises the tool immediately; the broker
 * holds at most one call while the editor subscribes.
 */
export class ContactPrefillBroker {
  #listener: ContactPrefillListener | null = null;
  #pending: ContactPrefill | null = null;

  deliver(prefill: ContactPrefill): ContactPrefillStatus {
    if (this.#listener) return this.#listener(prefill);
    if (this.#pending) return "busy";
    this.#pending = prefill;
    return "ready";
  }

  subscribe(listener: ContactPrefillListener): () => void {
    this.#listener = listener;
    const pending = this.#pending;
    this.#pending = null;
    if (pending) {
      queueMicrotask(() => {
        if (this.#listener === listener) listener(pending);
      });
    }
    return () => {
      if (this.#listener === listener) this.#listener = null;
    };
  }
}

export function parseContactPrefill(args: JsonObject): ContactPrefill {
  if (
    typeof args.suggestedName !== "string" ||
    typeof args.neutronPrincipal !== "string"
  ) {
    throw new Error("Contact prefill requires a name and Neutron principal");
  }
  const destination = normalizeDestination({
    network: "neutron",
    principal: args.neutronPrincipal,
  });
  if (destination.network !== "neutron") {
    throw new Error("Contact prefill requires a Neutron principal");
  }
  return {
    name: normalizeContactName(args.suggestedName),
    principal: destination.principal,
  };
}

export const contactPrefillBroker = new ContactPrefillBroker();

exposeTool(
  CONTACT_PREFILL_TOOL,
  {
    title: "Prefill New Contact",
    description:
      "Open an unsaved Contacts form with a suggested name and Neutron address. Nothing is stored until the user reviews the form and clicks Save.",
    inputSchema: {
      type: "object",
      required: ["suggestedName", "neutronPrincipal"],
      properties: {
        suggestedName: { type: "string", minLength: 1, maxLength: 120 },
        neutronPrincipal: {
          type: "string",
          minLength: 3,
          maxLength: 63,
          pattern: "^[a-z0-9-]+$",
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      required: ["status"],
      properties: {
        status: { type: "string", enum: ["ready", "busy"] },
      },
      additionalProperties: false,
    },
    annotations: { "neutron:effects": ["user_visible_ui"] },
  },
  async (args) => ({
    status: contactPrefillBroker.deliver(parseContactPrefill(args)),
  }),
);
