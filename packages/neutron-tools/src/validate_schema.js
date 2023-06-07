import { schema } from "./schema.js";
import { validate } from "jsonschema";

export function validate_neutron_conf(conf) {
  return validate(conf, schema);
}
