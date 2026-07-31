import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/**
 * Code-native, material-free 3D models for Hullshift's moving board occupants.
 *
 * Coordinates use the board convention: X/Y are the cell plane and +Z rises
 * from the deck. Each material role is merged into one geometry so integration
 * needs at most one InstancedMesh per model kind and role. A descriptor owns
 * its geometries; meshes that reference them do not. Call the idempotent
 * `disposeHullshiftOccupantModel` once when the owning render layers are torn
 * down.
 */

export const HULLSHIFT_OCCUPANT_MODEL_KINDS = [
  "maintenance-droid",
  "cargo",
  "reactor-cell",
] as const;

export const HULLSHIFT_OCCUPANT_MATERIAL_ROLES = [
  "base",
  "detail",
  "emissive",
] as const;

export type HullshiftOccupantModelKind =
  (typeof HULLSHIFT_OCCUPANT_MODEL_KINDS)[number];
export type HullshiftOccupantMaterialRole =
  (typeof HULLSHIFT_OCCUPANT_MATERIAL_ROLES)[number];

export interface HullshiftOccupantModelPart {
  readonly role: HullshiftOccupantMaterialRole;
  readonly semantic: string;
  readonly geometry: THREE.BufferGeometry;
}

export interface HullshiftOccupantModelBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export interface HullshiftInstalledPlacement {
  /** Uniform scale retains the loose model's silhouette and proportions. */
  readonly scale: number;
  /** Added by the socket layer so the same model sits visibly above its cradle. */
  readonly zOffset: number;
}

export interface HullshiftOccupantModelDescriptor {
  readonly kind: HullshiftOccupantModelKind;
  readonly semantic: string;
  readonly parts: readonly HullshiftOccupantModelPart[];
  readonly bounds: HullshiftOccupantModelBounds;
  readonly movable: true;
  readonly dockable: boolean;
  /** Only reactor cells have a socket-mounted presentation. */
  readonly installedPlacement: HullshiftInstalledPlacement | null;
}

const disposedModels = new WeakSet<HullshiftOccupantModelDescriptor>();

export function createHullshiftOccupantModel(
  kind: HullshiftOccupantModelKind,
): HullshiftOccupantModelDescriptor {
  switch (kind) {
    case "maintenance-droid": return createMaintenanceDroidModel();
    case "cargo": return createCargoPodModel();
    case "reactor-cell": return createReactorCellModel();
  }
}

/** White service robot with a steel undercarriage and broad cyan sensor visor. */
export function createMaintenanceDroidModel(): HullshiftOccupantModelDescriptor {
  const base = mergeModelRole("maintenance-droid", "base", [
    // A compact chamfered pressure shell gives the robot a broad top-view body.
    chamferedPrism(0.38, 0.42, 0.3, 0.13, 0.055),
    transformed(new THREE.SphereGeometry(0.22, 8, 6), {
      position: [0, -0.035, 0.59],
      scale: [1, 0.94, 0.9],
    }),
    // Shoulder shells keep the droid recognizable when the face is partly
    // hidden by the camera tilt or a neighboring tall fixture.
    transformed(new THREE.SphereGeometry(0.095, 8, 4), {
      position: [-0.23, 0.005, 0.39],
      scale: [0.9, 1, 1.08],
    }),
    transformed(new THREE.SphereGeometry(0.095, 8, 4), {
      position: [0.23, 0.005, 0.39],
      scale: [0.9, 1, 1.08],
    }),
  ]);

  const detail = mergeModelRole("maintenance-droid", "detail", [
    verticalCylinder(0.145, 0.09, 8, 0.105),
    // Fixed tool arms: the droid has no gameplay-facing state, so the model
    // always retains this canonical orientation while walking and pushing.
    verticalCylinder(0.05, 0.25, 8, 0.285, -0.245, 0.012),
    verticalCylinder(0.05, 0.25, 8, 0.285, 0.245, 0.012),
    chamferedPrism(0.16, 0.21, 0.11, 0.025, 0.025, -0.145, 0.105),
    chamferedPrism(0.16, 0.21, 0.11, 0.025, 0.025, 0.145, 0.105),
    transformed(new THREE.TorusGeometry(0.125, 0.026, 4, 8), {
      position: [0, -0.02, 0.465],
      rotation: [0, 0, Math.PI / 8],
    }),
    chamferedPrism(0.27, 0.1, 0.13, 0.31, 0.025, 0, 0.17),
  ]);

  const emissive = mergeModelRole("maintenance-droid", "emissive", [
    // The visor is deliberately laid across the forward crown instead of only
    // a vertical face, so it survives a steep top-down camera at 24 px/cell.
    chamferedPrism(0.3, 0.13, 0.035, 0.755, 0.025, 0, -0.105),
    verticalCylinder(0.052, 0.045, 8, 0.795, 0, 0.075),
  ]);

  return modelDescriptor("maintenance-droid", [base, detail, emissive], {
    movable: true,
    dockable: false,
    installedPlacement: null,
  });
}

/** Low beveled mass pod with raised corner lugs and unmistakable cross-straps. */
export function createCargoPodModel(): HullshiftOccupantModelDescriptor {
  const base = mergeModelRole("cargo", "base", [
    chamferedPrism(0.67, 0.67, 0.4, 0.045, 0.075),
    chamferedPrism(0.56, 0.56, 0.09, 0.42, 0.06),
  ]);

  const detail = mergeModelRole("cargo", "detail", [
    // Thick top restraint rails remain more than one final render pixel at
    // the minimum supported 24 CSS pixels per cell.
    chamferedPrism(0.72, 0.14, 0.065, 0.475, 0.025),
    chamferedPrism(0.14, 0.72, 0.065, 0.475, 0.025),
    ...cornerPrisms(0.145, 0.145, 0.13, 0.445, 0.29),
  ]);

  const emissive = mergeModelRole("cargo", "emissive", [
    chamferedPrism(0.25, 0.09, 0.025, 0.548, 0.015, 0, -0.255),
    chamferedPrism(0.25, 0.09, 0.025, 0.548, 0.015, 0, 0.255),
  ]);

  return modelDescriptor("cargo", [base, detail, emissive], {
    movable: true,
    dockable: false,
    installedPlacement: null,
  });
}

/**
 * Tall octagonal power canister with radial terminals and an exposed core.
 *
 * The socket-mounted state must instance these exact same part geometries. The
 * optional installed placement only nests the intact canister above the socket;
 * it never substitutes a disc, halo, or other loss of reactor identity.
 */
export function createReactorCellModel(): HullshiftOccupantModelDescriptor {
  const base = mergeModelRole("reactor-cell", "base", [
    verticalCylinder(0.285, 0.45, 8, 0.29, 0, 0, 0.225),
    verticalCylinder(0.315, 0.15, 8, 0.31),
    verticalCylinder(0.225, 0.1, 8, 0.565),
  ]);

  const detail = mergeModelRole("reactor-cell", "detail", [
    transformed(new THREE.TorusGeometry(0.275, 0.038, 4, 8), {
      position: [0, 0, 0.135],
      rotation: [0, 0, Math.PI / 8],
    }),
    transformed(new THREE.TorusGeometry(0.275, 0.038, 4, 8), {
      position: [0, 0, 0.485],
      rotation: [0, 0, Math.PI / 8],
    }),
    ...radialTerminalPrisms(),
  ]);

  const emissive = mergeModelRole("reactor-cell", "emissive", [
    // A faceted core stays the dominant top-view cue both loose and installed.
    transformed(new THREE.OctahedronGeometry(0.155, 0), {
      position: [0, 0, 0.72],
      rotation: [0, 0, Math.PI / 4],
      scale: [1, 1, 0.82],
    }),
    ...radialCoreSlots(),
  ]);

  return modelDescriptor("reactor-cell", [base, detail, emissive], {
    movable: true,
    dockable: true,
    installedPlacement: Object.freeze({ scale: 0.88, zOffset: 0.13 }),
  });
}

/** Safe even when loose and installed layers share the descriptor geometries. */
export function disposeHullshiftOccupantModel(
  model: HullshiftOccupantModelDescriptor,
): void {
  if (disposedModels.has(model)) return;
  disposedModels.add(model);
  for (const part of model.parts) part.geometry.dispose();
}

function modelDescriptor(
  kind: HullshiftOccupantModelKind,
  geometries: readonly THREE.BufferGeometry[],
  behavior: Pick<
    HullshiftOccupantModelDescriptor,
    "movable" | "dockable" | "installedPlacement"
  >,
): HullshiftOccupantModelDescriptor {
  const parts = HULLSHIFT_OCCUPANT_MATERIAL_ROLES.map((role, index) => {
    const geometry = geometries[index];
    if (geometry === undefined) throw new Error(`Missing ${kind} ${role} geometry`);
    const semantic = `occupant:${kind}:${role}`;
    geometry.name = semantic;
    geometry.userData.hullshiftSemantic = semantic;
    geometry.userData.hullshiftMaterialRole = role;
    return Object.freeze({ role, semantic, geometry });
  });
  const bounds = combinedBounds(parts.map((part) => part.geometry));
  return Object.freeze({
    kind,
    semantic: `occupant:${kind}`,
    parts: Object.freeze(parts),
    bounds,
    ...behavior,
  });
}

function mergeModelRole(
  kind: HullshiftOccupantModelKind,
  role: HullshiftOccupantMaterialRole,
  sources: readonly THREE.BufferGeometry[],
): THREE.BufferGeometry {
  // Three's primitives mix indexed (sphere/cylinder) and non-indexed
  // (extrusion/polyhedron) buffers. Normalize ownership-local sources before
  // merging so every role remains one renderer-friendly BufferGeometry.
  const normalized = sources.map((source) => (
    source.index === null ? source : source.toNonIndexed()
  ));
  const merged = mergeGeometries(normalized, false);
  for (const geometry of normalized) {
    if (!sources.includes(geometry)) geometry.dispose();
  }
  for (const source of sources) source.dispose();
  if (merged === null) {
    throw new Error(`Could not merge ${kind} ${role} model geometry`);
  }
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
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
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(...position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)),
    new THREE.Vector3(...scale),
  );
  geometry.applyMatrix4(matrix);
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

function cornerPrisms(
  width: number,
  depth: number,
  height: number,
  bottomZ: number,
  offset: number,
): THREE.BufferGeometry[] {
  return [
    [-offset, -offset],
    [offset, -offset],
    [offset, offset],
    [-offset, offset],
  ].map(([x, y]) => chamferedPrism(width, depth, height, bottomZ, 0.025, x!, y!));
}

function radialTerminalPrisms(): THREE.BufferGeometry[] {
  return [0, 1, 2, 3].map((turn) => {
    const angle = turn * Math.PI / 2;
    return transformed(
      chamferedPrism(0.13, 0.17, 0.16, 0.52, 0.025),
      {
        position: [Math.cos(angle) * 0.285, Math.sin(angle) * 0.285, 0],
        rotation: [0, 0, angle],
      },
    );
  });
}

function radialCoreSlots(): THREE.BufferGeometry[] {
  return [0, 1, 2, 3].map((turn) => {
    const angle = turn * Math.PI / 2;
    return transformed(
      chamferedPrism(0.09, 0.16, 0.035, 0.61, 0.018),
      {
        position: [Math.cos(angle) * 0.205, Math.sin(angle) * 0.205, 0],
        rotation: [0, 0, angle],
      },
    );
  });
}

function combinedBounds(
  geometries: readonly THREE.BufferGeometry[],
): HullshiftOccupantModelBounds {
  const bounds = new THREE.Box3();
  for (const geometry of geometries) {
    geometry.computeBoundingBox();
    if (geometry.boundingBox !== null) bounds.union(geometry.boundingBox);
  }
  if (bounds.isEmpty()) throw new Error("Hullshift occupant model has no geometry bounds");
  return Object.freeze({
    min: Object.freeze(bounds.min.toArray() as [number, number, number]),
    max: Object.freeze(bounds.max.toArray() as [number, number, number]),
  });
}
