import { expect, test } from "bun:test";
import {
  assertCandidMethodBinding,
  assertCompiledSelfCallBindings,
  assertInstallCommitBinding,
} from "../src/candid_signatures.ts";
import { physicalAppMethodName } from "neutron-tools/src/physical_names.js";

const types = `
type Request = record {
  cursor : nat64;
  media : vec record {
    original : blob;
    thumbnail : opt vec nat8;
  };
};
type Response = variant {
  ok : record {
    objects : vec blob;
    nested : opt record { proof : blob };
  };
  err : text;
};
`;

function did(methods: string): string {
  return `${types}
type Class = service {
${methods}
};
service : () -> Class
`;
}

test("preapproved self-call bindings allow app-owned nested and repeated blobs", () => {
  const candid = did(`
  nested_query : (request : Request) -> (Response) query;
  nested_update : (request : Request) -> (Response);
  unusual_shape : (blob, record { body : blob }, blob) -> (blob, blob) query;
  `);

  expect(() =>
    assertCandidMethodBinding(candid, {
      physicalMethod: "nested_query",
      mode: "query",
    }),
  ).not.toThrow();
  expect(() =>
    assertCandidMethodBinding(candid, {
      physicalMethod: "nested_update",
      mode: "update",
    }),
  ).not.toThrow();
  expect(() =>
    assertCandidMethodBinding(candid, {
      physicalMethod: "unusual_shape",
      mode: "query",
    }),
  ).not.toThrow();
});

test("preapproved self-call bindings require the exact physical method and mode", () => {
  const candid = did(`
  read : (request : Request) -> (Response) query;
  write : (request : Request) -> (Response);
  composite : (request : Request) -> (Response) composite_query;
  fire : (request : Request) -> () oneway;
  `);

  expect(() =>
    assertCandidMethodBinding(candid, {
      physicalMethod: "missing",
      mode: "query",
    }),
  ).toThrow(/physical method is missing/);
  expect(() =>
    assertCandidMethodBinding(candid, {
      physicalMethod: "read",
      mode: "update",
    }),
  ).toThrow(/mode is query, expected update/);
  expect(() =>
    assertCandidMethodBinding(candid, {
      physicalMethod: "write",
      mode: "query",
    }),
  ).toThrow(/mode is update, expected query/);
  expect(() =>
    assertCandidMethodBinding(candid, {
      physicalMethod: "composite",
      mode: "query",
    }),
  ).toThrow(/mode is composite_query, expected query/);
  expect(() =>
    assertCandidMethodBinding(candid, {
      physicalMethod: "fire",
      mode: "update",
    }),
  ).toThrow(/mode is oneway, expected update/);
});

test("install commit binding requires the exact deployment and result ABI", () => {
  for (const candid of [
    `
      type Deployment = record { deployment_id : text };
      type Result = variant { committed; blocked; };
      type Kernel = service {
        kernel_install_commit : (Deployment) -> (Result);
      };
      service : () -> Kernel
    `,
    did(
      "kernel_install_commit : (record { deployment_id : text }) -> (variant { blocked; committed });",
    ),
  ]) {
    expect(() => assertInstallCommitBinding(candid)).not.toThrow();
  }

  for (const candid of [
    did("kernel_install_commit : () -> ();"),
    did(
      "kernel_install_commit : (record { deployment_id : nat }) -> (variant { committed; blocked });",
    ),
    did(
      "kernel_install_commit : (record { deployment_id : text }) -> (variant { committed });",
    ),
    did(
      "kernel_install_commit : (record { deployment_id : text }) -> (variant { committed; blocked }) query;",
    ),
  ]) {
    expect(() => assertInstallCommitBinding(candid)).toThrow(
      /install commit binding mismatch/,
    );
  }
});

test("compiler binds API-1 logical methods to deterministic physical methods", () => {
  const physical = physicalAppMethodName("files", "read_chunk");
  const candid = did(`${physical} : (request : Request) -> (Response) query;`);
  const bindings = assertCompiledSelfCallBindings(candid, {
    files: {
      plan: {
        entries: [
          {
            id: "preapproved_self_calls",
            api: 1,
            provenance: "declared",
            config: {
              api: 1,
              methods: [{ method: "read_chunk", mode: "query" }],
            },
          },
        ],
      },
    },
  });

  expect(bindings).toEqual([
    {
      appId: "files",
      logicalMethod: "read_chunk",
      physicalMethod: physical,
      mode: "query",
    },
  ]);
});

test("compiler rejects non-API-1 preapproved plans instead of skipping checks", () => {
  expect(() =>
    assertCompiledSelfCallBindings(did(""), {
      files: {
        plan: {
          entries: [
            {
              id: "preapproved_self_calls",
              config: { api: 2, methods: [] },
            },
          ],
        },
      },
    }),
  ).toThrow(/Invalid API-1 preapproved_self_calls compiler plan/);
});
