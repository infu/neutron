import { schema } from "./schema.ts";
import { validate, type ValidatorResult } from "jsonschema";

export function validate_neutron_conf(conf: unknown): ValidatorResult {
  return validate(conf, schema);
}
