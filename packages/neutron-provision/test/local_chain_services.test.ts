import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ensureLocalChainServices,
  localChainServicePaths,
  type LocalCommandRunner,
} from "../src/local_chain_services.ts";

describe("persistent local chain services", () => {
  test("derives one provision-owned runtime beside PocketIC state", () => {
    expect(localChainServicePaths("/repo/.neutron/pocketic")).toEqual({
      root: "/repo/.neutron/runtime/chains",
      bitcoinRoot: "/repo/.neutron/runtime/chains/bitcoin",
      bitcoinDataRoot: "/repo/.neutron/runtime/chains/bitcoin/data",
      bitcoinPidPath: "/repo/.neutron/runtime/chains/bitcoin/bitcoind.pid",
      bitcoinOwnerPath: "/repo/.neutron/runtime/chains/bitcoin/owner.json",
      bitcoinLogPath: "/repo/.neutron/runtime/chains/bitcoin/debug.log",
      anvilRoot: "/repo/.neutron/runtime/chains/anvil",
      anvilPidPath: "/repo/.neutron/runtime/chains/anvil/anvil.pid",
      anvilOwnerPath: "/repo/.neutron/runtime/chains/anvil/owner.json",
      anvilLogPath: "/repo/.neutron/runtime/chains/anvil/anvil.log",
      anvilStatePath: "/repo/.neutron/runtime/chains/anvil/state.json",
    });
  });

  test("starts cold Bitcoin and Anvil before reporting their verified endpoints", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "neutron-chain-services-"));
    const stateDirectory = path.join(root, ".neutron", "pocketic");
    let bitcoinRunning = false;
    let anvilRunning = false;
    const commands: Array<{ command: string; args: readonly string[] }> = [];
    const spawns: Array<{ command: string; args: readonly string[] }> = [];
    const run: LocalCommandRunner = async (command, args, allowFailure) => {
      commands.push({ command, args });
      if (command === "/tools/bitcoind") {
        const pidPath = args.find((argument) => argument.startsWith("-pid="))?.slice(5);
        if (!pidPath) throw new Error("missing Bitcoin PID path");
        await writeFile(pidPath, "43\n", { mode: 0o600 });
        bitcoinRunning = true;
        return success("");
      }
      if (args.includes("getblockchaininfo")) {
        return bitcoinRunning
          ? success('{"chain":"regtest"}')
          : failure("not running", allowFailure);
      }
      if (args.includes("getwalletinfo")) {
        return success("{}");
      }
      throw new Error(`Unexpected command ${command} ${args.join(" ")}`);
    };
    try {
      const dependencies = {
        run,
        resolveBitcoinTools: async () => ({
          bitcoind: "/tools/bitcoind",
          cli: "/tools/bitcoin-cli",
        }),
        anvilExecutable: process.execPath,
        spawnDetached: async ({ command, args }: {
          command: string;
          args: readonly string[];
        }) => {
          spawns.push({ command, args });
          anvilRunning = true;
          return 42;
        },
        fetcher: (async (_input: unknown, init?: RequestInit) => {
          if (!anvilRunning) throw new Error("not running");
          const request = JSON.parse(String(init?.body)) as { method: string };
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result:
                request.method === "eth_accounts"
                  ? ["0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"]
                  : "0x1",
            }),
          );
        }) as unknown as typeof fetch,
        processIdentity: async (pid: number) =>
          pid === 42 || pid === 43 ? `test:${pid}:1` : null,
        tcpListener: async (_host: string, port: number) =>
          port === 8545 ? anvilRunning : bitcoinRunning,
        sleep: async () => {},
      };
      const services = await ensureLocalChainServices(
        { stateDirectory, logger: { log() {} } },
        dependencies,
      );

      expect(services.bitcoin.p2pAddress).toBe("127.0.0.1:18444");
      expect(services.ethereum).toMatchObject({
        rpcUrl: "http://127.0.0.1:8545",
        chainId: 1,
      });
      const daemon = commands.find(({ command }) => command === "/tools/bitcoind");
      expect(daemon?.args).toContain("-regtest");
      expect(daemon?.args).toContain("-bind=127.0.0.1:18444");
      expect(spawns).toHaveLength(1);
      expect(spawns[0]!.args).toContain("--state");
      expect(spawns[0]!.args).toContain(
        path.join(root, ".neutron", "runtime", "chains", "anvil", "state.json"),
      );
      await expect(
        ensureLocalChainServices(
          { stateDirectory, logger: { log() {} } },
          dependencies,
        ),
      ).resolves.toEqual(services);
      expect(spawns).toHaveLength(1);
      expect(
        commands.filter(({ command }) => command === "/tools/bitcoind"),
      ).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a process on the Anvil port with the wrong chain", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "neutron-chain-services-"));
    const stateDirectory = path.join(root, ".neutron", "pocketic");
    const paths = localChainServicePaths(stateDirectory);
    try {
      await writeOwnedService(paths.bitcoinRoot, paths.bitcoinPidPath, paths.bitcoinOwnerPath, {
        service: "bitcoin",
        pid: 51,
        processIdentity: "test:51:1",
        statePath: paths.bitcoinDataRoot,
      });
      await writeOwnedService(paths.anvilRoot, paths.anvilPidPath, paths.anvilOwnerPath, {
        service: "anvil",
        pid: 52,
        processIdentity: "test:52:1",
        statePath: paths.anvilStatePath,
      });
      await expect(
        ensureLocalChainServices(
          {
            stateDirectory,
            logger: { log() {} },
          },
          {
            resolveBitcoinTools: async () => ({
              bitcoind: "/tools/bitcoind",
              cli: "/tools/bitcoin-cli",
            }),
            run: async (_command, args) =>
              args.includes("getblockchaininfo")
                ? success('{"chain":"regtest"}')
                : success("{}"),
            fetcher: (async () =>
              new Response(
                JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x7a69" }),
              )) as unknown as typeof fetch,
            processIdentity: async (pid) =>
              pid === 51 || pid === 52 ? `test:${pid}:1` : null,
            tcpListener: async () => true,
          },
        ),
      ).rejects.toThrow("ckETH requires chain 1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects compatible Bitcoin and Anvil RPC listeners without owned process records", async () => {
    const bitcoinRoot = await mkdtemp(
      path.join(tmpdir(), "neutron-foreign-bitcoin-"),
    );
    const anvilRoot = await mkdtemp(path.join(tmpdir(), "neutron-foreign-anvil-"));
    try {
      const bitcoinStateDirectory = path.join(
        bitcoinRoot,
        ".neutron",
        "pocketic",
      );
      const bitcoinPaths = localChainServicePaths(bitcoinStateDirectory);
      await writeOwnedService(
        bitcoinPaths.anvilRoot,
        bitcoinPaths.anvilPidPath,
        bitcoinPaths.anvilOwnerPath,
        {
          service: "anvil",
          pid: 53,
          processIdentity: "test:53:1",
          statePath: bitcoinPaths.anvilStatePath,
        },
      );
      await expect(
        ensureLocalChainServices(
          {
            stateDirectory: bitcoinStateDirectory,
            logger: { log() {} },
          },
          {
            resolveBitcoinTools: async () => ({
              bitcoind: "/tools/bitcoind",
              cli: "/tools/bitcoin-cli",
            }),
            run: async (_command, args) =>
              args.includes("getblockchaininfo")
                ? success('{"chain":"regtest"}')
                : success("{}"),
            fetcher: healthyAnvilFetcher,
            processIdentity: async (pid) =>
              pid === 53 ? "test:53:1" : null,
            tcpListener: async (_host, port) => port === 18443,
          },
        ),
      ).rejects.toThrow("without provision-owned process metadata");

      await expect(
        ensureLocalChainServices(
          {
            stateDirectory: path.join(anvilRoot, ".neutron", "pocketic"),
            logger: { log() {} },
          },
          {
            resolveBitcoinTools: async () => ({
              bitcoind: "/tools/bitcoind",
              cli: "/tools/bitcoin-cli",
            }),
            run: async () => success("{}"),
            fetcher: (async (_input: unknown, init?: RequestInit) => {
              const request = JSON.parse(String(init?.body)) as { method: string };
              return new Response(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  result:
                    request.method === "eth_accounts"
                      ? ["0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"]
                      : "0x1",
                }),
              );
            }) as unknown as typeof fetch,
            processIdentity: async () => null,
            tcpListener: async () => true,
          },
        ),
      ).rejects.toThrow("without provision-owned process metadata");
    } finally {
      await rm(bitcoinRoot, { recursive: true, force: true });
      await rm(anvilRoot, { recursive: true, force: true });
    }
  });

  test("rejects PID reuse and state-directory drift in owned service records", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "neutron-chain-owner-drift-"));
    const stateDirectory = path.join(root, ".neutron", "pocketic");
    const paths = localChainServicePaths(stateDirectory);
    try {
      await writeOwnedService(paths.anvilRoot, paths.anvilPidPath, paths.anvilOwnerPath, {
        service: "anvil",
        pid: 61,
        processIdentity: "test:61:old",
        statePath: paths.anvilStatePath,
      });
      await expect(
        ensureLocalChainServices(
          { stateDirectory, logger: { log() {} } },
          {
            resolveBitcoinTools: async () => ({
              bitcoind: "/tools/bitcoind",
              cli: "/tools/bitcoin-cli",
            }),
            run: async () => success("{}"),
            fetcher: healthyAnvilFetcher,
            processIdentity: async (pid) =>
              pid === 61 ? "test:61:reused" : null,
            tcpListener: async () => true,
          },
        ),
      ).rejects.toThrow("process identity does not match");

      await writeOwnedService(paths.anvilRoot, paths.anvilPidPath, paths.anvilOwnerPath, {
        service: "anvil",
        pid: 61,
        processIdentity: "test:61:reused",
        statePath: path.join(root, "other-state.json"),
      });
      await expect(
        ensureLocalChainServices(
          { stateDirectory, logger: { log() {} } },
          {
            resolveBitcoinTools: async () => ({
              bitcoind: "/tools/bitcoind",
              cli: "/tools/bitcoin-cli",
            }),
            run: async () => success("{}"),
            fetcher: healthyAnvilFetcher,
            processIdentity: async (pid) =>
              pid === 61 ? "test:61:reused" : null,
            tcpListener: async () => true,
          },
        ),
      ).rejects.toThrow("process metadata belongs to");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const healthyAnvilFetcher = (async (
  _input: unknown,
  init?: RequestInit,
) => {
  const request = JSON.parse(String(init?.body)) as { method: string };
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result:
        request.method === "eth_accounts"
          ? ["0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"]
          : "0x1",
    }),
  );
}) as unknown as typeof fetch;

async function writeOwnedService(
  root: string,
  pidPath: string,
  ownerPath: string,
  owner: {
    service: "bitcoin" | "anvil";
    pid: number;
    processIdentity: string;
    statePath: string;
  },
): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (owner.service === "bitcoin") {
    await mkdir(owner.statePath, { recursive: true, mode: 0o700 });
  }
  await writeFile(pidPath, `${owner.pid}\n`, { mode: 0o600 });
  await writeFile(
    ownerPath,
    `${JSON.stringify({ schema: 1, ...owner })}\n`,
    { mode: 0o600 },
  );
}

function success(stdout: string) {
  return { stdout, stderr: "", exitCode: 0 };
}

function failure(stderr: string, allowFailure: boolean | undefined) {
  if (!allowFailure) throw new Error(stderr);
  return { stdout: "", stderr, exitCode: 1 };
}
