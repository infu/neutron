import { Cbor } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { describe, expect, test } from "bun:test";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  POCKET_IC_ARTIFACTS,
  POCKET_IC_IDLE_TTL_SECONDS,
  POCKET_IC_SERVER_VERSION,
  type ResolvedPocketIcBinary,
} from "../src/pocketic_binary.ts";
import {
  acquirePocketIcSupervisorLock,
  assertPocketIcRuntimeDescriptor,
  readLivePocketIcSupervisorOwner,
  servePocketIc,
  verifyPocketIcRuntime,
  type LaunchedPocketIcProcess,
  type PocketIcProcessExit,
  type PocketIcProcessHost,
  type PocketIcRuntimeDescriptor,
} from "../src/pocketic_supervisor.ts";
import {
  jsonResponse,
  pocketIcCreatedResponse,
  pocketIcTestTopology,
} from "./pocketic_test_fixture.ts";

describe("PocketIC supervisor", () => {
  test("holds one lifetime lock, launches one exact server, publishes one descriptor, attaches, and stops cleanly", async () => {
    await withTempDirectory(async (root) => {
      const processHost = new FakeProcessHost();
      const topology = pocketIcTestTopology();
      const rootKey = new Uint8Array([9, 8, 7, 6]);
      const requests: Array<{ method: string; pathname: string; origin: string }> = [];
      let instanceState = "Available";
      const fetcher = async (
        input: string | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        const url = new URL(input);
        const method = init?.method ?? "GET";
        requests.push({ method, pathname: url.pathname, origin: url.origin });
        if (url.origin === "http://127.0.0.1:8000") {
          return new Response(
            arrayBuffer(Cbor.encode({
              root_key: rootKey,
              replica_health_status: "healthy",
            })),
            { status: 200, headers: { "Content-Type": "application/cbor" } },
          );
        }
        if (url.pathname === "/status") return new Response(null, { status: 200 });
        if (url.pathname === "/instances" && method === "POST") {
          return jsonResponse(pocketIcCreatedResponse(topology));
        }
        if (url.pathname === "/instances" && method === "GET") {
          return jsonResponse([instanceState]);
        }
        if (url.pathname === "/instances/0/read/topology") {
          return jsonResponse(topology);
        }
        if (url.pathname === "/instances/0/auto_progress") {
          return jsonResponse(true);
        }
        if (
          url.pathname === "/instances/0/stop_progress" ||
          url.pathname === "/http_gateway/0/stop"
        ) {
          return jsonResponse(null);
        }
        if (url.pathname === "/instances/0" && method === "DELETE") {
          return new Response(null, { status: 200 });
        }
        throw new Error(`Unexpected request ${method} ${url}`);
      };
      const lockPath = path.join(root, "runtime", "supervisor.lock");
      const ownerSessionPath = path.join(root, "local.ndeploy.session.json");
      let published: PocketIcRuntimeDescriptor | undefined;
      const fixtureId = Principal.selfAuthenticating(new Uint8Array(32).fill(77)).toText();

      const handle = await servePocketIc({
        profile: "full_protocol_fixtures",
        lockPath,
        ownerSessionPath,
        runtimeDirectory: path.join(root, "runtime"),
        stateDirectory: path.join(root, "state"),
        binary: pinnedBinary(),
        processHost,
        fetcher,
        fixtures: { update_source: fixtureId },
        now: () => new Date("2026-07-22T12:00:00.000Z"),
        healthIntervalMs: 1,
        stopTimeoutMs: 100,
        publishDescriptor: async (descriptor) => {
          published = descriptor;
        },
      });

      expect(published).toEqual(handle.descriptor);
      expect(handle.descriptor).toMatchObject({
        profile: "full_protocol_fixtures",
        serverVersion: POCKET_IC_SERVER_VERSION,
        pid: FakeProcessHost.SERVER_PID,
        idleTtlSeconds: POCKET_IC_IDLE_TTL_SECONDS,
        controlUrl: "http://127.0.0.1:41000/",
        instanceId: 0,
        gateway: {
          id: 0,
          url: "http://localhost:8000/",
          bind: "127.0.0.1",
          port: 8000,
        },
        rootKeyBase64: Buffer.from(rootKey).toString("base64"),
        fixtures: { update_source: fixtureId },
      });
      expect(processHost.launches).toEqual([
        {
          command: "/verified/pocket-ic",
          args: [
            "--ttl",
            POCKET_IC_IDLE_TTL_SECONDS.toString(),
            "--port-file",
            processHost.portFile,
            "--log-levels",
            "error",
          ],
        },
      ]);
      await expect(access(lockPath)).resolves.toBeNull();
      await expect(
        readLivePocketIcSupervisorOwner(
          lockPath,
          processHost.processIdentity.bind(processHost),
        ),
      ).resolves.toEqual({
        pid: process.pid,
        processIdentity: `test:${process.pid}:1`,
        ownerSessionPath,
      });
      await expect(
        acquirePocketIcSupervisorLock(
          lockPath,
          ownerSessionPath,
          processHost.processIdentity.bind(processHost),
        ),
      ).rejects.toThrow("already running");

      const attachment = await verifyPocketIcRuntime(handle.descriptor, {
        processHost,
        fetcher,
        expectedBinarySha256: pinnedBinary().sha256,
      });
      expect(attachment.topology).toEqual(topology);
      expect(attachment.gatewayStatus.rootKeyBase64).toBe(
        Buffer.from(rootKey).toString("base64"),
      );
      instanceState =
        'Busy(StateLabel(9A5700), OpId("advance_time_and_tick(10ms)"))';
      await expect(
        verifyPocketIcRuntime(handle.descriptor, { processHost, fetcher }),
      ).resolves.toMatchObject({ descriptor: handle.descriptor });

      const waiting = handle.wait();
      await new Promise((resolve) => setTimeout(resolve, 5));
      await handle.stop();
      await waiting;
      await expect(access(lockPath)).rejects.toThrow();
      expect(processHost.terminated).toEqual([FakeProcessHost.SERVER_PID]);
      expect(requests).toContainEqual({
        method: "POST",
        pathname: "/instances/0/stop_progress",
        origin: "http://127.0.0.1:41000",
      });
      expect(requests).toContainEqual({
        method: "POST",
        pathname: "/http_gateway/0/stop",
        origin: "http://127.0.0.1:41000",
      });
      expect(requests).toContainEqual({
        method: "DELETE",
        pathname: "/instances/0",
        origin: "http://127.0.0.1:41000",
      });

      const afterStop = await acquirePocketIcSupervisorLock(
        lockPath,
        ownerSessionPath,
        processHost.processIdentity.bind(processHost),
      );
      await afterStop.release();
    });
  });

  test("strict descriptor validator rejects unknown data, topology/config drift, and bad fixtures", async () => {
    await withTempDirectory(async (root) => {
      const processHost = new FakeProcessHost();
      const topology = pocketIcTestTopology();
      const fetcher = healthyFetcher(topology);
      const handle = await servePocketIc({
        profile: "full_protocol_fixtures",
        lockPath: path.join(root, "supervisor.lock"),
        ownerSessionPath: path.join(root, "local.ndeploy.session.json"),
        runtimeDirectory: path.join(root, "runtime"),
        stateDirectory: path.join(root, "state"),
        binary: pinnedBinary(),
        processHost,
        fetcher,
        stopTimeoutMs: 100,
      });
      try {
        const unknown = clone(handle.descriptor) as Record<string, unknown>;
        unknown.surprise = true;
        expect(() => assertPocketIcRuntimeDescriptor(unknown)).toThrow(
          "fields must be exactly",
        );

        const changedState = clone(handle.descriptor);
        changedState.stateDirectory = path.join(root, "different-state");
        expect(() => assertPocketIcRuntimeDescriptor(changedState)).toThrow(
          "instanceConfigDigest does not match",
        );

        const badFixture = clone(handle.descriptor);
        badFixture.fixtures = { "Bad Fixture": "aaaaa-aa" };
        expect(() => assertPocketIcRuntimeDescriptor(badFixture)).toThrow(
          "fixture name",
        );

        const wrongProcess = clone(handle.descriptor);
        wrongProcess.processIdentity = "test:other-process";
        await expect(
          verifyPocketIcRuntime(wrongProcess, { processHost, fetcher }),
        ).rejects.toThrow("process identity does not match");
      } finally {
        await handle.stop();
      }
    });
  });

  test("preserves a live lock published while another process retires a stale owner", async () => {
    await withTempDirectory(async (root) => {
      const lockPath = path.join(root, "supervisor.lock");
      const ownerSessionPath = path.join(root, "local.ndeploy.session.json");
      const stalePid = 70_001;
      await writeFile(
        lockPath,
        `${JSON.stringify({
          schema: 1,
          pid: stalePid,
          processIdentity: `test:${stalePid}:old`,
          ownerSessionPath,
          nonce: "a".repeat(32),
          acquiredAt: "2026-07-22T12:00:00.000Z",
        })}\n`,
        { mode: 0o600 },
      );

      let releaseFirstStaleCheck!: () => void;
      const firstStaleCheckBlocked = new Promise<void>((resolve) => {
        releaseFirstStaleCheck = resolve;
      });
      let signalFirstStaleCheck!: () => void;
      const firstStaleCheckReached = new Promise<void>((resolve) => {
        signalFirstStaleCheck = resolve;
      });
      let staleChecks = 0;
      const processIdentity = async (pid: number): Promise<string | null> => {
        if (pid === process.pid) return `test:${process.pid}:live`;
        if (pid !== stalePid) return null;
        staleChecks += 1;
        if (staleChecks === 1) {
          signalFirstStaleCheck();
          await firstStaleCheckBlocked;
        }
        return null;
      };

      const first = acquirePocketIcSupervisorLock(
        lockPath,
        ownerSessionPath,
        processIdentity,
      );
      await firstStaleCheckReached;
      const second = await acquirePocketIcSupervisorLock(
        lockPath,
        ownerSessionPath,
        processIdentity,
      );
      const secondContents = await readFile(lockPath, "utf8");

      releaseFirstStaleCheck();
      await expect(first).rejects.toThrow(
        "lock changed while retiring stale owner",
      );
      expect(await readFile(lockPath, "utf8")).toBe(secondContents);

      await second.release();
      await expect(access(lockPath)).rejects.toThrow();
    });
  });
});

class FakeProcessHost implements PocketIcProcessHost {
  static readonly SERVER_PID = 4242;
  readonly launches: Array<{ command: string; args: string[] }> = [];
  readonly terminated: number[] = [];
  portFile = "";
  #serverIdentity: string | null = null;
  #resolveExit: ((exit: PocketIcProcessExit) => void) | undefined;

  async launch(
    command: string,
    args: readonly string[],
  ): Promise<LaunchedPocketIcProcess> {
    this.launches.push({ command, args: [...args] });
    const portIndex = args.indexOf("--port-file");
    if (portIndex < 0 || args[portIndex + 1] === undefined) {
      throw new Error("Missing port file argument");
    }
    this.portFile = args[portIndex + 1]!;
    await writeFile(this.portFile, "41000\n", { mode: 0o600 });
    this.#serverIdentity = `test:${FakeProcessHost.SERVER_PID}:1`;
    const exited = new Promise<PocketIcProcessExit>((resolve) => {
      this.#resolveExit = resolve;
    });
    return { pid: FakeProcessHost.SERVER_PID, exited };
  }

  async processIdentity(pid: number): Promise<string | null> {
    if (pid === process.pid) return `test:${process.pid}:1`;
    if (pid === FakeProcessHost.SERVER_PID) return this.#serverIdentity;
    return null;
  }

  async terminate(pid: number): Promise<void> {
    this.terminated.push(pid);
    if (pid === FakeProcessHost.SERVER_PID) {
      this.#serverIdentity = null;
      this.#resolveExit?.({ code: 0, signal: "SIGTERM" });
    }
  }
}

function pinnedBinary(): ResolvedPocketIcBinary {
  return {
    path: "/verified/pocket-ic",
    version: POCKET_IC_SERVER_VERSION,
    sha256: POCKET_IC_ARTIFACTS[0]!.binarySha256,
    artifactUrl: POCKET_IC_ARTIFACTS[0]!.url,
  };
}

function healthyFetcher(topology: ReturnType<typeof pocketIcTestTopology>) {
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    if (url.origin === "http://127.0.0.1:8000") {
      return new Response(
        arrayBuffer(Cbor.encode({
          root_key: new Uint8Array([1, 2, 3]),
          replica_health_status: "healthy",
        })),
      );
    }
    if (url.pathname === "/status") return new Response(null, { status: 200 });
    if (url.pathname === "/instances" && method === "POST") {
      return jsonResponse(pocketIcCreatedResponse(topology));
    }
    if (url.pathname === "/instances/0/auto_progress") return jsonResponse(true);
    if (
      url.pathname === "/instances/0/stop_progress" ||
      url.pathname === "/http_gateway/0/stop"
    ) {
      return jsonResponse(null);
    }
    if (url.pathname === "/instances/0" && method === "DELETE") {
      return new Response(null, { status: 200 });
    }
    throw new Error(`Unexpected request ${method} ${url}`);
  };
}

function clone(descriptor: PocketIcRuntimeDescriptor): PocketIcRuntimeDescriptor {
  return JSON.parse(JSON.stringify(descriptor)) as PocketIcRuntimeDescriptor;
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}

async function withTempDirectory(
  operation: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "neutron-pocketic-supervisor-"));
  try {
    await operation(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
