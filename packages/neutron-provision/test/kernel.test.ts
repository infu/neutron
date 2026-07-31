import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { expect, test } from "bun:test";
import type {
  CheckedInstallJournalRequest,
  KernelInstallReservationsPrepareRequest,
  KernelRuntimeInfo,
  KernelStaticRequest,
} from "neutron-compiler/src/install.js";
import {
  createDirectPocketIcKernelActor,
  kernelIdl,
} from "../src/kernel.ts";

test("direct PocketIC kernel actor preserves one caller-bound ingress per asset operation", async () => {
  const caller = Principal.fromText("aaaaa-aa");
  const canisterId = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
  const submitted: Array<{
    sender: Principal;
    canisterId: Principal;
    method: string;
    payload: Uint8Array;
  }> = [];
  let nextMessage = 1;
  const client = {
    async submitIngressMessage(_instanceId: number, call: (typeof submitted)[number]) {
      submitted.push(call);
      return {
        effectivePrincipal: "None" as const,
        messageId: Buffer.alloc(32, nextMessage++).toString("base64"),
      };
    },
    async awaitIngressMessage() {
      return new Uint8Array(IDL.encode([IDL.Null], [null]));
    },
    async queryCanister() {
      throw new Error("unexpected query");
    },
  };
  const actor = createDirectPocketIcKernelActor({
    controlUrl: "http://127.0.0.1:41000/",
    instanceId: 7,
    canisterId: canisterId.toText(),
    caller,
    client,
  });

  await Promise.all([
    actor.kernel_static(staticStore("/app/one.js", [1])),
    actor.kernel_static(staticStore("/app/two.js", [2])),
  ]);

  expect(submitted).toHaveLength(2);
  expect(submitted.map(({ method }) => method)).toEqual([
    "kernel_static",
    "kernel_static",
  ]);
  expect(
    submitted.map(({ sender }) => sender.toText()),
  ).toEqual([caller.toText(), caller.toText()]);
  expect(
    submitted.map(({ canisterId: target }) => target.toText()),
  ).toEqual([canisterId.toText(), canisterId.toText()]);

  const service = kernelIdl({ IDL });
  const method = new Map(service._fields).get("kernel_static");
  if (method === undefined) throw new Error("kernel_static IDL is missing");
  const decoded = submitted.map(({ payload }) =>
    IDL.decode(method.argTypes, payload)[0] as KernelStaticRequest,
  );
  expect(decoded.map((request) => "store" in request && request.store.key)).toEqual([
    "/app/one.js",
    "/app/two.js",
  ]);
});

test("kernel IDL preserves resident-frame authority in journals and runtime state", () => {
  const methods = new Map(kernelIdl({ IDL })._fields);
  const begin = methods.get("kernel_install_begin_checked");
  if (begin === undefined) {
    throw new Error("kernel_install_begin_checked IDL is missing");
  }
  const request: CheckedInstallJournalRequest = {
    expected_deployment_id: "before",
    journal: {
      deployment_id: "after",
      copies: [],
      clear_prefixes: [],
      target_app_inventory: [
        {
          app_id: "opaque",
          version: 1n,
          capability_plan_fingerprint: "opaque-plan",
          resident_frame_security: { credentialless_opaque_v1: null },
        },
        {
          app_id: "ephemeral",
          version: 2n,
          capability_plan_fingerprint: "ephemeral-plan",
          resident_frame_security: {
            credentialless_ephemeral_dedicated_v1: null,
          },
        },
        {
          app_id: "persistent",
          version: 3n,
          capability_plan_fingerprint: "persistent-plan",
          resident_frame_security: { persistent_dedicated_v1: null },
        },
      ],
    },
  };
  expect(
    IDL.decode(begin.argTypes, IDL.encode(begin.argTypes, [request]))[0] as
      unknown,
  ).toEqual(request);

  const runtimeMethod = methods.get("kernel_runtime_info");
  if (runtimeMethod === undefined) {
    throw new Error("kernel_runtime_info IDL is missing");
  }
  const runtime: KernelRuntimeInfo = {
    deployment_id: "after",
    assembler_id: "assembler",
    compiler_id: "compiler",
    apps: [
      {
        scope: { app_id: "persistent", installation_uid: 7n },
        version: 3n,
        deployment_id: "after",
        capability_plan_fingerprint: "persistent-plan",
        browser_origin_nonce: "00".repeat(16),
        browser_origin_authority_epoch: 9n,
        resident_frame_security: { persistent_dedicated_v1: null },
      },
    ],
    memories: [],
  };
  expect(
    IDL.decode(
      runtimeMethod.retTypes,
      IDL.encode(runtimeMethod.retTypes, [runtime]),
    )[0] as unknown,
  ).toEqual(runtime);
});

test("kernel IDL encodes pre-dispatch install reservation plans", () => {
  const prepare = new Map(kernelIdl({ IDL })._fields).get(
    "kernel_install_reservations_prepare",
  );
  if (prepare === undefined) {
    throw new Error("kernel_install_reservations_prepare IDL is missing");
  }
  const principal = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
  const request: KernelInstallReservationsPrepareRequest = {
    deployment_id: "after",
    apps: [
      {
        app_id: "mail",
        reservations: [
          {
            exact: {
              principal,
              method: "app_mail__mail_v1_update",
            },
          },
          { method: "app_mail__mail_v1_update" },
          { principal },
        ],
      },
    ],
  };

  expect(
    IDL.decode(
      prepare.argTypes,
      IDL.encode(prepare.argTypes, [request]),
    )[0] as unknown,
  ).toEqual(request);
});

test("kernel IDL encodes current commit and target-side pending reservation recovery", () => {
  const methods = new Map(kernelIdl({ IDL })._fields);
  const commit = methods.get("kernel_install_commit");
  if (commit === undefined) {
    throw new Error("kernel_install_commit IDL is missing");
  }
  const deployment = { deployment_id: "after" };
  expect(
    IDL.decode(
      commit.argTypes,
      IDL.encode(commit.argTypes, [deployment]),
    )[0] as unknown,
  ).toEqual(deployment);
  expect(
    IDL.decode(
      commit.retTypes,
      IDL.encode(commit.retTypes, [{ blocked: null }]),
    )[0] as unknown,
  ).toEqual({ blocked: null });

  const release = methods.get("kernel_install_pending_reservation_release");
  if (release === undefined) {
    throw new Error(
      "kernel_install_pending_reservation_release IDL is missing",
    );
  }
  const request = {
    deployment_id: "after",
    reservation_id: 17n,
  };
  expect(
    IDL.decode(
      release.argTypes,
      IDL.encode(release.argTypes, [request]),
    )[0] as unknown,
  ).toEqual(request);
  expect(
    IDL.decode(release.retTypes, IDL.encode(release.retTypes, [true]))[0],
  ).toBe(true);
});

test("kernel install status preserves canonical Candid opt arrays", () => {
  const status = new Map(kernelIdl({ IDL })._fields).get(
    "kernel_install_status",
  );
  if (status === undefined) {
    throw new Error("kernel_install_status IDL is missing");
  }
  const pending = {
    deployment_id: "after",
    copy_count: 0n,
    clear_count: 0n,
    removed_apps: [],
    committed_app_instances: [],
    target_app_instances: [],
  };

  expect(
    IDL.decode(status.retTypes, IDL.encode(status.retTypes, [[]]))[0],
  ).toEqual([]);
  expect(
    IDL.decode(status.retTypes, IDL.encode(status.retTypes, [[pending]]))[0],
  ).toEqual([pending]);
});

test("kernel IDL exposes only the generic publication entropy initializer", () => {
  const methods = new Map(kernelIdl({ IDL })._fields);
  const initialize = methods.get("kernel_publication_entropy_initialize");
  if (initialize === undefined) {
    throw new Error("kernel_publication_entropy_initialize IDL is missing");
  }
  expect(initialize.argTypes).toHaveLength(1);
  expect(
    IDL.decode(
      initialize.argTypes,
      IDL.encode(initialize.argTypes, [null]),
    )[0],
  ).toBeNull();
  const result = { ok: { fingerprint: new Uint8Array(32).fill(7) } };
  expect(
    IDL.decode(
      initialize.retTypes,
      IDL.encode(initialize.retTypes, [result]),
    )[0] as unknown,
  ).toEqual(result);
});

test("kernel IDL round-trips authoritative pending reservation blockers", () => {
  const blockers = new Map(kernelIdl({ IDL })._fields).get(
    "kernel_install_pending_reservation_blockers",
  );
  if (blockers === undefined) {
    throw new Error(
      "kernel_install_pending_reservation_blockers IDL is missing",
    );
  }
  expect(blockers.annotations).toContain("query");

  const request = { deployment_id: "after" };
  expect(
    IDL.decode(
      blockers.argTypes,
      IDL.encode(blockers.argTypes, [request]),
    )[0] as unknown,
  ).toEqual(request);

  const principal = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
  const result = [
    {
      reservation: {
        id: 17n,
        app_id: "mail",
        installation_uid: 4n,
        scope_kind: "exact",
        principal: [principal],
        method: ["app_mail__mail_v1_update"],
        created_at: 23n,
        created_by: principal,
      },
      reason: { scope_conflict: null },
    },
    {
      reservation: {
        id: 18n,
        app_id: "files",
        installation_uid: 5n,
        scope_kind: "method",
        principal: [],
        method: ["app_files__files_v1_update"],
        created_at: 24n,
        created_by: principal,
      },
      reason: { app_capacity: null },
    },
    {
      reservation: {
        id: 19n,
        app_id: "workspace",
        installation_uid: 6n,
        scope_kind: "principal",
        principal: [principal],
        method: [],
        created_at: 25n,
        created_by: principal,
      },
      reason: { global_capacity: null },
    },
  ];
  expect(
    IDL.decode(
      blockers.retTypes,
      IDL.encode(blockers.retTypes, [result]),
    )[0] as unknown,
  ).toEqual(result);
});

function staticStore(key: string, content: number[]): KernelStaticRequest {
  return {
    store: {
      key,
      val: {
        chunks: 1,
        content: new Uint8Array(content),
        content_encoding: "identity",
        content_type: "text/javascript",
      },
    },
  };
}
