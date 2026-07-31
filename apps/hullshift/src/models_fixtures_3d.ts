import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/**
 * Code-native, material-free 3D models for Hullshift's board fixtures.
 *
 * Model space follows the board convention: X/Y span one logical cell and +Z
 * rises from the deck. Each state and material role is merged into at most one
 * BufferGeometry, allowing the renderer to keep one InstancedMesh per
 * kind/state/role instead of creating a Group for every cell.
 *
 * Descriptors own their geometries. Call `disposeHullshiftFixtureModel` once
 * when the render layers that consume them are torn down. Preview meshes share
 * descriptor geometries and caller-owned materials, so neither preview helper
 * disposes those resources.
 */

export const HULLSHIFT_FIXTURE_MODEL_KINDS = [
  "plate",
  "relay",
  "socket",
  "door",
  "bridge",
  "disposal",
  "gate",
] as const;

export const HULLSHIFT_FIXTURE_MATERIAL_ROLES = [
  "base",
  "detail",
  "emissive",
] as const;

export const HULLSHIFT_FIXTURE_MODEL_STATES = Object.freeze({
  plate: Object.freeze(["released", "depressed"] as const),
  relay: Object.freeze(["off", "on"] as const),
  socket: Object.freeze(["empty", "installed"] as const),
  door: Object.freeze(["closed", "open", "jammed"] as const),
  bridge: Object.freeze(["inactive", "active"] as const),
  disposal: Object.freeze(["idle"] as const),
  gate: Object.freeze(["locked", "ready"] as const),
});

export type HullshiftFixtureModelKind =
  (typeof HULLSHIFT_FIXTURE_MODEL_KINDS)[number];
export type HullshiftFixtureMaterialRole =
  (typeof HULLSHIFT_FIXTURE_MATERIAL_ROLES)[number];
export type HullshiftFixtureModelState =
  (typeof HULLSHIFT_FIXTURE_MODEL_STATES)[HullshiftFixtureModelKind][number];

export interface HullshiftFixtureModelPart {
  readonly role: HullshiftFixtureMaterialRole;
  readonly semantic: string;
  readonly geometry: THREE.BufferGeometry;
}

export interface HullshiftFixtureModelBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export interface HullshiftFixtureModelVariant {
  readonly state: HullshiftFixtureModelState;
  readonly semantic: string;
  /** Exactly one merged geometry per role; all transforms are already baked. */
  readonly parts: readonly HullshiftFixtureModelPart[];
  readonly bounds: HullshiftFixtureModelBounds;
}

export interface HullshiftFixtureModelDescriptor {
  readonly kind: HullshiftFixtureModelKind;
  readonly semantic: string;
  readonly variants: readonly HullshiftFixtureModelVariant[];
  /** Union of every state variant, useful for conservative camera culling. */
  readonly bounds: HullshiftFixtureModelBounds;
  /** Installed sockets mount the separately batched reactor model at this Z. */
  readonly reactorMountZ: number | null;
  /** A contract to reuse the occupant model; no fixture part duplicates it. */
  readonly nestedModelKind: "reactor-cell" | null;
}

export type HullshiftFixturePreviewMaterials = Readonly<
  Record<HullshiftFixtureMaterialRole, THREE.Material>
>;

const disposedModels = new WeakSet<HullshiftFixtureModelDescriptor>();

export function createHullshiftFixtureModel(
  kind: HullshiftFixtureModelKind,
): HullshiftFixtureModelDescriptor {
  switch (kind) {
    case "plate": return createMassPlateModel();
    case "relay": return createRelayModel();
    case "socket": return createReactorSocketModel();
    case "door": return createBlastDoorModel();
    case "bridge": return createPhaseBridgeModel();
    case "disposal": return createDisposalAirlockModel();
    case "gate": return createEvacuationGateModel();
  }
}

/**
 * Momentary universal-mass plate. The released piston stands proud of its
 * protective rim; the depressed state visibly sinks below that rim and exposes
 * four sustained channel windows. Player, pod, and undocked cell use the same
 * model because their mass rule is identical.
 */
export function createMassPlateModel(): HullshiftFixtureModelDescriptor {
  const released = variant("plate", "released", "raised universal-mass piston", {
    base: [
      chamferedPrism(0.84, 0.84, 0.1, 0.015, 0.075),
      ...cornerFeet(0.13, 0.13, 0.08, 0.07, 0.345),
    ],
    detail: [
      verticalCylinder(0.345, 0.08, 12, 0.145),
      verticalCylinder(0.275, 0.085, 12, 0.225),
      ...radialBars(0.14, 0.075, 0.065, 0.16, 0.31),
    ],
    emissive: [
      torus(0.265, 0.035, 4, 12, 0, 0, 0.275, Math.PI / 12),
      verticalCylinder(0.07, 0.025, 8, 0.285),
    ],
  });
  const depressed = variant("plate", "depressed", "sunken mass piston with exposed status windows", {
    base: [
      chamferedPrism(0.84, 0.84, 0.1, 0.015, 0.075),
      ...cornerFeet(0.13, 0.13, 0.08, 0.07, 0.345),
      // The outer guard remains high while the loaded piston sinks inside it.
      torus(0.34, 0.045, 4, 12, 0, 0, 0.14, Math.PI / 12),
    ],
    detail: [
      verticalCylinder(0.28, 0.07, 12, 0.145),
      ...radialBars(0.14, 0.075, 0.05, 0.13, 0.31),
    ],
    emissive: [
      torus(0.255, 0.035, 4, 12, 0, 0, 0.19, Math.PI / 12),
      ...radialBars(0.12, 0.07, 0.025, 0.175, 0.315),
    ],
  });
  return fixtureDescriptor(
    "plate",
    "momentary any-mass pressure plate",
    [released, depressed],
  );
}

/**
 * Persistent player-entry relay. Its lever physically throws between two
 * detents, while the lit terminal follows the lever. That remembered binary
 * position remains legible without color or animation.
 */
export function createRelayModel(): HullshiftFixtureModelDescriptor {
  const makeState = (state: "off" | "on"): HullshiftFixtureModelVariant => {
    const direction = state === "on" ? 1 : -1;
    const leverAngle = direction * 0.5;
    return variant("relay", state, `${state} latched lever at ${state} detent`, {
      base: [
        chamferedPrism(0.82, 0.78, 0.12, 0.015, 0.085),
        chamferedPrism(0.62, 0.54, 0.08, 0.12, 0.075),
      ],
      detail: [
        verticalCylinder(0.13, 0.18, 10, 0.28),
        // Opposed, hexagonal detent towers establish a permanent two-position
        // mechanism rather than another square floor marking.
        verticalCylinder(0.105, 0.2, 6, 0.25, -0.285, 0),
        verticalCylinder(0.105, 0.2, 6, 0.25, 0.285, 0),
        box(0.47, 0.105, 0.11, direction * 0.045, 0, 0.42, leverAngle),
        verticalCylinder(0.105, 0.115, 8, 0.49,
          Math.cos(leverAngle) * direction * 0.24,
          Math.sin(leverAngle) * direction * 0.24),
      ],
      emissive: [
        verticalCylinder(0.075, 0.035, 8, 0.37, direction * 0.285, 0),
        torus(0.13, 0.025, 4, 10, 0, 0, 0.38),
      ],
    });
  };
  return fixtureDescriptor(
    "relay",
    "persistent player-entry toggle relay",
    [makeState("off"), makeState("on")],
  );
}

/**
 * Empty keyed cradle and permanently installed clamp state. The installed
 * variant deliberately contains no reactor geometry: integration must reuse
 * the exact `reactor-cell` occupant descriptor at `reactorMountZ` so the player
 * still sees the original object inside its three closed jaws.
 */
export function createReactorSocketModel(): HullshiftFixtureModelDescriptor {
  const empty = variant("socket", "empty", "open three-jaw keyed reactor cradle", {
    base: [
      verticalCylinder(0.42, 0.11, 12, 0.07),
      torus(0.3, 0.07, 4, 12, 0, 0, 0.16, Math.PI / 12),
    ],
    detail: [
      ...radialClampJaws(false),
      verticalCylinder(0.13, 0.045, 8, 0.15),
    ],
    emissive: [
      ...radialSocketKeys(0.16),
      torus(0.15, 0.026, 4, 12, 0, 0, 0.18, Math.PI / 12),
    ],
  });
  const installed = variant("socket", "installed", "raised clamps locked around retained reactor", {
    base: [
      verticalCylinder(0.42, 0.11, 12, 0.07),
      torus(0.31, 0.075, 4, 12, 0, 0, 0.17, Math.PI / 12),
    ],
    detail: [
      ...radialClampJaws(true),
      // Three upper collars remain outside the nested reactor's silhouette.
      ...radialBars(0.16, 0.1, 0.18, 0.3, 0.335, Math.PI / 6),
    ],
    emissive: [
      ...radialSocketKeys(0.49),
      torus(0.31, 0.027, 4, 12, 0, 0, 0.22, Math.PI / 12),
    ],
  });
  return fixtureDescriptor(
    "socket",
    "irreversible keyed reactor-cell socket",
    [empty, installed],
    { reactorMountZ: 0.13, nestedModelKind: "reactor-cell" },
  );
}

/**
 * Blast shutter with a true clear aperture when open. Closed leaves meet at a
 * toothed center seam. Jammed leaves stop at visibly unequal positions and a
 * diagonal arrest brace explains why the occupied doorway did not crush shut.
 */
export function createBlastDoorModel(): HullshiftFixtureModelDescriptor {
  const commonBase = (): THREE.BufferGeometry[] => [
    box(0.9, 0.11, 0.15, 0, -0.385, 0.1),
    box(0.9, 0.11, 0.15, 0, 0.385, 0.1),
    box(0.13, 0.62, 0.22, -0.4, 0, 0.14),
    box(0.13, 0.62, 0.22, 0.4, 0, 0.14),
    verticalCylinder(0.095, 0.22, 8, 0.24, -0.36, -0.29),
    verticalCylinder(0.095, 0.22, 8, 0.24, 0.36, 0.29),
  ];
  const closed = variant("door", "closed", "opposed blast leaves locked at toothed seam", {
    base: commonBase(),
    detail: [
      shutterLeaf(-0.195, -1),
      shutterLeaf(0.195, 1),
      ...doorSeamTeeth(),
    ],
    emissive: [
      box(0.08, 0.5, 0.035, -0.055, 0, 0.47),
      box(0.08, 0.5, 0.035, 0.055, 0, 0.47),
    ],
  });
  const open = variant("door", "open", "blast leaves fully retracted around clear aperture", {
    base: commonBase(),
    detail: [
      shutterLeaf(-0.345, -1, 0.12),
      shutterLeaf(0.345, 1, 0.12),
      box(0.08, 0.54, 0.15, -0.29, 0, 0.31),
      box(0.08, 0.54, 0.15, 0.29, 0, 0.31),
    ],
    emissive: [
      box(0.055, 0.58, 0.035, -0.31, 0, 0.48),
      box(0.055, 0.58, 0.035, 0.31, 0, 0.48),
    ],
  });
  const jammed = variant("door", "jammed", "uneven open shutters held by arrest brace", {
    base: commonBase(),
    detail: [
      shutterLeaf(-0.31, -1, 0.16),
      shutterLeaf(0.275, 1, 0.18),
      box(0.54, 0.075, 0.09, 0.015, 0.19, 0.47, -0.32),
    ],
    emissive: [
      box(0.07, 0.2, 0.035, -0.255, -0.2, 0.49),
      box(0.07, 0.2, 0.035, 0.225, 0.2, 0.49),
      box(0.16, 0.07, 0.035, 0, 0.2, 0.53, -0.32),
    ],
  });
  return fixtureDescriptor(
    "door",
    "powered blast shutter with occupied-cell jam state",
    [closed, open, jammed],
  );
}

/**
 * Projector bridge over real negative space. Inactive projectors point over an
 * empty center. Active state adds a cross-ribbed physical energy deck, so its
 * traversability is communicated by support geometry as well as glow.
 */
export function createPhaseBridgeModel(): HullshiftFixtureModelDescriptor {
  const projectorBase = (): THREE.BufferGeometry[] => [
    chamferedPrism(0.15, 0.3, 0.18, 0.02, 0.025, -0.37, 0),
    chamferedPrism(0.15, 0.3, 0.18, 0.02, 0.025, 0.37, 0),
    chamferedPrism(0.3, 0.15, 0.18, 0.02, 0.025, 0, -0.37),
    chamferedPrism(0.3, 0.15, 0.18, 0.02, 0.025, 0, 0.37),
  ];
  const inactive = variant("bridge", "inactive", "four dormant projectors over visible void", {
    base: projectorBase(),
    detail: [
      box(0.16, 0.08, 0.1, -0.285, 0, 0.23),
      box(0.16, 0.08, 0.1, 0.285, 0, 0.23),
      box(0.08, 0.16, 0.1, 0, -0.285, 0.23),
      box(0.08, 0.16, 0.1, 0, 0.285, 0.23),
    ],
    emissive: [
      box(0.045, 0.16, 0.035, -0.285, 0, 0.3),
      box(0.045, 0.16, 0.035, 0.285, 0, 0.3),
      box(0.16, 0.045, 0.035, 0, -0.285, 0.3),
      box(0.16, 0.045, 0.035, 0, 0.285, 0.3),
    ],
  });
  const active = variant("bridge", "active", "cross-ribbed supported phase deck", {
    base: projectorBase(),
    detail: [
      // Broad separated ribs leave the vacuum visible between them but form a
      // continuous, unmistakably traversable deck at minimum cell size.
      ...[-0.28, -0.14, 0, 0.14, 0.28].map((y) =>
        chamferedPrism(0.68, 0.09, 0.07, 0.085, 0.018, 0, y)),
      box(0.08, 0.72, 0.09, -0.31, 0, 0.14),
      box(0.08, 0.72, 0.09, 0.31, 0, 0.14),
    ],
    emissive: [
      box(0.035, 0.7, 0.025, -0.255, 0, 0.205),
      box(0.035, 0.7, 0.025, 0.255, 0, 0.205),
      box(0.48, 0.035, 0.025, 0, 0, 0.21),
    ],
  });
  return fixtureDescriptor(
    "bridge",
    "powered phase bridge with visible unsupported void",
    [inactive, active],
  );
}

/**
 * A raised, one-way industrial hopper rather than a floor hole. Its broad rear
 * crusher housing blocks the droid; converging jaws and top-facing chevrons
 * communicate that pushed objects travel inward and disappear permanently.
 */
export function createDisposalAirlockModel(): HullshiftFixtureModelDescriptor {
  const idle = variant("disposal", "idle", "one-way cargo hopper with crusher throat", {
    base: [
      chamferedPrism(0.86, 0.8, 0.1, 0.01, 0.07),
      chamferedPrism(0.72, 0.22, 0.42, 0.1, 0.045, 0, 0.29),
      box(0.15, 0.58, 0.22, -0.34, -0.05, 0.21, -0.08),
      box(0.15, 0.58, 0.22, 0.34, -0.05, 0.21, 0.08),
    ],
    detail: [
      // Tapering teeth stop short of the center, preserving a literal dark
      // throat rather than drawing another filled tile emblem.
      hopperTooth(-0.2, -1),
      hopperTooth(0.2, 1),
      ...[-0.22, 0, 0.22].map((x) => box(0.11, 0.12, 0.12, x, 0.31, 0.58)),
      box(0.38, 0.08, 0.13, 0, -0.32, 0.16),
    ],
    emissive: [
      // Two large arrow stems and heads point into the raised throat.
      box(0.11, 0.2, 0.03, -0.13, -0.18, 0.14),
      box(0.11, 0.2, 0.03, 0.13, -0.18, 0.14),
      arrowHead(-0.13, -0.03, 0.16),
      arrowHead(0.13, -0.03, 0.16),
      box(0.42, 0.055, 0.03, 0, 0.22, 0.59),
    ],
  });
  return fixtureDescriptor(
    "disposal",
    "player-blocking one-way object disposal airlock",
    [idle],
  );
}

/**
 * Tall evacuation gantry. Locked state visibly fills the arch with opposed
 * armor and a crossbar; ready state retracts those blockers and raises an
 * outward arrow above a clear threshold. The open aperture, not green alone,
 * is the readiness cue.
 */
export function createEvacuationGateModel(): HullshiftFixtureModelDescriptor {
  const gateFrame = (): THREE.BufferGeometry[] => [
    chamferedPrism(0.22, 0.48, 0.64, 0.02, 0.035, -0.33, 0.15),
    chamferedPrism(0.22, 0.48, 0.64, 0.02, 0.035, 0.33, 0.15),
    chamferedPrism(0.82, 0.4, 0.18, 0.59, 0.04, 0, 0.15),
    box(0.76, 0.09, 0.12, 0, -0.35, 0.08),
  ];
  const locked = variant("gate", "locked", "armored evacuation arch with crossed lock", {
    base: gateFrame(),
    detail: [
      chamferedPrism(0.31, 0.57, 0.23, 0.09, 0.04, -0.16, 0.04),
      chamferedPrism(0.31, 0.57, 0.23, 0.09, 0.04, 0.16, 0.04),
      box(0.58, 0.095, 0.11, 0, 0.02, 0.39, Math.PI / 4),
      box(0.58, 0.095, 0.11, 0, 0.02, 0.39, -Math.PI / 4),
    ],
    emissive: [
      box(0.08, 0.34, 0.03, -0.27, 0.12, 0.7),
      box(0.08, 0.34, 0.03, 0.27, 0.12, 0.7),
      verticalCylinder(0.075, 0.035, 8, 0.55, 0, 0.1),
    ],
  });
  const ready = variant("gate", "ready", "clear evacuation arch with raised exit arrow", {
    base: gateFrame(),
    detail: [
      // Retracted leaves remain visible beside a genuinely empty center.
      chamferedPrism(0.12, 0.54, 0.2, 0.1, 0.025, -0.26, 0.04),
      chamferedPrism(0.12, 0.54, 0.2, 0.1, 0.025, 0.26, 0.04),
      box(0.14, 0.27, 0.08, 0, 0.07, 0.76),
      arrowHead(0, -0.115, 0.8, Math.PI),
    ],
    emissive: [
      box(0.065, 0.46, 0.035, -0.255, 0.08, 0.67),
      box(0.065, 0.46, 0.035, 0.255, 0.08, 0.67),
      box(0.46, 0.06, 0.035, 0, -0.27, 0.17),
      box(0.1, 0.22, 0.035, 0, 0.07, 0.85),
    ],
  });
  return fixtureDescriptor(
    "gate",
    "locked or ready evacuation exit gantry",
    [locked, ready],
  );
}

export function getHullshiftFixtureModelVariant(
  model: HullshiftFixtureModelDescriptor,
  state: HullshiftFixtureModelState,
): HullshiftFixtureModelVariant {
  const variant = model.variants.find((candidate) => candidate.state === state);
  if (variant === undefined) {
    throw new RangeError(`Fixture ${model.kind} has no ${state} model state`);
  }
  return variant;
}

/** Safe when multiple instanced layers share one descriptor. */
export function disposeHullshiftFixtureModel(
  model: HullshiftFixtureModelDescriptor,
): void {
  if (disposedModels.has(model)) return;
  disposedModels.add(model);
  for (const variant of model.variants) {
    for (const part of variant.parts) part.geometry.dispose();
  }
}

/**
 * Build a single-cell inspection preview without taking ownership of geometry
 * or materials. Production board rendering should instance descriptor parts.
 */
export function createHullshiftFixturePreview(
  model: HullshiftFixtureModelDescriptor,
  state: HullshiftFixtureModelState,
  materials: HullshiftFixturePreviewMaterials,
): THREE.Group {
  const variant = getHullshiftFixtureModelVariant(model, state);
  const group = new THREE.Group();
  group.name = variant.semantic;
  group.userData.hullshiftModelKind = model.kind;
  group.userData.hullshiftModelState = state;
  for (const part of variant.parts) {
    const mesh = new THREE.Mesh(part.geometry, materials[part.role]);
    mesh.name = part.semantic;
    mesh.castShadow = part.role !== "emissive";
    mesh.receiveShadow = part.role === "base";
    group.add(mesh);
  }
  return group;
}

/**
 * Adopt the exact supplied reactor Object3D into an installed socket preview.
 * The helper changes its parent/transform but never clones or disposes it, its
 * geometry, or its materials. Production uses the same transform on a
 * separately batched reactor-cell layer.
 */
export function attachReactorModelToInstalledSocket<T extends THREE.Object3D>(
  socketPreview: THREE.Group,
  socketModel: HullshiftFixtureModelDescriptor,
  reactorModel: T,
  scale = 0.88,
): T {
  if (socketModel.kind !== "socket"
    || socketModel.nestedModelKind !== "reactor-cell"
    || socketModel.reactorMountZ === null) {
    throw new TypeError("Only a reactor socket model can adopt a reactor-cell model");
  }
  reactorModel.position.set(0, 0, socketModel.reactorMountZ);
  reactorModel.scale.setScalar(scale);
  reactorModel.userData.hullshiftNestedModelKind = socketModel.nestedModelKind;
  socketPreview.add(reactorModel);
  return reactorModel;
}

interface VariantSources {
  readonly base: readonly THREE.BufferGeometry[];
  readonly detail: readonly THREE.BufferGeometry[];
  readonly emissive: readonly THREE.BufferGeometry[];
}

function variant(
  kind: HullshiftFixtureModelKind,
  state: HullshiftFixtureModelState,
  description: string,
  sources: VariantSources,
): HullshiftFixtureModelVariant {
  const parts = HULLSHIFT_FIXTURE_MATERIAL_ROLES.map((role) => {
    const semantic = `fixture:${kind}:${state}:${role}`;
    const geometry = mergeModelRole(kind, state, role, sources[role]);
    geometry.name = semantic;
    geometry.userData.hullshiftSemantic = semantic;
    geometry.userData.hullshiftMaterialRole = role;
    return Object.freeze({ role, semantic, geometry });
  });
  return Object.freeze({
    state,
    semantic: `fixture:${kind}:${state} — ${description}`,
    parts: Object.freeze(parts),
    bounds: combinedBounds(parts.map((part) => part.geometry)),
  });
}

function fixtureDescriptor(
  kind: HullshiftFixtureModelKind,
  semantic: string,
  variants: readonly HullshiftFixtureModelVariant[],
  nested: Readonly<{
    reactorMountZ: number;
    nestedModelKind: "reactor-cell";
  }> | null = null,
): HullshiftFixtureModelDescriptor {
  return Object.freeze({
    kind,
    semantic: `fixture:${kind} — ${semantic}`,
    variants: Object.freeze(variants),
    bounds: combinedBounds(
      variants.flatMap((entry) => entry.parts.map((part) => part.geometry)),
    ),
    reactorMountZ: nested?.reactorMountZ ?? null,
    nestedModelKind: nested?.nestedModelKind ?? null,
  });
}

function mergeModelRole(
  kind: HullshiftFixtureModelKind,
  state: HullshiftFixtureModelState,
  role: HullshiftFixtureMaterialRole,
  sources: readonly THREE.BufferGeometry[],
): THREE.BufferGeometry {
  if (sources.length === 0) {
    throw new Error(`Fixture ${kind}:${state}:${role} has no authored geometry`);
  }
  const normalized = sources.map((source) => (
    source.index === null ? source : source.toNonIndexed()
  ));
  const merged = mergeGeometries(normalized, false);
  for (const geometry of normalized) {
    if (!sources.includes(geometry)) geometry.dispose();
  }
  for (const source of sources) source.dispose();
  if (merged === null) {
    throw new Error(`Could not merge fixture ${kind}:${state}:${role} geometry`);
  }
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

function combinedBounds(
  geometries: readonly THREE.BufferGeometry[],
): HullshiftFixtureModelBounds {
  const bounds = new THREE.Box3();
  for (const geometry of geometries) {
    geometry.computeBoundingBox();
    if (geometry.boundingBox !== null) bounds.union(geometry.boundingBox);
  }
  if (bounds.isEmpty()) throw new Error("Hullshift fixture model has no geometry bounds");
  return Object.freeze({
    min: Object.freeze(bounds.min.toArray() as [number, number, number]),
    max: Object.freeze(bounds.max.toArray() as [number, number, number]),
  });
}

interface TransformOptions {
  readonly position?: readonly [number, number, number];
  readonly rotation?: readonly [number, number, number];
  readonly scale?: readonly [number, number, number];
}

function transformed<T extends THREE.BufferGeometry>(
  geometry: T,
  options: TransformOptions,
): T {
  const position = options.position ?? [0, 0, 0];
  const rotation = options.rotation ?? [0, 0, 0];
  const scale = options.scale ?? [1, 1, 1];
  geometry.applyMatrix4(new THREE.Matrix4().compose(
    new THREE.Vector3(...position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)),
    new THREE.Vector3(...scale),
  ));
  return geometry;
}

function chamferedPrism(
  width: number,
  depth: number,
  height: number,
  bottomZ: number,
  chamfer: number,
  centerX = 0,
  centerY = 0,
): THREE.ExtrudeGeometry {
  const halfWidth = width / 2;
  const halfDepth = depth / 2;
  const corner = Math.min(chamfer, halfWidth * 0.45, halfDepth * 0.45);
  const shape = new THREE.Shape();
  shape.moveTo(-halfWidth + corner, -halfDepth);
  shape.lineTo(halfWidth - corner, -halfDepth);
  shape.lineTo(halfWidth, -halfDepth + corner);
  shape.lineTo(halfWidth, halfDepth - corner);
  shape.lineTo(halfWidth - corner, halfDepth);
  shape.lineTo(-halfWidth + corner, halfDepth);
  shape.lineTo(-halfWidth, halfDepth - corner);
  shape.lineTo(-halfWidth, -halfDepth + corner);
  shape.closePath();
  const bevelThickness = Math.min(0.025, height * 0.2);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.001, height - bevelThickness * 2),
    steps: 1,
    bevelEnabled: true,
    bevelSegments: 1,
    bevelSize: Math.min(0.018, corner * 0.4),
    bevelThickness,
    curveSegments: 1,
  });
  geometry.translate(centerX, centerY, bottomZ + bevelThickness);
  return geometry;
}

function box(
  width: number,
  depth: number,
  height: number,
  centerX: number,
  centerY: number,
  centerZ: number,
  rotationZ = 0,
): THREE.BoxGeometry {
  return transformed(new THREE.BoxGeometry(width, depth, height), {
    position: [centerX, centerY, centerZ],
    rotation: [0, 0, rotationZ],
  });
}

function verticalCylinder(
  radius: number,
  height: number,
  segments: number,
  centerZ: number,
  centerX = 0,
  centerY = 0,
  topRadius = radius,
): THREE.CylinderGeometry {
  const geometry = new THREE.CylinderGeometry(topRadius, radius, height, segments, 1, false);
  geometry.rotateX(Math.PI / 2);
  geometry.translate(centerX, centerY, centerZ);
  return geometry;
}

function torus(
  radius: number,
  tube: number,
  radialSegments: number,
  tubularSegments: number,
  centerX: number,
  centerY: number,
  centerZ: number,
  rotationZ = 0,
): THREE.TorusGeometry {
  return transformed(
    new THREE.TorusGeometry(radius, tube, radialSegments, tubularSegments),
    { position: [centerX, centerY, centerZ], rotation: [0, 0, rotationZ] },
  );
}

function cornerFeet(
  width: number,
  depth: number,
  height: number,
  centerZ: number,
  offset: number,
): THREE.BufferGeometry[] {
  return [
    [-offset, -offset], [offset, -offset], [offset, offset], [-offset, offset],
  ].map(([x, y]) => box(width, depth, height, x!, y!, centerZ));
}

function radialBars(
  width: number,
  depth: number,
  height: number,
  centerZ: number,
  radius: number,
  angularOffset = 0,
): THREE.BufferGeometry[] {
  return [0, 1, 2, 3].map((turn) => {
    const angle = angularOffset + turn * Math.PI / 2;
    return box(
      width,
      depth,
      height,
      Math.cos(angle) * radius,
      Math.sin(angle) * radius,
      centerZ,
      angle,
    );
  });
}

function radialClampJaws(installed: boolean): THREE.BufferGeometry[] {
  return [0, 1, 2].flatMap((turn) => {
    const angle = Math.PI / 2 + turn * Math.PI * 2 / 3;
    const radius = installed ? 0.34 : 0.39;
    const height = installed ? 0.4 : 0.17;
    const z = installed ? 0.35 : 0.24;
    return [
      box(0.2, 0.12, height, Math.cos(angle) * radius,
        Math.sin(angle) * radius, z, angle),
      verticalCylinder(0.075, 0.12, 8, installed ? 0.57 : 0.34,
        Math.cos(angle) * (radius - 0.08),
        Math.sin(angle) * (radius - 0.08)),
    ];
  });
}

function radialSocketKeys(centerZ: number): THREE.BufferGeometry[] {
  return [0, 1, 2].map((turn) => {
    const angle = Math.PI / 2 + turn * Math.PI * 2 / 3;
    return box(0.12, 0.055, 0.025,
      Math.cos(angle) * 0.33,
      Math.sin(angle) * 0.33,
      centerZ,
      angle);
  });
}

function shutterLeaf(
  centerX: number,
  direction: -1 | 1,
  width = 0.36,
): THREE.BufferGeometry {
  const half = width / 2;
  const innerX = centerX - direction * half;
  const outerX = centerX + direction * half;
  const points: readonly (readonly [number, number])[] = direction === 1
    ? [[innerX, -0.31], [outerX, -0.31], [outerX, 0.31], [innerX, 0.31],
      [innerX - 0.045, 0.2], [innerX, 0.1], [innerX - 0.045, 0],
      [innerX, -0.1], [innerX - 0.045, -0.2]]
    : [[outerX, -0.31], [innerX, -0.31], [innerX, -0.2],
      [innerX + 0.045, -0.1], [innerX, 0], [innerX + 0.045, 0.1],
      [innerX, 0.2], [innerX + 0.045, 0.31], [outerX, 0.31]];
  return extrudedPolygon(points, 0.32, 0.12, 0.018);
}

function doorSeamTeeth(): THREE.BufferGeometry[] {
  return [-0.21, -0.07, 0.07, 0.21].map((y, index) =>
    box(0.13, 0.075, 0.08, 0, y, 0.48, index % 2 === 0 ? 0.35 : -0.35));
}

function hopperTooth(centerX: number, direction: -1 | 1): THREE.BufferGeometry {
  const outer = centerX + direction * 0.13;
  const inner = centerX - direction * 0.09;
  return extrudedPolygon([
    [outer, -0.2], [outer, 0.18], [inner, 0.1], [inner, -0.08],
  ], 0.18, 0.18, 0.018);
}

function arrowHead(
  centerX: number,
  centerY: number,
  centerZ: number,
  rotationZ = 0,
): THREE.BufferGeometry {
  const geometry = extrudedPolygon([
    [-0.13, -0.09], [0.13, -0.09], [0, 0.12],
  ], 0.03, centerZ - 0.015, 0.008);
  return transformed(geometry, {
    position: [centerX, centerY, 0],
    rotation: [0, 0, rotationZ],
  });
}

function extrudedPolygon(
  points: readonly (readonly [number, number])[],
  height: number,
  bottomZ: number,
  bevel: number,
): THREE.ExtrudeGeometry {
  const first = points[0];
  if (first === undefined) throw new Error("Cannot extrude an empty fixture polygon");
  const shape = new THREE.Shape();
  shape.moveTo(first[0], first[1]);
  for (const point of points.slice(1)) shape.lineTo(point[0], point[1]);
  shape.closePath();
  const bevelThickness = Math.min(bevel, height * 0.2);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.001, height - bevelThickness * 2),
    steps: 1,
    bevelEnabled: bevel > 0,
    bevelSegments: 1,
    bevelSize: bevel,
    bevelThickness,
    curveSegments: 1,
  });
  geometry.translate(0, 0, bottomZ + bevelThickness);
  return geometry;
}
