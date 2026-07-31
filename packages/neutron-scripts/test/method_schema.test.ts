import { expect, test } from "bun:test";
import {
  extractGeneratedAliases,
  generateAppMethodSchemaArtifact,
  validateAppMethodArgs,
} from "../src/method_schema.ts";

const source = `
module {
/*---NEUTRON GENERATED BEGIN---*/

public type status_Input = ();
public type status_Output = Text;

public type save_profile_Input = (name : Text, email : Text, notes : Text, subscribed : Bool);
public type save_profile_Output = Text;

public type bump_counter_Input = (step : Nat);
public type bump_counter_Output = Nat;

/*---NEUTRON GENERATED END---*/
}
`;

test("extracts generated Motoko input and output aliases", () => {
  expect(extractGeneratedAliases(source)).toMatchObject({
    status: {
      input: "()",
      output: "Text",
    },
    save_profile: {
      input: "(name : Text, email : Text, notes : Text, subscribed : Bool)",
      output: "Text",
    },
  });
});

test("generates wrapper-accurate method schemas for app packages", () => {
  const artifact = generateAppMethodSchemaArtifact(
    {
      format: 3,
      id: "demo",
      name: "Demo",
      version: 1,
      src: "main.mo",
      func: {
        status: { type: "query", async: false, allow: "unauthorized" },
        save_profile: { type: "update", async: false },
        bump_counter: { type: "update", async: false },
      },
    },
    source
  );

  expect(artifact.methods.status).toMatchObject({
    type: "query",
    allow: "unauthorized",
    input: {
      type: "array",
      minItems: 1,
      maxItems: 1,
      prefixItems: [{ type: "null" }],
    },
  });
  expect(artifact.methods.save_profile).toMatchObject({
    type: "update",
    input: {
      type: "array",
      minItems: 1,
      maxItems: 1,
      prefixItems: [
        {
          type: "array",
          minItems: 4,
          maxItems: 4,
          prefixItems: [
            { type: "string" },
            { type: "string" },
            { type: "string" },
            { type: "boolean" },
          ],
        },
      ],
    },
  });
  expect(artifact.methods.bump_counter).toMatchObject({
    input: {
      type: "array",
      prefixItems: [{ type: "string", description: "bigint as string" }],
    },
    output: {
      type: "string",
      description: "bigint as string",
    },
  });

  expect(validateAppMethodArgs(artifact, "status", [null]).valid).toBe(true);
  expect(validateAppMethodArgs(artifact, "status", []).valid).toBe(false);
  expect(
    validateAppMethodArgs(artifact, "save_profile", [
      ["Ada", "ada@example.test", "Notes", true],
    ]).valid
  ).toBe(true);
  expect(
    validateAppMethodArgs(artifact, "save_profile", [
      "Ada",
      "ada@example.test",
      "Notes",
      true,
    ]).valid
  ).toBe(false);
  expect(validateAppMethodArgs(artifact, "bump_counter", ["1"]).valid).toBe(
    true
  );
  expect(validateAppMethodArgs(artifact, "bump_counter", [1]).valid).toBe(
    false
  );
});

test("resolves local public aliases with nested record fields", () => {
  const aliasedSource = `
module {
  public type Ledger = {
    principal : Principal;
    symbol : ?Text;
    balance : ?Nat;
  };
  public type Snapshot = { owner : Principal; ledgers : [Ledger] };
  public type wallet_snapshot_Input = ();
  public type wallet_snapshot_Output = Snapshot;
}
`;
  const artifact = generateAppMethodSchemaArtifact(
    {
      format: 3,
      id: "wallet",
      name: "Wallet",
      version: 1,
      func: { wallet_snapshot: { type: "query", async: false } },
    },
    aliasedSource
  );

  expect(artifact.methods.wallet_snapshot?.output).toMatchObject({
    type: "object",
    properties: {
      owner: { oneOf: expect.any(Array) },
      ledgers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            principal: { oneOf: expect.any(Array) },
            symbol: {},
            balance: {},
          },
        },
      },
    },
  });
});

test("resolves variants and unwraps Result success schemas", () => {
  const variantSource = `
module {
  public type Kind = { #person; #self };
  public type Error = {
    #validation : Text;
    #conflict : { expected : Nat; actual : Nat };
  };
  public type Result = { #ok : Kind; #err : Error };
  public type save_Input = (kind : Kind);
  public type save_Output = Result;
}
`;
  const artifact = generateAppMethodSchemaArtifact(
    {
      format: 3,
      id: "contacts",
      name: "Contacts",
      version: 1,
      func: { save: { type: "update", async: false } },
    },
    variantSource
  );

  const input = artifact.methods.save?.input as {
    prefixItems: Array<{ oneOf: Array<{ required: string[] }> }>;
  };
  const output = artifact.methods.save?.output as {
    oneOf: Array<{ required: string[] }>;
  };
  expect(input.prefixItems[0]?.oneOf.map((item) => item.required[0])).toEqual([
    "person",
    "self",
  ]);
  expect(output.oneOf.map((item) => item.required[0])).toEqual([
    "person",
    "self",
  ]);
});

test("mirrors Motoko trailing-underscore Candid label escaping", () => {
  const escapedSource = `
module {
  public type Space = { #shared__; #workspace };
  public type Request = {
    space : Space;
    query_ : Text;
  };
  public type inspect_Input = (request : Request);
  public type inspect_Output = Space;
}
`;
  const artifact = generateAppMethodSchemaArtifact(
    {
      format: 3,
      id: "escaped-labels",
      name: "Escaped labels",
      version: 1,
      func: { inspect: { type: "query", async: false } },
    },
    escapedSource
  );

  const input = artifact.methods.inspect?.input as {
    prefixItems: Array<{
      properties: {
        space: { oneOf: Array<{ required: string[] }> };
        query: { type: string };
      };
    }>;
  };
  const output = artifact.methods.inspect?.output as {
    oneOf: Array<{ required: string[] }>;
  };
  expect(input.prefixItems[0]?.properties).not.toHaveProperty("query_");
  expect(input.prefixItems[0]?.properties.query).toEqual({ type: "string" });
  expect(
    input.prefixItems[0]?.properties.space.oneOf.map(
      (item) => item.required[0]
    )
  ).toEqual(["shared_", "workspace"]);
  expect(output.oneOf.map((item) => item.required[0])).toEqual([
    "shared_",
    "workspace",
  ]);
  expect(
    validateAppMethodArgs(artifact, "inspect", [
      { space: { shared_: null }, query: "needle" },
    ]).valid
  ).toBe(true);
  expect(
    validateAppMethodArgs(artifact, "inspect", [
      { space: { shared__: null }, query_: "needle" },
    ]).valid
  ).toBe(false);
});
