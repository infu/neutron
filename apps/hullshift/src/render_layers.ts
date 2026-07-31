import * as THREE from "three";
import { BOARD_LIMITS } from "./model.ts";
import type {
  Coord,
  EngineEvent,
  EngineSnapshot,
  FixtureDefinition,
  LevelDefinition,
} from "./model.ts";
import {
  HULLSHIFT_PALETTE,
  channelColor,
} from "./palette.ts";
import {
  createPulseMaterial,
  setPulsePresentation,
} from "./render_shaders.ts";
import {
  createHullshiftFixtureModel,
} from "./models_fixtures_3d.ts";
import {
  createHullshiftOccupantModel,
} from "./models_occupants_3d.ts";
import { createHullshiftTerrainModel } from "./models_terrain_3d.ts";

export const BOARD_LAYER_Z = Object.freeze({
  backdrop: -0.5,
  terrain: 0,
  links: 0.065,
  fixture: 0.03,
  channelMark: 0.15,
  occupant: 0.03,
  powered: 0.068,
  highlight: 0.075,
} as const);

/** Absolute top surfaces used to keep movable models clear of machinery. */
export const HULLSHIFT_FIXTURE_SUPPORT_SURFACE_Z = Object.freeze({
  plate: 0.22,
  relay: 0.23,
  socket: 0.18,
  bridge: 0.2,
} as const);

/** Visible front/top ledges for the channel's redundant pip code. */
export const HULLSHIFT_CHANNEL_MARK_SURFACE_Z = Object.freeze({
  plate: 0.23,
  relay: 0.24,
  socket: 0.29,
  door: 0.22,
  bridge: 0.36,
  disposal: 0.25,
  gate: 0.19,
} as const);

const OCCUPANT_SUPPORT_CLEARANCE = 0.008;

const TERRAIN_KINDS = ["floor", "bulkhead", "vacuum", "fracture"] as const;
const FIXTURE_KINDS = [
  "plate",
  "relay",
  "socket",
  "door",
  "bridge",
  "disposal",
  "gate",
] as const;
const OBJECT_KINDS = ["cargo", "reactor-cell"] as const;
const MODEL_MATERIAL_ROLES = ["base", "detail", "emissive"] as const;
const FIXTURE_VARIANT_COUNTS = Object.freeze({
  plate: 2,
  relay: 2,
  socket: 2,
  door: 3,
  bridge: 2,
  disposal: 1,
  gate: 2,
} as const);
const MAX_EVENT_HIGHLIGHTS = 16;
const MODEL_ROLE_COUNT = MODEL_MATERIAL_ROLES.length;
const FIXTURE_ROLE_LAYER_COUNT = FIXTURE_KINDS.reduce(
  (count, kind) => count + FIXTURE_VARIANT_COUNTS[kind] * MODEL_ROLE_COUNT,
  0,
);
const OCCUPANT_ROLE_LAYER_COUNT = 3 * MODEL_ROLE_COUNT;
const INSTALLED_REACTOR_ROLE_LAYER_COUNT = MODEL_ROLE_COUNT;
const FIXED_SCENE_OBJECT_COUNT =
  1
  + TERRAIN_KINDS.length
  + FIXTURE_ROLE_LAYER_COUNT
  + 1
  + 1
  + OCCUPANT_ROLE_LAYER_COUNT
  + INSTALLED_REACTOR_ROLE_LAYER_COUNT
  + 1
  + 1;

/** Absolute allocation ceilings implied by the V1 board/fixture/object caps. */
export const HULLSHIFT_RENDER_LAYER_BUDGETS = Object.freeze({
  maxVisibleDrawCalls: FIXED_SCENE_OBJECT_COUNT,
  maxSceneObjects: FIXED_SCENE_OBJECT_COUNT,
  // Installed reactors reuse the loose reactor descriptor geometry exactly.
  maxGeometryResources:
    1
    + TERRAIN_KINDS.length
    + FIXTURE_ROLE_LAYER_COUNT
    + 1
    + 1
    + OCCUPANT_ROLE_LAYER_COUNT
    + 1
    + 1,
  // Model-role materials are shared across every fixture/occupant layer.
  maxMaterialResources: 1 + TERRAIN_KINDS.length + MODEL_ROLE_COUNT + 4,
  maxInstanceCapacity:
    BOARD_LIMITS.maxWidth * BOARD_LIMITS.maxHeight + TERRAIN_KINDS.length - 1
    + FIXTURE_ROLE_LAYER_COUNT
    + Math.max(...Object.values(FIXTURE_VARIANT_COUNTS))
      * MODEL_ROLE_COUNT
      * (BOARD_LIMITS.maxStatefulFixtures - 1)
    + BOARD_LIMITS.maxStatefulFixtures * BOARD_LIMITS.maxChannels
    + BOARD_LIMITS.maxStatefulFixtures
    + OBJECT_KINDS.length * MODEL_ROLE_COUNT
    + MODEL_ROLE_COUNT * (BOARD_LIMITS.maxObjects - 1)
    + MODEL_ROLE_COUNT
    + BOARD_LIMITS.maxStatefulFixtures * MODEL_ROLE_COUNT
    + MAX_EVENT_HIGHLIGHTS,
  maxCircuitLinkSegments:
    Math.floor(BOARD_LIMITS.maxStatefulFixtures ** 2 / 4)
    * (BOARD_LIMITS.maxWidth * BOARD_LIMITS.maxHeight - 1),
} as const);

type TerrainKind = (typeof TERRAIN_KINDS)[number];
type FixtureKind = (typeof FIXTURE_KINDS)[number];
type ObjectKind = (typeof OBJECT_KINDS)[number];
type ModelMaterialRole = (typeof MODEL_MATERIAL_ROLES)[number];
type FixtureModelDescriptor = ReturnType<typeof createHullshiftFixtureModel>;
type OccupantModelDescriptor = ReturnType<typeof createHullshiftOccupantModel>;

type CoordLike = Coord;

interface FixtureView {
  readonly id: string;
  readonly kind: FixtureKind;
  readonly channelId: string | null;
  readonly coord: CoordLike;
}

interface RenderObjectView {
  readonly id: string;
  readonly kind: ObjectKind;
  readonly position: CoordLike;
}

interface InstanceLayer {
  readonly mesh: THREE.InstancedMesh;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.Material;
}

interface ModelPartLayer extends InstanceLayer {
  readonly role: ModelMaterialRole;
}

type ModelPartLayers = readonly ModelPartLayer[];
type FixtureStateLayers = ReadonlyMap<string, ModelPartLayers>;

export interface HullshiftLayerDiagnostics {
  readonly disposed: boolean;
  readonly terrainInstances: number;
  readonly fixtureInstances: number;
  readonly objectInstances: number;
  readonly linkSegments: number;
  readonly visibleDrawCalls: number;
  readonly sceneObjects: number;
  readonly geometryResources: number;
  readonly materialResources: number;
  readonly instanceCapacity: number;
}

export interface HullshiftRenderLayersOptions {
  readonly reducedMotion?: boolean;
}

/** Map top-left grid coordinates onto the centered logical XY render plane. */
export function cellWorldPosition(
  level: Pick<LevelDefinition, "width" | "height">,
  coord: CoordLike,
  z = 0,
): THREE.Vector3 {
  return new THREE.Vector3(
    coord.x - level.width / 2 + 0.5,
    level.height / 2 - coord.y - 0.5,
    z,
  );
}

/**
 * Fixed, batched board layers. The class only reads immutable level/snapshot
 * values and never writes into engine-owned data.
 */
export class HullshiftRenderLayers {
  readonly group = new THREE.Group();

  private readonly level: LevelDefinition;
  private readonly reducedMotionAtCreation: boolean;
  private readonly terrain = new Map<TerrainKind, InstanceLayer>();
  private readonly fixtures = new Map<FixtureKind, FixtureStateLayers>();
  private readonly objects = new Map<ObjectKind, ModelPartLayers>();
  private readonly fixtureModels = new Map<FixtureKind, FixtureModelDescriptor>();
  private readonly occupantModels = new Map<
    "maintenance-droid" | ObjectKind,
    OccupantModelDescriptor
  >();
  private readonly fixtureViews: readonly FixtureView[];
  private readonly channelIds: readonly string[];
  private readonly channelIndex = new Map<string, number>();
  private readonly channelMarks: InstanceLayer;
  private readonly powered: InstanceLayer;
  private readonly highlights: InstanceLayer;
  private readonly player: ModelPartLayers;
  private readonly installedReactor: ModelPartLayers;
  private readonly linkGeometry: THREE.BufferGeometry;
  private readonly linkMaterial: THREE.MeshBasicMaterial;
  private readonly links: THREE.Mesh;
  private readonly backdrop: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly geometries = new Set<THREE.BufferGeometry>();
  private readonly materials = new Set<THREE.Material>();
  private readonly transform = new THREE.Object3D();
  private readonly scratchColor = new THREE.Color();
  private disposed = false;
  private terrainCount = 0;
  private fixtureCount = 0;
  private objectCount = 0;
  private installedReactorCount = 0;
  private playerCount = 0;
  private linkSegmentCount = 0;

  constructor(
    level: LevelDefinition,
    snapshot: EngineSnapshot,
    options: HullshiftRenderLayersOptions = {},
  ) {
    assertLevelDimensions(level);
    this.level = level;
    this.reducedMotionAtCreation = options.reducedMotion === true;
    this.group.name = "Hullshift board";

    this.channelIds = Object.freeze(readChannelIds(level));
    this.channelIds.forEach((id, index) => this.channelIndex.set(id, index));
    this.fixtureViews = Object.freeze(readFixtures(level));

    const backdropGeometry = this.trackGeometry(new THREE.PlaneGeometry(level.width + 1, level.height + 1));
    const backdropMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: HULLSHIFT_PALETTE.void,
      depthTest: true,
      depthWrite: true,
    }));
    this.backdrop = new THREE.Mesh(backdropGeometry, backdropMaterial);
    this.backdrop.name = "Hullshift board surround";
    this.backdrop.position.z = BOARD_LAYER_Z.backdrop;
    this.backdrop.renderOrder = 0;
    this.group.add(this.backdrop);

    for (const kind of TERRAIN_KINDS) {
      const terrainCapacity = this.level.cells.reduce(
        (count, cell) => count + (cell.terrain === kind ? 1 : 0),
        0,
      );
      const layer = this.createInstanceLayer(
        `Hullshift terrain: ${kind}`,
        createHullshiftTerrainModel(kind).geometry,
        new THREE.MeshStandardMaterial({
          // Instanced colors are already authored in the exact palette. A
          // non-white material tint multiplies them in Three's mesh shaders and
          // makes dark hull colors collapse into the void during color grading.
          // `vertexColors` deliberately stays false: Three enables
          // `instanceColor` automatically, while `vertexColors` additionally
          // requires a per-vertex `color` attribute these geometries do not
          // have (and the missing attribute resolves to black on WebGL).
          color: 0xffffff,
          vertexColors: false,
          roughness: kind === "bulkhead" ? 0.68 : 0.84,
          metalness: kind === "vacuum" ? 0.38 : 0.18,
          depthTest: true,
          depthWrite: true,
        }),
        terrainCapacity,
        false,
      );
      this.terrain.set(kind, layer);
      this.group.add(layer.mesh);
    }

    const modelMaterials: Readonly<Record<ModelMaterialRole, THREE.Material>> = {
      base: this.trackMaterial(new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: false,
        roughness: 0.62,
        metalness: 0.38,
        flatShading: true,
        depthTest: true,
        depthWrite: true,
      })),
      detail: this.trackMaterial(new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: false,
        roughness: 0.48,
        metalness: 0.66,
        flatShading: true,
        depthTest: true,
        depthWrite: true,
      })),
      emissive: this.trackMaterial(new THREE.MeshBasicMaterial({
        color: 0xffffff,
        vertexColors: false,
        toneMapped: false,
        depthTest: true,
        depthWrite: true,
      })),
    };

    const fixtureCapacity = Math.max(1, this.fixtureViews.length);
    for (const kind of FIXTURE_KINDS) {
      const model = createHullshiftFixtureModel(kind);
      this.fixtureModels.set(kind, model);
      const kindCapacity = this.fixtureViews.reduce(
        (count, fixture) => count + (fixture.kind === kind ? 1 : 0),
        0,
      );
      const states = new Map<string, ModelPartLayers>();
      for (const variant of model.variants) {
        states.set(
          variant.state,
          this.createModelPartLayers(
            `Hullshift fixture: ${kind}:${variant.state}`,
            variant.parts,
            kindCapacity,
            modelMaterials,
          ),
        );
      }
      this.fixtures.set(kind, states);
    }

    const channelMarkCapacity = Math.max(1, this.fixtureViews.length * 4);
    this.channelMarks = this.createInstanceLayer(
      "Hullshift channel symbols",
      new THREE.PlaneGeometry(0.16, 0.12),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        vertexColors: false,
        depthTest: true,
        depthWrite: false,
      }),
      channelMarkCapacity,
      true,
    );
    this.group.add(this.channelMarks.mesh);

    const pulseMaterial = createPulseMaterial({
      reducedMotion: this.reducedMotionAtCreation,
      opacity: 0.24,
    });
    // A quiet peripheral arc supplements the model's own state geometry. It is
    // deliberately neither a square tile border nor a ring that can swallow a
    // gate/socket silhouette, and machinery depth-occludes it naturally.
    pulseMaterial.depthTest = true;
    const poweredGeometry = new THREE.RingGeometry(
      0.435,
      0.47,
      18,
      1,
      Math.PI * 0.12,
      Math.PI * 0.52,
    );
    this.powered = this.createInstanceLayer(
      "Hullshift powered fixtures",
      poweredGeometry,
      pulseMaterial,
      fixtureCapacity,
      true,
    );
    this.group.add(this.powered.mesh);

    const playerModel = createHullshiftOccupantModel("maintenance-droid");
    this.occupantModels.set("maintenance-droid", playerModel);
    this.player = this.createModelPartLayers(
      "Hullshift maintenance droid",
      playerModel.parts,
      1,
      modelMaterials,
    );

    for (const kind of OBJECT_KINDS) {
      const model = createHullshiftOccupantModel(kind);
      this.occupantModels.set(kind, model);
      const kindCapacity = level.objects.reduce(
        (count, object) => count + (object.kind === kind ? 1 : 0),
        0,
      );
      const layers = this.createModelPartLayers(
        `Hullshift objects: ${kind}`,
        model.parts,
        kindCapacity,
        modelMaterials,
      );
      this.objects.set(kind, layers);
    }

    const reactorModel = this.occupantModels.get("reactor-cell");
    if (reactorModel === undefined) {
      throw new Error("Hullshift reactor model was not initialized");
    }
    const installedCapacity = this.fixtureViews.reduce(
      (count, fixture) => count + (fixture.kind === "socket" ? 1 : 0),
      0,
    );
    this.installedReactor = this.createModelPartLayers(
      "Hullshift installed reactor-cell",
      reactorModel.parts,
      installedCapacity,
      modelMaterials,
    );

    // Consequence emphasis is a small open arc, never a square cell outline.
    // Ordinary walking and pushing are intentionally excluded below: the
    // modeled occupant already communicates those moves without a second,
    // short-lived marker appearing at the source or destination cell.
    const highlightGeometry = new THREE.RingGeometry(
      0.32,
      0.38,
      24,
      1,
      Math.PI * 0.12,
      Math.PI * 1.42,
    );
    this.highlights = this.createInstanceLayer(
      "Hullshift event highlights",
      highlightGeometry,
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        vertexColors: false,
        transparent: true,
        opacity: 0,
        depthTest: false,
        depthWrite: false,
      }),
      MAX_EVENT_HIGHLIGHTS,
      true,
    );
    this.group.add(this.highlights.mesh);

    this.linkGeometry = this.trackGeometry(new THREE.BufferGeometry());
    this.linkMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    }));
    this.links = new THREE.Mesh(this.linkGeometry, this.linkMaterial);
    this.links.name = "Hullshift circuit links";
    this.links.position.z = BOARD_LAYER_Z.links;
    this.links.renderOrder = 20;
    this.links.frustumCulled = false;
    this.group.add(this.links);

    this.populateTerrain();
    this.populateCircuitLinks();
    this.update(snapshot, []);
  }

  update(snapshot: EngineSnapshot, eventTrace: readonly EngineEvent[] = []): void {
    this.assertUsable();
    this.updateTerrainState(snapshot);
    this.updateFixtures(snapshot);
    this.updateObjects(snapshot);
    this.updateInstalledReactors(snapshot);
    this.updatePlayer(snapshot);
    this.updateHighlights(snapshot, eventTrace);
  }

  updatePresentation(elapsedSeconds: number, progress: number, reducedMotion: boolean): void {
    this.assertUsable();
    setPulsePresentation(
      this.powered.material as THREE.ShaderMaterial,
      elapsedSeconds,
      reducedMotion,
    );
    const material = this.highlights.material as THREE.MeshBasicMaterial;
    const boundedProgress = THREE.MathUtils.clamp(progress, 0, 1);
    material.opacity = reducedMotion
      ? (boundedProgress < 0.45 ? 0.8 : 0)
      : Math.sin(boundedProgress * Math.PI) * 0.86;
  }

  clearPresentation(): void {
    if (this.disposed) return;
    (this.highlights.material as THREE.MeshBasicMaterial).opacity = 0;
    this.highlights.mesh.count = 0;
    setPulsePresentation(
      this.powered.material as THREE.ShaderMaterial,
      0,
      true,
    );
  }

  diagnostics(): HullshiftLayerDiagnostics {
    if (this.disposed) {
      return Object.freeze({
        disposed: true,
        terrainInstances: 0,
        fixtureInstances: 0,
        objectInstances: 0,
        linkSegments: 0,
        visibleDrawCalls: 0,
        sceneObjects: 0,
        geometryResources: 0,
        materialResources: 0,
        instanceCapacity: 0,
      });
    }
    const instanceLayers: InstanceLayer[] = [
      ...this.terrain.values(),
      ...[...this.fixtures.values()].flatMap((states) => (
        [...states.values()].flatMap((layers) => [...layers])
      )),
      ...[...this.objects.values()].flatMap((layers) => [...layers]),
      this.channelMarks,
      this.powered,
      ...this.player,
      ...this.installedReactor,
      this.highlights,
    ];
    return Object.freeze({
      disposed: false,
      terrainInstances: this.terrainCount,
      fixtureInstances: this.fixtureCount,
      objectInstances: this.objectCount + this.installedReactorCount + this.playerCount,
      linkSegments: this.linkSegmentCount,
      visibleDrawCalls: instanceLayers.filter((layer) => layer.mesh.count > 0).length
        + (this.linkSegmentCount > 0 ? 1 : 0)
        + 1,
      sceneObjects: this.group.children.length,
      geometryResources: this.geometries.size,
      materialResources: this.materials.size,
      instanceCapacity: instanceLayers.reduce(
        (capacity, layer) => capacity + layer.mesh.instanceMatrix.count,
        0,
      ),
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // InstancedMesh owns GPU-side instanceMatrix/instanceColor buffers that are
    // independent of its shared geometry/material resources.
    for (const child of this.group.children) {
      if (child instanceof THREE.InstancedMesh) child.dispose();
    }
    this.group.remove(...this.group.children);
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.geometries.clear();
    this.materials.clear();
  }

  private populateTerrain(): void {
    const counts = new Map<TerrainKind, number>(TERRAIN_KINDS.map((kind) => [kind, 0]));
    this.level.cells.forEach((cell, cellIndex) => {
      const kind = readTerrainKind(cell);
      const layer = this.terrain.get(kind);
      if (!layer) return;
      const count = counts.get(kind) ?? 0;
      const coord = { x: cellIndex % this.level.width, y: Math.floor(cellIndex / this.level.width) };
      this.writeTransform(layer.mesh, count, coord, BOARD_LAYER_Z.terrain);
      layer.mesh.setColorAt(count, this.scratchColor.setHex(terrainColor(kind)));
      counts.set(kind, count + 1);
      this.terrainCount += 1;
    });
    for (const [kind, layer] of this.terrain) {
      layer.mesh.count = counts.get(kind) ?? 0;
      markInstancesChanged(layer.mesh);
    }
  }

  private updateTerrainState(snapshot: EngineSnapshot): void {
    const collapsed = new Set(snapshot.state.collapsedFractures.map((coord) => `${coord.x},${coord.y}`));
    let fractureIndex = 0;
    this.level.cells.forEach((cell, cellIndex) => {
      if (cell.terrain !== "fracture") return;
      const coord = { x: cellIndex % this.level.width, y: Math.floor(cellIndex / this.level.width) };
      const fracture = this.terrain.get("fracture");
      if (fracture !== undefined) {
        const isCollapsed = collapsed.has(`${coord.x},${coord.y}`);
        this.writeTransform(
          fracture.mesh,
          fractureIndex,
          coord,
          BOARD_LAYER_Z.terrain,
          0,
          0,
          isCollapsed ? 0.28 : 1,
        );
        fracture.mesh.setColorAt(
          fractureIndex,
          this.scratchColor.setHex(
            isCollapsed
              ? HULLSHIFT_PALETTE.dangerRed
              : HULLSHIFT_PALETTE.warningAmber,
          ),
        );
        fractureIndex += 1;
      }
    });
    const fracture = this.terrain.get("fracture");
    if (fracture !== undefined) markInstancesChanged(fracture.mesh);
  }

  private populateCircuitLinks(): void {
    const positions: number[] = [];
    const colors: number[] = [];
    for (const channelId of this.channelIds) {
      const members = this.fixtureViews.filter((fixture) => fixture.channelId === channelId);
      const sources = members.filter((fixture) => isSourceKind(fixture.kind));
      const consumers = members.filter((fixture) => isConsumerKind(fixture.kind));
      const index = this.channelIndex.get(channelId) ?? 0;
      const color = this.scratchColor.setHex(channelColor(index));
      for (const source of sources) {
        for (const consumer of consumers) {
          const walkableRoute = routeCircuitLink(this.level, source.coord, consumer.coord);
          const crossesBulkheads = walkableRoute.length === 0;
          const route = crossesBulkheads
            ? fallbackCircuitRoute(source.coord, consumer.coord)
            : walkableRoute;
          const segments = crossesBulkheads
            ? adjacentRouteSegments(route)
            : compressedRouteSegments(route);
          for (const [fromCoord, toCoord] of segments) {
            appendSegment(
              positions,
              colors,
              cellWorldPosition(this.level, fromCoord, circuitLinkLocalZ(this.level, fromCoord)),
              cellWorldPosition(this.level, toCoord, circuitLinkLocalZ(this.level, toCoord)),
              color,
            );
            this.linkSegmentCount += 1;
          }
        }
      }
    }
    this.linkGeometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    this.linkGeometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    this.linkGeometry.computeBoundingSphere();
  }

  private updateFixtures(snapshot: EngineSnapshot): void {
    const fixtureCounts = new Map<FixtureKind, Map<string, number>>();
    for (const [kind, states] of this.fixtures) {
      fixtureCounts.set(kind, new Map([...states.keys()].map((state) => [state, 0])));
    }
    let channelMarkCount = 0;
    let poweredCount = 0;

    for (const fixture of this.fixtureViews) {
      const state = fixtureModelState(snapshot, fixture);
      const layers = this.fixtures.get(fixture.kind)?.get(state);
      const kindCounts = fixtureCounts.get(fixture.kind);
      if (layers === undefined || kindCounts === undefined) continue;
      const count = kindCounts.get(state) ?? 0;
      const poweredForPresentation = fixtureIsPowered(snapshot, fixture);
      this.writeModelPartInstance(
        layers,
        count,
        fixture.coord,
        BOARD_LAYER_Z.fixture,
        (role) => fixturePartColor(fixture, role, state, this.channelIndex),
      );
      kindCounts.set(state, count + 1);

      if (fixture.channelId !== null) {
        const index = this.channelIndex.get(fixture.channelId) ?? 0;
        const marks = Math.min(4, index + 1);
        const poweredChannel = channelIsActive(snapshot, fixture.channelId);
        for (let mark = 0; mark < marks && channelMarkCount < this.channelMarks.mesh.instanceMatrix.count; mark += 1) {
          const xOffset = (mark - (marks - 1) / 2) * 0.18;
          this.writeTransform(
            this.channelMarks.mesh,
            channelMarkCount,
            fixture.coord,
            HULLSHIFT_CHANNEL_MARK_SURFACE_Z[fixture.kind],
            xOffset,
            -0.34,
          );
          this.channelMarks.mesh.setColorAt(
            channelMarkCount,
            this.scratchColor.setHex(poweredChannel ? channelColor(index) : HULLSHIFT_PALETTE.inactive),
          );
          channelMarkCount += 1;
        }
        if (poweredForPresentation && poweredCount < this.powered.mesh.instanceMatrix.count) {
          this.writeTransform(this.powered.mesh, poweredCount, fixture.coord, BOARD_LAYER_Z.powered);
          this.powered.mesh.setColorAt(poweredCount, this.scratchColor.setHex(channelColor(index)));
          poweredCount += 1;
        }
      }
    }

    this.fixtureCount = this.fixtureViews.length;
    for (const [kind, states] of this.fixtures) {
      const kindCounts = fixtureCounts.get(kind);
      for (const [state, layers] of states) {
        const count = kindCounts?.get(state) ?? 0;
        for (const layer of layers) {
          layer.mesh.count = count;
          markInstancesChanged(layer.mesh);
        }
      }
    }
    this.channelMarks.mesh.count = channelMarkCount;
    this.powered.mesh.count = poweredCount;
    markInstancesChanged(this.channelMarks.mesh);
    markInstancesChanged(this.powered.mesh);
  }

  private updateObjects(snapshot: EngineSnapshot): void {
    const counts = new Map<ObjectKind, number>(OBJECT_KINDS.map((kind) => [kind, 0]));
    const removed = new Set(snapshot.state.removedObjectIds);
    for (const object of readSnapshotObjects(snapshot)) {
      if (removed.has(object.id)) continue;
      const layers = this.objects.get(object.kind);
      if (layers === undefined) continue;
      const count = counts.get(object.kind) ?? 0;
      if (count >= (layers[0]?.mesh.instanceMatrix.count ?? 0)) continue;
      this.writeModelPartInstance(
        layers,
        count,
        object.position,
        this.occupantStandingZ(snapshot, object.position, object.kind),
        (role) => occupantPartColor(object.kind, role, snapshot),
      );
      counts.set(object.kind, count + 1);
    }
    this.objectCount = 0;
    for (const [kind, layers] of this.objects) {
      const count = counts.get(kind) ?? 0;
      this.objectCount += count;
      for (const layer of layers) {
        layer.mesh.count = count;
        markInstancesChanged(layer.mesh);
      }
    }
  }

  private updateInstalledReactors(snapshot: EngineSnapshot): void {
    const socketModel = this.fixtureModels.get("socket");
    const reactorModel = this.occupantModels.get("reactor-cell");
    const mountZ = socketModel?.reactorMountZ;
    const installedPlacement = reactorModel?.installedPlacement;
    if (mountZ === null || mountZ === undefined || installedPlacement === null || installedPlacement === undefined) {
      throw new Error("Hullshift installed reactor placement metadata is missing");
    }

    const fixturesById = new Map(this.fixtureViews.map((fixture) => [fixture.id, fixture]));
    let count = 0;
    for (const installed of snapshot.state.installedCells) {
      const socket = fixturesById.get(installed.socketId);
      if (socket?.kind !== "socket") continue;
      if (count >= (this.installedReactor[0]?.mesh.instanceMatrix.count ?? 0)) continue;
      // reactorMountZ and installedPlacement.zOffset intentionally describe
      // the same offset. Use the socket's mount once, never their sum.
      this.writeModelPartInstance(
        this.installedReactor,
        count,
        socket.coord,
        mountZ,
        (role) => occupantPartColor("reactor-cell", role, snapshot),
        installedPlacement.scale,
      );
      count += 1;
    }
    this.installedReactorCount = count;
    for (const layer of this.installedReactor) {
      layer.mesh.count = count;
      markInstancesChanged(layer.mesh);
    }
  }

  private updatePlayer(snapshot: EngineSnapshot): void {
    const player = snapshot.state.player;
    this.playerCount = player === null ? 0 : 1;
    for (const layer of this.player) layer.mesh.count = this.playerCount;
    if (player !== null) {
      this.writeModelPartInstance(
        this.player,
        0,
        player,
        this.occupantStandingZ(snapshot, player, "maintenance-droid"),
        (role) => occupantPartColor("maintenance-droid", role, snapshot),
      );
    }
    for (const layer of this.player) markInstancesChanged(layer.mesh);
  }

  private occupantStandingZ(
    snapshot: EngineSnapshot,
    coord: CoordLike,
    kind: "maintenance-droid" | ObjectKind,
  ): number {
    const model = this.occupantModels.get(kind);
    const fixture = this.fixtureViews.find((candidate) => (
      candidate.coord.x === coord.x && candidate.coord.y === coord.y
    ));
    if (model === undefined || fixture === undefined) return BOARD_LAYER_Z.occupant;
    const state = fixtureModelState(snapshot, fixture);
    const surface = fixtureSupportSurfaceZ(fixture.kind, state);
    if (surface === null) return BOARD_LAYER_Z.occupant;
    return Math.max(
      BOARD_LAYER_Z.occupant,
      surface + OCCUPANT_SUPPORT_CLEARANCE - model.bounds.min[2],
    );
  }

  private updateHighlights(snapshot: EngineSnapshot, eventTrace: readonly EngineEvent[]): void {
    const coords = collectEventCoords(eventTrace, this.level);
    if (coords.length === 0 && snapshot.outcome.kind !== "playing") {
      if ("position" in snapshot.outcome) {
        coords.push(snapshot.outcome.position);
      } else if (snapshot.state.player !== null) {
        coords.push(snapshot.state.player);
      }
    }
    const color = outcomeColor(snapshot);
    const highlightCount = Math.min(coords.length, MAX_EVENT_HIGHLIGHTS);
    this.highlights.mesh.count = highlightCount;
    for (let index = 0; index < highlightCount; index += 1) {
      this.writeTransform(
        this.highlights.mesh,
        index,
        coords[index]!,
        BOARD_LAYER_Z.highlight,
      );
      this.highlights.mesh.setColorAt(index, this.scratchColor.setHex(color));
    }
    markInstancesChanged(this.highlights.mesh);
  }

  /**
   * Model factories transfer their freshly-owned geometry lifetime to this
   * render-layer owner. The shared geometry set is therefore the sole disposer
   * for descriptor parts, including reactor parts referenced by two meshes.
   */
  private createModelPartLayers(
    name: string,
    parts: readonly Readonly<{
      role: ModelMaterialRole;
      geometry: THREE.BufferGeometry;
    }>[],
    capacity: number,
    materials: Readonly<Record<ModelMaterialRole, THREE.Material>>,
  ): ModelPartLayers {
    const layers = parts.map((part) => {
      const layer = this.createInstanceLayer(
        `${name}:${part.role}`,
        part.geometry,
        materials[part.role],
        capacity,
        true,
      );
      this.group.add(layer.mesh);
      return Object.freeze({ ...layer, role: part.role });
    });
    return Object.freeze(layers);
  }

  private writeModelPartInstance(
    layers: ModelPartLayers,
    index: number,
    coord: CoordLike,
    z: number,
    colorForRole: (role: ModelMaterialRole) => number,
    scale = 1,
  ): void {
    for (const layer of layers) {
      this.writeTransform(layer.mesh, index, coord, z, 0, 0, scale, scale);
      layer.mesh.setColorAt(
        index,
        this.scratchColor.setHex(colorForRole(layer.role)),
      );
    }
  }

  private createInstanceLayer(
    name: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    capacity: number,
    dynamic: boolean,
  ): InstanceLayer {
    this.trackGeometry(geometry);
    this.trackMaterial(material);
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, capacity));
    mesh.name = name;
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.renderOrder = layerRenderOrder(name);
    mesh.instanceMatrix.setUsage(dynamic ? THREE.DynamicDrawUsage : THREE.StaticDrawUsage);
    return { mesh, geometry, material };
  }

  private writeTransform(
    mesh: THREE.InstancedMesh,
    index: number,
    coord: CoordLike,
    z: number,
    xOffset = 0,
    yOffset = 0,
    scale = 1,
    zScale = 1,
  ): void {
    const position = cellWorldPosition(this.level, coord, z);
    this.transform.position.set(position.x + xOffset, position.y + yOffset, position.z);
    this.transform.rotation.set(0, 0, 0);
    this.transform.scale.set(scale, scale, zScale);
    this.transform.updateMatrix();
    mesh.setMatrixAt(index, this.transform.matrix);
    const instanceCoords = Array.isArray(mesh.userData.hullshiftInstanceCoords)
      ? mesh.userData.hullshiftInstanceCoords as CoordLike[]
      : [];
    instanceCoords[index] = { x: coord.x, y: coord.y };
    mesh.userData.hullshiftInstanceCoords = instanceCoords;
  }

  private trackGeometry<T extends THREE.BufferGeometry>(geometry: T): T {
    this.geometries.add(geometry);
    return geometry;
  }

  private trackMaterial<T extends THREE.Material>(material: T): T {
    this.materials.add(material);
    return material;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error("Hullshift render layers are disposed");
  }
}

function assertLevelDimensions(level: LevelDefinition): void {
  const fixtureCount = level.cells.reduce(
    (count, cell) => count + (cell.fixture === undefined ? 0 : 1),
    0,
  );
  const nonBulkheadCount = level.cells.reduce(
    (count, cell) => count + (cell.terrain === "bulkhead" ? 0 : 1),
    0,
  );
  if (
    !Number.isInteger(level.width)
    || !Number.isInteger(level.height)
    || level.width < BOARD_LIMITS.minWidth
    || level.height < BOARD_LIMITS.minHeight
    || level.width > BOARD_LIMITS.maxWidth
    || level.height > BOARD_LIMITS.maxHeight
    || level.cells.length !== level.width * level.height
    || level.channels.length > BOARD_LIMITS.maxChannels
    || level.objects.length > BOARD_LIMITS.maxObjects
    || fixtureCount > BOARD_LIMITS.maxStatefulFixtures
    || nonBulkheadCount > BOARD_LIMITS.maxNonBulkheadCells
  ) {
    throw new RangeError("Hullshift renderer received a level outside V1 render bounds");
  }
}

function terrainColor(kind: TerrainKind): number {
  switch (kind) {
    case "floor": return HULLSHIFT_PALETTE.hull;
    case "bulkhead": return HULLSHIFT_PALETTE.hullRaised;
    case "vacuum": return HULLSHIFT_PALETTE.hazardOrange;
    case "fracture": return HULLSHIFT_PALETTE.warningAmber;
  }
}

function fixtureModelState(snapshot: EngineSnapshot, fixture: FixtureView): string {
  switch (fixture.kind) {
    case "plate":
      return fixtureIsActive(snapshot, fixture) ? "depressed" : "released";
    case "relay":
      return snapshot.state.activeRelayIds.includes(fixture.id) ? "on" : "off";
    case "socket":
      return snapshot.state.installedCells.some((cell) => cell.socketId === fixture.id)
        ? "installed"
        : "empty";
    case "door": {
      const consumer = fixtureConsumer(snapshot, fixture.id);
      if (consumer?.jammed === true) return "jammed";
      return consumer?.passable === true ? "open" : "closed";
    }
    case "bridge":
      return fixtureConsumer(snapshot, fixture.id)?.passable === true ? "active" : "inactive";
    case "disposal":
      return "idle";
    case "gate":
      return fixtureConsumer(snapshot, fixture.id)?.powered === true ? "ready" : "locked";
  }
}

function fixtureSupportSurfaceZ(kind: FixtureKind, state: string): number | null {
  switch (kind) {
    case "plate":
      return state === "depressed" ? HULLSHIFT_FIXTURE_SUPPORT_SURFACE_Z.plate : null;
    case "relay":
      return HULLSHIFT_FIXTURE_SUPPORT_SURFACE_Z.relay;
    case "socket":
      return state === "empty" ? HULLSHIFT_FIXTURE_SUPPORT_SURFACE_Z.socket : null;
    case "bridge":
      return state === "active" ? HULLSHIFT_FIXTURE_SUPPORT_SURFACE_Z.bridge : null;
    case "door":
    case "disposal":
    case "gate":
      return null;
  }
}

function fixturePartColor(
  fixture: FixtureView,
  role: ModelMaterialRole,
  state: string,
  channelIndexes: ReadonlyMap<string, number>,
): number {
  if (role === "base") {
    switch (fixture.kind) {
      case "door":
      case "disposal": return HULLSHIFT_PALETTE.hullDeep;
      case "bridge": return HULLSHIFT_PALETTE.hull;
      default: return HULLSHIFT_PALETTE.hullRaised;
    }
  }
  if (role === "detail") {
    switch (fixture.kind) {
      case "relay": return HULLSHIFT_PALETTE.relayViolet;
      case "socket": return HULLSHIFT_PALETTE.reactorGold;
      case "disposal": return HULLSHIFT_PALETTE.hazardOrange;
      case "gate": return state === "ready"
        ? HULLSHIFT_PALETTE.powerGreen
        : HULLSHIFT_PALETTE.steel;
      default: return HULLSHIFT_PALETTE.steel;
    }
  }

  if (state === "jammed") return HULLSHIFT_PALETTE.warningAmber;
  if (fixture.kind === "disposal") return HULLSHIFT_PALETTE.hazardOrange;
  const energized = state === "depressed"
    || state === "on"
    || state === "installed"
    || state === "open"
    || state === "active"
    || state === "ready";
  if (!energized) return HULLSHIFT_PALETTE.inactive;
  if (fixture.kind === "socket") return HULLSHIFT_PALETTE.reactorGold;
  if (fixture.kind === "gate") return HULLSHIFT_PALETTE.powerGreen;
  const channelIndex = fixture.channelId === null
    ? 0
    : channelIndexes.get(fixture.channelId) ?? 0;
  return fixture.channelId === null
    ? HULLSHIFT_PALETTE.powerGreen
    : channelColor(channelIndex);
}

function occupantPartColor(
  kind: "maintenance-droid" | ObjectKind,
  role: ModelMaterialRole,
  snapshot: EngineSnapshot,
): number {
  if (kind === "maintenance-droid") {
    if (role === "base") return HULLSHIFT_PALETTE.goalIvory;
    if (role === "detail") return HULLSHIFT_PALETTE.hullDeep;
    return playerColor(snapshot);
  }
  if (kind === "cargo") {
    if (role === "base") return HULLSHIFT_PALETTE.cargoBlue;
    if (role === "detail") return HULLSHIFT_PALETTE.steel;
    return HULLSHIFT_PALETTE.focusCyan;
  }
  if (role === "base") return HULLSHIFT_PALETTE.reactorGold;
  if (role === "detail") return HULLSHIFT_PALETTE.hullEdge;
  return HULLSHIFT_PALETTE.goalIvory;
}

function readTerrainKind(cell: LevelDefinition["cells"][number]): TerrainKind {
  return cell.terrain;
}

function readFixtures(level: LevelDefinition): FixtureView[] {
  const fixtures: FixtureView[] = [];
  level.cells.forEach((cell, index) => {
    const fixture = cell.fixture;
    if (fixture === undefined) return;
    fixtures.push(Object.freeze({
      id: fixture.id,
      kind: fixture.kind,
      channelId: fixtureChannel(fixture),
      coord: Object.freeze({ x: index % level.width, y: Math.floor(index / level.width) }),
    }));
  });
  return fixtures;
}

function readChannelIds(level: LevelDefinition): string[] {
  const result = level.channels.map((channel) => channel.id);
  for (const fixture of readFixtures(level)) {
    if (fixture.channelId !== null && !result.includes(fixture.channelId)) result.push(fixture.channelId);
  }
  return result;
}

function fixtureChannel(fixture: FixtureDefinition): string | null {
  return "channel" in fixture ? fixture.channel : null;
}

function readSnapshotObjects(snapshot: EngineSnapshot): RenderObjectView[] {
  return snapshot.state.objects.map((object) => ({
    id: object.id,
    kind: object.kind,
    position: object.position,
  }));
}

function fixtureIsActive(snapshot: EngineSnapshot, fixture: FixtureView): boolean {
  if (fixture.kind === "relay") {
    return snapshot.state.activeRelayIds.includes(fixture.id);
  }
  if (fixture.kind === "socket") {
    return snapshot.state.installedCells.some((cell) => cell.socketId === fixture.id);
  }
  const collectionName = isSourceKind(fixture.kind) ? "sources" : "consumers";
  return snapshot.derived[collectionName].some((entry) => (
    entry.fixtureId === fixture.id
    && ("active" in entry ? entry.active : entry.powered || entry.jammed)
  ));
}

function fixtureIsPowered(snapshot: EngineSnapshot, fixture: FixtureView): boolean {
  if (isSourceKind(fixture.kind)) return fixtureIsActive(snapshot, fixture);
  if (isConsumerKind(fixture.kind)) {
    return fixtureConsumer(snapshot, fixture.id)?.powered === true;
  }
  return false;
}

function fixtureConsumer(snapshot: EngineSnapshot, fixtureId: string) {
  return snapshot.derived.consumers.find((consumer) => consumer.fixtureId === fixtureId);
}

function channelIsActive(snapshot: EngineSnapshot, channelId: string): boolean {
  return snapshot.derived.channels.some((channel) => channel.id === channelId && channel.active);
}

function playerColor(snapshot: EngineSnapshot): number {
  const kind = snapshot.outcome.kind;
  if (kind === "physical-failure" || kind === "causal-failure") return HULLSHIFT_PALETTE.dangerRed;
  if (kind === "victory") return HULLSHIFT_PALETTE.goalIvory;
  return HULLSHIFT_PALETTE.focusCyan;
}

function outcomeColor(snapshot: EngineSnapshot): number {
  const kind = snapshot.outcome.kind;
  if (kind === "physical-failure" || kind === "causal-failure") return HULLSHIFT_PALETTE.dangerRed;
  if (kind === "victory") return HULLSHIFT_PALETTE.goalIvory;
  return HULLSHIFT_PALETTE.focusCyan;
}

function collectEventCoords(events: readonly EngineEvent[], level: LevelDefinition): CoordLike[] {
  const result: CoordLike[] = [];
  const seen = new Set<string>();
  const add = (coord: CoordLike | null) => {
    if (!coord || coord.x < 0 || coord.y < 0 || coord.x >= level.width || coord.y >= level.height) return;
    const key = `${coord.x},${coord.y}`;
    if (seen.has(key) || result.length >= MAX_EVENT_HIGHLIGHTS) return;
    seen.add(key);
    result.push(coord);
  };
  for (const event of events) {
    switch (event.type) {
      case "relay-toggled":
      case "socket-docked":
      case "fracture-collapsed":
      case "object-removed":
      case "source-changed":
      case "consumer-changed":
      case "gate-entered":
      case "physical-failure":
      case "victory":
        add(event.position);
        break;
      case "blocked":
      case "player-moved":
      case "object-pushed":
      case "entity-exited":
      case "entity-entered":
      case "channel-changed":
      case "causal-failure":
        break;
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  }
  return result;
}

function isSourceKind(kind: FixtureKind): boolean {
  return kind === "plate" || kind === "relay" || kind === "socket";
}

function isConsumerKind(kind: FixtureKind): boolean {
  return kind === "door" || kind === "bridge" || kind === "gate";
}

function appendSegment(
  positions: number[],
  colors: number[],
  from: THREE.Vector3,
  to: THREE.Vector3,
  color: THREE.Color,
): void {
  const deltaX = to.x - from.x;
  const deltaY = to.y - from.y;
  const length = Math.hypot(deltaX, deltaY);
  if (length <= Number.EPSILON) return;
  // A 0.065-cell ribbon remains plainly traceable at the 24px/cell minimum,
  // unlike implementation-defined WebGL line widths that collapse or vanish.
  const halfWidth = 0.0325;
  const offsetX = -deltaY / length * halfWidth;
  const offsetY = deltaX / length * halfWidth;
  const ax = from.x + offsetX;
  const ay = from.y + offsetY;
  const bx = from.x - offsetX;
  const by = from.y - offsetY;
  const cx = to.x + offsetX;
  const cy = to.y + offsetY;
  const dx = to.x - offsetX;
  const dy = to.y - offsetY;
  positions.push(
    ax, ay, from.z,
    bx, by, from.z,
    cx, cy, to.z,
    cx, cy, to.z,
    bx, by, from.z,
    dx, dy, to.z,
  );
  for (let index = 0; index < 6; index += 1) {
    colors.push(color.r, color.g, color.b);
  }
}

/** Deterministic N,E,S,W routing keeps circuit traces out of bulkheads. */
function routeCircuitLink(
  level: LevelDefinition,
  start: Coord,
  goal: Coord,
): readonly Coord[] {
  const startIndex = start.y * level.width + start.x;
  const goalIndex = goal.y * level.width + goal.x;
  const previous = new Int16Array(level.cells.length);
  previous.fill(-1);
  previous[startIndex] = startIndex;
  const queue = new Int16Array(level.cells.length);
  let read = 0;
  let write = 0;
  queue[write++] = startIndex;
  const deltas = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;

  while (read < write && previous[goalIndex] === -1) {
    const current = queue[read++]!;
    const x = current % level.width;
    const y = Math.floor(current / level.width);
    for (const [dx, dy] of deltas) {
      const nextX = x + dx;
      const nextY = y + dy;
      if (nextX < 0 || nextY < 0 || nextX >= level.width || nextY >= level.height) continue;
      const next = nextY * level.width + nextX;
      if (previous[next] !== -1 || level.cells[next]?.terrain === "bulkhead") continue;
      previous[next] = current;
      queue[write++] = next;
    }
  }

  if (previous[goalIndex] === -1) return [];
  const reversed: Coord[] = [];
  let cursor = goalIndex;
  while (cursor !== startIndex) {
    reversed.push({ x: cursor % level.width, y: Math.floor(cursor / level.width) });
    cursor = previous[cursor]!;
  }
  reversed.push(start);
  reversed.reverse();
  return reversed;
}

function compressedRouteSegments(route: readonly Coord[]): readonly (readonly [Coord, Coord])[] {
  if (route.length < 2) return [];
  const segments: (readonly [Coord, Coord])[] = [];
  let segmentStart = route[0]!;
  let previous = route[0]!;
  let directionX = route[1]!.x - previous.x;
  let directionY = route[1]!.y - previous.y;

  for (let index = 1; index < route.length; index += 1) {
    const current = route[index]!;
    const nextDirectionX = current.x - previous.x;
    const nextDirectionY = current.y - previous.y;
    if (nextDirectionX !== directionX || nextDirectionY !== directionY) {
      segments.push([segmentStart, previous]);
      segmentStart = previous;
      directionX = nextDirectionX;
      directionY = nextDirectionY;
    }
    previous = current;
  }
  segments.push([segmentStart, previous]);
  return segments;
}

/**
 * Some certified circuits deliberately connect an isolated ballast/source.
 * Route X then Y across the hull as a raised service conduit when no walkable
 * route exists; presentation routing never feeds back into mechanics.
 */
function fallbackCircuitRoute(start: Coord, goal: Coord): readonly Coord[] {
  const route: Coord[] = [{ x: start.x, y: start.y }];
  let x = start.x;
  let y = start.y;
  while (x !== goal.x) {
    x += Math.sign(goal.x - x);
    route.push({ x, y });
  }
  while (y !== goal.y) {
    y += Math.sign(goal.y - y);
    route.push({ x, y });
  }
  return route;
}

function adjacentRouteSegments(route: readonly Coord[]): readonly (readonly [Coord, Coord])[] {
  const segments: (readonly [Coord, Coord])[] = [];
  for (let index = 1; index < route.length; index += 1) {
    segments.push([route[index - 1]!, route[index]!]);
  }
  return segments;
}

function circuitLinkLocalZ(level: LevelDefinition, coord: Coord): number {
  const cell = level.cells[coord.y * level.width + coord.x];
  // BOARD_LAYER_Z.links supplies the first 0.065 cells. Bulkhead conduits rise
  // above the model's ~0.56-cell top instead of disappearing inside the wall.
  return cell?.terrain === "bulkhead" ? 0.54 : 0;
}

function markInstancesChanged(mesh: THREE.InstancedMesh): void {
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  // InstancedMesh.raycast lazily caches aggregate bounds. Turn updates can move
  // the only instance several cells, so stale bounds would reject a valid tall
  // model before per-instance picking runs.
  mesh.boundingBox = null;
  mesh.boundingSphere = null;
}

function layerRenderOrder(name: string): number {
  if (name.includes("terrain")) return 10;
  if (name.includes("fixture")) return 30;
  if (name.includes("channel")) return 40;
  if (name.includes("objects") || name.includes("droid")) return 50;
  if (name.includes("powered")) return 60;
  return 70;
}
