import esbuild from "esbuild";
import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { packageMotoko } from "neutron-scripts/src/mopack.js";
import { packDirectory } from "neutron-scripts/src/pack.js";

export const BLAST_QUALIFICATION_AGENT_ID =
  "blast_qualification_agent" as const;
export const BLAST_QUALIFICATION_ENTRYPOINT =
  "qualification_turn" as const;

const manifest = Object.freeze({
  format: 3,
  name: "Blast Qualifier",
  id: BLAST_QUALIFICATION_AGENT_ID,
  version: 100,
  description:
    "Disposable installed-browser driver for Blast release qualification",
  src: "main.mo",
  background: {
    path: "service.html",
    description: "Disposable Agent MessagePort qualification endpoint",
  },
  capabilities: {
    agent_entrypoints: {
      api: 1,
      entrypoints: [BLAST_QUALIFICATION_ENTRYPOINT],
    },
    background_ui_requests: {
      api: 1,
      categories: ["frontend_tool", "signed_canister_call"],
    },
  },
  tiles: [
    {
      id: "driver",
      title: "Blast Qualification",
      path: "index.html",
      description: "Drive one trusted Blast qualification turn",
    },
  ],
  func: {},
});

const backendSource = `module {
  public class Init() {};
};
`;

const serviceSource = `
import {
  exposeTool,
  isJsonObject,
} from "neutron-tools/app";

const TARGET = "app:blast:background";
const ENTRYPOINT = "${BLAST_QUALIFICATION_ENTRYPOINT}";

exposeTool(
  ENTRYPOINT,
  {
    title: "Qualify Blast",
    description: "Run one disposable installed Blast qualification turn.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["discover", "call"] },
        tool: { type: "string", minLength: 1, maxLength: 128 },
        arguments: { type: "object" },
        consentDecision: { type: "string", enum: ["allow", "deny"] },
      },
      additionalProperties: false,
    },
    outputSchema: {},
    annotations: { "neutron:effects": ["read", "write"] },
  },
  async (args, context) => {
    if (context.caller?.appId !== "${BLAST_QUALIFICATION_AGENT_ID}" ||
        context.caller.role !== "tile") {
      throw new Error("Qualification entrypoint requires its own tile");
    }
    if (!context.agentConsent) {
      throw new Error("Qualification entrypoint lacks Agent provenance");
    }
    if (args.action !== "discover" && args.action !== "call") {
      throw new Error("Invalid qualification action");
    }
    const signedCallDecision = args.consentDecision === "deny" ? "deny" : "allow";
    const challenges = [];
    const unregister = context.agentConsent.register((challenge) => {
      const decision = challenge.kind === "signed_canister_call"
        ? signedCallDecision
        : "allow";
      challenges.push({
        kind: challenge.kind,
        persistence: challenge.persistence,
        risk: challenge.risk,
        requesterAppId: challenge.requester.appId,
        decision,
      });
      return {
        decision,
        reason: decision === "allow"
          ? "Allowed by the deterministic Blast qualification"
          : "Denied by the deterministic Blast qualification",
      };
    });
    try {
      const descriptors = await context.kernel.listTools(TARGET, 30);
      const toolNames = descriptors.map((descriptor) => descriptor.name);
      if (args.action === "discover") {
        const [apps, endpoints] = await Promise.all([
          context.kernel.listApps(30),
          context.kernel.listEndpoints(30),
        ]);
        const appIds = isJsonObject(apps) && Array.isArray(apps.apps)
          ? apps.apps.flatMap((entry) =>
              isJsonObject(entry) && typeof entry.id === "string"
                ? [entry.id]
                : [])
          : [];
        const blastEndpoints = isJsonObject(endpoints) &&
            Array.isArray(endpoints.endpoints)
          ? endpoints.endpoints.filter((entry) =>
              isJsonObject(entry) &&
              entry.appId === "blast" &&
              entry.role === "background" &&
              entry.connected === true)
          : [];
        const discovery = { appIds, blastEndpoints, toolNames };
        return { discovery, challenges };
      }
      if (typeof args.tool !== "string" || !isJsonObject(args.arguments)) {
        throw new Error("Qualification call requires a tool and arguments");
      }
      if (!toolNames.includes(args.tool)) {
        throw new Error("Qualification selected an undiscovered Blast tool");
      }
      try {
        const result = await context.kernel.callTool(
          {
            target: TARGET,
            name: args.tool,
            arguments: args.arguments,
          },
          { timeout: 120, signal: context.signal },
        );
        return { result, error: null, challenges };
      } catch (error) {
        const candidate = error && typeof error === "object" ? error : null;
        return {
          result: null,
          error: {
            message: error instanceof Error ? error.message : String(error),
            ...(candidate && typeof candidate.code === "string"
              ? { code: candidate.code }
              : {}),
          },
          challenges,
        };
      }
    } finally {
      unregister();
    }
  },
);
`;

const tileSource = `
import {
  createMsgBusClient,
  requestAgentMode,
} from "neutron-tools/app";

const TARGET = "app:${BLAST_QUALIFICATION_AGENT_ID}:background";
const ENTRYPOINT = "${BLAST_QUALIFICATION_ENTRYPOINT}";
const bus = createMsgBusClient();
let prepared = null;
let pending = false;
let result = null;
let error = null;
let activeController = null;

Object.defineProperty(globalThis, "__BLAST_QUALIFICATION_AGENT__", {
  configurable: false,
  enumerable: false,
  writable: false,
  value: Object.freeze({
    prepare(value) {
      prepared = JSON.parse(JSON.stringify(value));
      result = null;
      error = null;
    },
    inspect() {
      return JSON.parse(JSON.stringify({ pending, result, error }));
    },
    cancel() {
      if (!activeController) return false;
      activeController.abort();
      return true;
    },
  }),
});

document.querySelector("[data-action=enable]").addEventListener("click", async () => {
  error = null;
  try {
    await requestAgentMode(ENTRYPOINT);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
});

document.querySelector("[data-action=run]").addEventListener("click", async () => {
  if (pending) return;
  if (!prepared || typeof prepared !== "object") {
    error = "No qualification turn is prepared";
    return;
  }
  pending = true;
  result = null;
  error = null;
  const controller = new AbortController();
  activeController = controller;
  try {
    result = await bus.callTool(
      { target: TARGET, name: ENTRYPOINT, arguments: prepared },
      { timeout: 180, signal: controller.signal },
    );
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (activeController === controller) activeController = null;
    pending = false;
  }
});
`;

const tileHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'">
    <title>Blast Qualification</title>
    <style>body{font:16px system-ui;margin:20px}button{margin-right:12px;padding:10px 14px}</style>
  </head>
  <body>
    <main>
      <button type="button" data-action="enable">Enable Agent Mode</button>
      <button type="button" data-action="run">Run prepared turn</button>
    </main>
    <script type="module" src="tile.js"></script>
  </body>
</html>
`;

const serviceHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; connect-src 'self'">
    <title>Blast Qualification Agent</title>
  </head>
  <body><script type="module" src="service.js"></script></body>
</html>
`;

export async function buildBlastQualificationAgentArchive(input: {
  repositoryRoot: string;
  temporaryRoot: string;
}): Promise<string> {
  const packageRoot = path.join(input.temporaryRoot, "qualification-agent");
  const backendRoot = path.join(packageRoot, "backend");
  const webRoot = path.join(packageRoot, "dist", "web");
  const staticRoot = path.join(webRoot, "static");
  await mkdir(backendRoot, { recursive: true, mode: 0o700 });
  await mkdir(staticRoot, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(
      path.join(packageRoot, "neutron.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    ),
    writeFile(path.join(backendRoot, "main.mo"), backendSource, {
      mode: 0o600,
    }),
  ]);
  await packageMotoko({ cwd: packageRoot, packages: {} });
  await removeArchiveOnlyMarker(packageRoot);
  try {
    await Promise.all([
      esbuild.build({
        absWorkingDir: input.repositoryRoot,
        bundle: true,
        conditions: ["browser", "import", "default"],
        format: "esm",
        minify: true,
        outfile: path.join(webRoot, "service.js"),
        platform: "browser",
        stdin: {
          contents: serviceSource,
          loader: "ts",
          resolveDir: input.repositoryRoot,
          sourcefile: "blast-qualification-service.ts",
        },
      }),
      esbuild.build({
        absWorkingDir: input.repositoryRoot,
        bundle: true,
        conditions: ["browser", "import", "default"],
        format: "esm",
        minify: true,
        outfile: path.join(webRoot, "tile.js"),
        platform: "browser",
        stdin: {
          contents: tileSource,
          loader: "ts",
          resolveDir: input.repositoryRoot,
          sourcefile: "blast-qualification-tile.ts",
        },
      }),
      writeFile(path.join(webRoot, "index.html"), tileHtml, { mode: 0o600 }),
      writeFile(path.join(webRoot, "service.html"), serviceHtml, {
        mode: 0o600,
      }),
      writeFile(
        path.join(staticRoot, "icon.png"),
        await readFile(
          path.join(input.repositoryRoot, "apps", "hello", "public", "static", "icon.png"),
        ),
        { mode: 0o600 },
      ),
    ]);
  } finally {
    await esbuild.stop();
  }
  return await packDirectory(packageRoot);
}

async function removeArchiveOnlyMarker(packageRoot: string): Promise<void> {
  const manifestPath = path.join(packageRoot, "dist", "neutron.json");
  const packaged = JSON.parse(await readFile(manifestPath, "utf8")) as {
    package_features?: unknown;
  };
  if (
    !Array.isArray(packaged.package_features) ||
    packaged.package_features.length !== 1 ||
    packaged.package_features[0] !== "archive-only-legal-v1"
  ) {
    throw new Error(
      "Blast qualification agent has an unexpected source-delivery marker",
    );
  }
  delete packaged.package_features;
  await writeFile(manifestPath, `${JSON.stringify(packaged, null, 2)}\n`, {
    mode: 0o600,
  });
}
