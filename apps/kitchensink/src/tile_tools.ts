import type { JsonSchemaDocument } from "neutron-tools/app";

export const counterIncrementInputSchema = {
  type: "object",
  required: ["step"],
  properties: {
    step: {
      type: "string",
      pattern: "^0$|^[1-9][0-9]{0,3}$|^10000$",
    },
  },
  additionalProperties: false,
} satisfies JsonSchemaDocument;
