import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  preparePackageInstall,
  unpackNeutronPackage,
} from "neutron-compiler/src/install.ts";
import {
  generateAppMethodSchemaArtifact,
  validateAppMethodArgs,
} from "neutron-scripts/src/method_schema.js";
import type { NeutronManifest } from "neutron-tools/src/schema.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";

const manifestUrl = new URL("../neutron.json", import.meta.url);
const backendUrl = new URL("../backend/main.mo", import.meta.url);
const rulesUrl = new URL("../backend/Rules.mo", import.meta.url);
const memoryUrl = new URL("../backend/memory/chess/v1.mo", import.meta.url);
const htmlUrl = new URL("../dist/web/index.html", import.meta.url);
const cssUrl = new URL("../dist/web/main.css", import.meta.url);
const jsUrl = new URL("../dist/web/main.js", import.meta.url);
const serviceHtmlUrl = new URL("../dist/web/service.html", import.meta.url);
const serviceJsUrl = new URL("../dist/web/service.js", import.meta.url);
const serviceSourceUrl = new URL("../src/service.ts", import.meta.url);
const uiSourceUrl = new URL("../src/index.tsx", import.meta.url);
const packageUrl = new URL("../chess.v0.3.2.neutron", import.meta.url);

async function readManifest(): Promise<NeutronManifest> {
  return JSON.parse(await readFile(manifestUrl, "utf8")) as NeutronManifest;
}

test("Chess declares per-tile games, managed memory, and narrow remote access", async () => {
  const manifest = await readManifest();
  expect(validate_neutron_conf(manifest).errors).toEqual([]);
  expect(manifest).toMatchObject({
    format: 3,
    id: "chess",
    name: "Chess",
    version: 302,
    update_source: "233tv-xiaaa-aaaay-aacta-cai",
    backend: {
      capabilities: {
        backend_calls: { api: 1 },
      },
    },
    capabilities: {
      public_ingress: {
        api: 1,
        routes: [
          {
            protocol: "chess_v1",
            id: "exchange",
            handler: "chess_remote_exchange_v1",
            mode: "update",
            caller: "canister",
            max_request_bytes: 65536,
            max_response_bytes: 32768,
            max_calls_per_hour: 240,
            required_cycles: 400000000,
          },
        ],
      },
      preapproved_self_calls: {
        api: 1,
        methods: [
          "chess_get_game",
          "chess_remote_push_target",
          "chess_create_game",
          "chess_move",
          "chess_sync_game",
          "chess_join_game",
          "chess_action",
          "chess_undo",
        ],
      },
      backend_calls: {
        api: 1,
        reservation_scopes: ["exact"],
        max_concurrency: 8,
        max_cycles_per_call: 400000000,
        max_cycles_per_day: 2304000000000,
      },
    },
    background: {
      path: "service.html",
      description: "Expose live local Chess games to approved Neutron agents",
    },
    tiles: [{ id: "board", path: "index.html", icon: "static/icon.svg" }],
    memory: { chess: { version: 1 } },
  });
  expect(manifest).not.toHaveProperty("init_arg");
  expect(manifest.func?.chess_remote_exchange_v1).toMatchObject({
    type: "update",
    async: false,
    arg: ["caller"],
  });
  expect(manifest.func?.chess_remote_exchange_v1).not.toHaveProperty("allow");
});

test("Chess emits schemas for its complete local and remote API", async () => {
  const artifact = generateAppMethodSchemaArtifact(
    await readManifest(),
    await readFile(backendUrl, "utf8"),
  );
  expect(artifact.app).toEqual({ id: "chess", name: "Chess", version: 302 });
  expect(Object.keys(artifact.methods).sort()).toEqual([
    "chess_action",
    "chess_create_game",
    "chess_get_game",
    "chess_join_game",
    "chess_move",
    "chess_remote_exchange_v1",
    "chess_remote_push_target",
    "chess_sync_game",
    "chess_undo",
  ]);
  expect(artifact.methods.chess_create_game).toMatchObject({
    type: "update",
    input: { type: "array", minItems: 1, maxItems: 1 },
    output: {
      type: "object",
      properties: {
        tile_id: { type: "string" },
        rows: { type: "array", items: { type: "string" } },
        legal_moves: { type: "array" },
      },
    },
  });
  expect(artifact.methods.chess_remote_exchange_v1).toMatchObject({
    type: "update",
  });
  expect(artifact.methods.chess_remote_exchange_v1).not.toHaveProperty("allow");
  expect(
    validateAppMethodArgs(artifact, "chess_create_game", [
      {
        tile_id: "tile-a",
        game_id: "00112233445566778899aabbccddeeff",
        mode: "local",
      },
    ]).valid,
  ).toBe(true);
  expect(
    validateAppMethodArgs(artifact, "chess_move", [
      {
        tile_id: "tile-a",
        from: "e2",
        to: "e4",
        expected_revision: "0",
        expected_game_id: "00112233445566778899aabbccddeeff",
        local_only: true,
      },
    ]).valid,
  ).toBe(true);
  expect(
    validateAppMethodArgs(artifact, "chess_move", [
      {
        tile_id: "tile-a",
        from: "e2",
        to: "e4",
        expected_revision: "0",
        expected_game_id: null,
        local_only: true,
      },
    ]).valid,
  ).toBe(false);
  expect(
    validateAppMethodArgs(artifact, "chess_move", [
      {
        tile_id: "tile-a",
        from: "e2",
        to: "e4",
        expected_revision: "0",
      },
    ]).valid,
  ).toBe(true);
  expect(
    validateAppMethodArgs(artifact, "chess_move", [
      {
        tile_id: "tile-a",
        from: "e2",
        to: "e4",
        promotion: null,
        expected_revision: "0",
      },
    ]).valid,
  ).toBe(false);
});

test("Chess ships authoritative rules and self-contained managed memory", async () => {
  const [backend, rules, memory] = await Promise.all([
    readFile(backendUrl, "utf8"),
    readFile(rulesUrl, "utf8"),
    readFile(memoryUrl, "utf8"),
  ]);
  expect(backend).not.toContain("Principal.isCanister(caller)");
  expect(backend).toContain("let REMOTE_CALL_BASE_CYCLES = 400_000_000;");
  expect(backend).toContain("cycles = REMOTE_CALL_BASE_CYCLES");
  expect(backend).not.toContain("cycles = 0");
  expect(backend).toContain('op = "push"');
  expect(backend).toContain("pending_push");
  expect(backend).toContain("chess_remote_push_target");
  expect(backend).toContain("MAX_REMOTE_HISTORY = 128");
  expect(backend).toContain("ignore await* pushHostState(next)");
  expect(backend).toContain("REMOTE_STATE_INTERVAL");
  expect(backend).toContain("REMOTE_COMMAND_INTERVAL");
  expect(backend).toContain("expected_revision");
  expect(backend).toMatch(
    /case \(#owned\(game\)\)[\s\S]*?validateMoveBinding\(request, game\.game_id, game\.mode == #local\)[\s\S]*?game\.revision != request\.expected_revision[\s\S]*?Rules\.makeMove/,
  );
  expect(backend).toMatch(
    /validateMoveBinding[\s\S]*?expected != actualGameId[\s\S]*?request\.local_only == \?true and not local/,
  );
  expect(backend).toContain(
    "expected_game_id and local_only=true must be supplied together",
  );
  expect(backend).toContain(
    'request.game_id # "_" # Nat.toText(mem.next_generation)',
  );
  expect(backend).toContain(
    "game_id is too long after adding its unique generation",
  );
  expect(backend).toContain(
    "new game_id must be a 128-bit lowercase hexadecimal seed",
  );
  expect(rules).toContain("castle_kingside");
  expect(rules).toContain("en_passant");
  expect(rules).toContain("draw_threefold");
  expect(memory).toMatch(/^import Map "mo:core\/Map";$/m);
  expect(memory).not.toMatch(/^import\s+\w+\s+"(?:\.{1,2}\/|\/)/m);
});

test("Chess bundles the board, agent tools, and embedded browser-only computer worker", async () => {
  const [html, css, js, serviceHtml, serviceJs, serviceSource, uiSource] = await Promise.all([
    readFile(htmlUrl, "utf8"),
    readFile(cssUrl, "utf8"),
    readFile(jsUrl, "utf8"),
    readFile(serviceHtmlUrl, "utf8"),
    readFile(serviceJsUrl, "utf8"),
    readFile(serviceSourceUrl, "utf8"),
    readFile(uiSourceUrl, "utf8"),
  ]);
  expect(html).toContain("./main.css");
  expect(css).toContain(".chess-board");
  expect(css).toContain(".chess-history");
  expect(css).toContain(".chess-promotion");
  expect(css).not.toMatch(/gradient\s*\(/i);
  expect(js).toContain("data-square");
  expect(js).toContain("chess_create_game");
  expect(js).toContain("chess_join_game");
  expect(js).toContain("application/javascript");
  expect(js).toContain("createObjectURL");
  expect(js).toContain("setDragImage");
  expect(js).toContain("checkmate");
  expect(js).toContain("promotion");
  expect(js).toContain("neutron:app:state");
  expect(serviceHtml).toContain("./service.js");
  expect(serviceJs).toContain("chess_local_games");
  expect(serviceJs).toContain("chess_position");
  expect(serviceJs).toContain("chess_move");
  expect(serviceJs).toContain("canister.query_self");
  expect(serviceJs).toContain("canister.update_self");
  expect(serviceSource).not.toContain("pagehide");
  expect(uiSource).toContain("queueRefresh(stateRefreshLatchRef.current)");
  expect(uiSource).toContain("finishMutation(mutation, epoch)");
  expect(uiSource).toContain("void loadGameRequest(false)");
  expect(uiSource).toContain("const value = await querySelf");
  expect(uiSource).toContain("listBackendCallReservations()");
  expect(uiSource).toContain("remotePushReservationRequest(tileId, target)");
  expect(uiSource).toContain("remoteCommandOutcomeUncertain(failure.code)");
  expect(uiSource).toContain("Retry peer push");
  expect(uiSource).toContain("Retry sync");
  expect(uiSource).not.toContain("REMOTE_POLL_MS");
});

test("Chess v1 package contains a self-contained tile and resident agent tool host", async () => {
  const unpacked = unpackNeutronPackage(await readFile(packageUrl));
  const paths = Object.keys(unpacked);
  expect(paths).toEqual(
    expect.arrayContaining([
      "neutron.json",
      "schema.json",
      "web/index.html",
      "web/main.css",
      "web/main.js",
      "web/service.html",
      "web/service.js",
      "web/static/icon.svg",
    ]),
  );

  const prepared = preparePackageInstall(unpacked);
  expect(prepared.manifest.background).toMatchObject({ path: "service.html" });
  expect(prepared.files.map((file) => file.path)).not.toContain(
    "app/chess/computer-worker.js",
  );
  expect(prepared.files.some((file) => file.path.startsWith("mo/"))).toBe(true);
});
