import { IDL } from "@dfinity/candid";
import { idlFactory } from "../candid/sns_governance.did.js";

export interface CandidMethodTypes {
  argTypes: IDL.Type[];
  retTypes: IDL.Type[];
  annotations: string[];
}

type Fields = { _fields: [string, IDL.Type][] };
let service: { _fields: [string, CandidMethodTypes][] } | undefined;

/** Types from the bundled interface, not a claim about an installed SNS version. */
export function governanceMethodTypes(name: string): CandidMethodTypes {
  service ??= idlFactory({ IDL }) as unknown as typeof service;
  const method = service?._fields.find(([field]) => field === name)?.[1];
  if (!method) throw new Error(`Unknown governance method: ${name}`);
  return method;
}

export function candidFieldType(type: IDL.Type, field: string): IDL.Type {
  const result = (type as unknown as Fields)._fields?.find(([name]) => name === field)?.[1];
  if (!result) throw new Error(`Missing Candid field: ${field}`);
  return result;
}

export function candidOptionType(type: IDL.Type): IDL.Type {
  if (!(type instanceof IDL.OptClass)) throw new Error("Expected a Candid option");
  return type._type;
}

export function candidVariantFields(type: IDL.Type): [string, IDL.Type][] {
  if (!(type instanceof IDL.VariantClass)) throw new Error("Expected a Candid variant");
  return (type as unknown as Fields)._fields;
}

export function governanceCommandType(): IDL.Type {
  return candidOptionType(candidFieldType(governanceMethodTypes("manage_neuron").argTypes[0]!, "command"));
}

export function governanceActionType(): IDL.Type {
  return candidOptionType(candidFieldType(candidFieldType(governanceCommandType(), "MakeProposal"), "action"));
}
