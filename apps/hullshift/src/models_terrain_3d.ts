import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

export const HULLSHIFT_TERRAIN_MODEL_KINDS = [
  "floor",
  "bulkhead",
  "vacuum",
  "fracture",
] as const;

export type HullshiftTerrainModelKind =
  (typeof HULLSHIFT_TERRAIN_MODEL_KINDS)[number];

export interface HullshiftTerrainModelDescriptor {
  readonly kind: HullshiftTerrainModelKind;
  readonly semantic: string;
  /** One merged geometry keeps the terrain at one draw call per kind. */
  readonly geometry: THREE.BufferGeometry;
  readonly bounds: Readonly<{
    min: readonly [number, number, number];
    max: readonly [number, number, number];
  }>;
}

type Point = readonly [number, number];
const disposedModels = new WeakSet<HullshiftTerrainModelDescriptor>();

/**
 * Low-poly deck architecture authored in one-cell model space. Geometry owns
 * real Z depth; render layers supply deterministic instances and materials.
 */
export function createHullshiftTerrainModel(
  kind: HullshiftTerrainModelKind,
): HullshiftTerrainModelDescriptor {
  switch (kind) {
    case "floor":
      return descriptor(kind, "walkable beveled deck panel", mergeOwned([
        extrudedPanel(chamferedRectangle(0.91, 0.91, 0.075), {
          depth: 0.075,
          bevel: 0.025,
          z: -0.075,
        }),
        box(0.24, 0.045, 0.022, -0.21, 0.24, 0.018),
        box(0.045, 0.24, 0.022, 0.22, -0.2, 0.018),
        cylinder(0.035, 0.022, -0.33, -0.33, 0.02, 6),
        cylinder(0.035, 0.022, 0.33, 0.33, 0.02, 6),
      ], "terrain:floor"));
    case "bulkhead":
      return descriptor(kind, "tall reinforced hull wall", mergeOwned([
        extrudedPanel(chamferedRectangle(0.94, 0.94, 0.1), {
          depth: 0.5,
          bevel: 0.035,
          z: -0.04,
        }),
        box(0.68, 0.1, 0.07, 0, -0.27, 0.5),
        box(0.68, 0.1, 0.07, 0, 0, 0.5),
        box(0.68, 0.1, 0.07, 0, 0.27, 0.5),
        cylinder(0.055, 0.045, -0.32, -0.34, 0.52, 6),
        cylinder(0.055, 0.045, 0.32, -0.34, 0.52, 6),
        cylinder(0.055, 0.045, 0.32, 0.34, 0.52, 6),
        cylinder(0.055, 0.045, -0.32, 0.34, 0.52, 6),
      ], "terrain:bulkhead"));
    case "vacuum":
      // The center is deliberately geometry-free so the under-deck backdrop
      // is visible at z=-0.5 as a real recessed pit.
      return descriptor(kind, "open vacuum pit with broken rim teeth", mergeOwned([
        box(0.69, 0.12, 0.12, -0.08, 0.4, -0.045, -0.025),
        box(0.54, 0.12, 0.12, 0.12, -0.4, -0.045, 0.035),
        box(0.12, 0.58, 0.12, -0.4, -0.08, -0.045, 0.02),
        box(0.12, 0.72, 0.12, 0.4, 0.04, -0.045, -0.035),
        wedge([[-0.32, 0.34], [-0.11, 0.34], [-0.18, 0.17]], 0.09, -0.02),
        wedge([[0.34, -0.3], [0.34, -0.09], [0.17, -0.18]], 0.09, -0.02),
      ], "terrain:vacuum"));
    case "fracture":
      return descriptor(kind, "separated fractured deck shards", mergeOwned([
        shard([[-0.44, 0.43], [-0.08, 0.43], [-0.15, 0.1], [-0.43, 0.03]], -0.065, -0.02),
        shard([[0.01, 0.43], [0.44, 0.43], [0.43, 0.11], [0.11, 0.03]], -0.075, 0.012),
        shard([[-0.43, -0.03], [-0.15, 0.06], [-0.03, -0.18], [-0.28, -0.25], [-0.44, -0.18]], -0.08, 0.026),
        shard([[0.14, -0.01], [0.43, 0.07], [0.44, -0.3], [0.2, -0.22], [0.04, -0.14]], -0.07, -0.018),
        shard([[-0.44, -0.25], [-0.28, -0.31], [-0.05, -0.22], [-0.1, -0.44], [-0.43, -0.44]], -0.085, 0.01),
        shard([[0.01, -0.22], [0.19, -0.28], [0.44, -0.36], [0.43, -0.44], [-0.02, -0.44]], -0.075, -0.025),
      ], "terrain:fracture"));
  }
}

export function disposeHullshiftTerrainModel(
  model: HullshiftTerrainModelDescriptor,
): void {
  if (disposedModels.has(model)) return;
  disposedModels.add(model);
  model.geometry.dispose();
}

function descriptor(
  kind: HullshiftTerrainModelKind,
  semantic: string,
  geometry: THREE.BufferGeometry,
): HullshiftTerrainModelDescriptor {
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const bounds = geometry.boundingBox;
  if (bounds === null) throw new Error(`Hullshift ${kind} geometry has no bounds`);
  geometry.name = `Hullshift terrain model: ${kind}`;
  geometry.userData.hullshiftSemantic = semantic;
  return Object.freeze({
    kind,
    semantic,
    geometry,
    bounds: Object.freeze({
      min: Object.freeze(bounds.min.toArray() as [number, number, number]),
      max: Object.freeze(bounds.max.toArray() as [number, number, number]),
    }),
  });
}

function mergeOwned(
  geometries: readonly THREE.BufferGeometry[],
  name: string,
): THREE.BufferGeometry {
  // ExtrudeGeometry is non-indexed while Three's primitive geometries are
  // indexed. BufferGeometryUtils intentionally refuses to merge a mixed set,
  // so normalize the authored parts before assembling the one batched model.
  const mergeInputs = geometries.map((geometry) => (
    geometry.index === null ? geometry : geometry.toNonIndexed()
  ));
  const merged = mergeGeometries(mergeInputs, false);
  for (const geometry of mergeInputs) {
    if (!geometries.includes(geometry)) geometry.dispose();
  }
  for (const geometry of geometries) geometry.dispose();
  if (merged === null) throw new Error(`Could not merge Hullshift ${name} geometry`);
  merged.name = name;
  return merged;
}

function extrudedPanel(
  points: readonly Point[],
  options: Readonly<{ depth: number; bevel: number; z: number }>,
): THREE.ExtrudeGeometry {
  const shape = shapeFromPoints(points);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: options.depth,
    steps: 1,
    bevelEnabled: true,
    bevelSegments: 1,
    bevelSize: options.bevel,
    bevelThickness: options.bevel,
    curveSegments: 1,
  });
  geometry.translate(0, 0, options.z);
  return geometry;
}

function shard(
  points: readonly Point[],
  z: number,
  tilt: number,
): THREE.BufferGeometry {
  const geometry = extrudedPanel(points, { depth: 0.075, bevel: 0.012, z });
  geometry.rotateX(tilt);
  return geometry;
}

function wedge(
  points: readonly Point[],
  depth: number,
  z: number,
): THREE.BufferGeometry {
  return extrudedPanel(points, { depth, bevel: 0.008, z });
}

function box(
  width: number,
  height: number,
  depth: number,
  x: number,
  y: number,
  z: number,
  rotation = 0,
): THREE.BoxGeometry {
  const geometry = new THREE.BoxGeometry(width, height, depth, 1, 1, 1);
  geometry.rotateZ(rotation);
  geometry.translate(x, y, z + depth / 2);
  return geometry;
}

function cylinder(
  radius: number,
  depth: number,
  x: number,
  y: number,
  z: number,
  sides: number,
): THREE.CylinderGeometry {
  const geometry = new THREE.CylinderGeometry(radius, radius, depth, sides, 1, false);
  // CylinderGeometry is Y-up; board models use Z-up.
  geometry.rotateX(Math.PI / 2);
  geometry.translate(x, y, z + depth / 2);
  return geometry;
}

function shapeFromPoints(points: readonly Point[]): THREE.Shape {
  const first = points[0];
  const shape = new THREE.Shape();
  if (first === undefined) return shape;
  shape.moveTo(first[0], first[1]);
  for (const point of points.slice(1)) shape.lineTo(point[0], point[1]);
  shape.closePath();
  return shape;
}

function chamferedRectangle(
  width: number,
  height: number,
  chamfer: number,
): readonly Point[] {
  const x = width / 2;
  const y = height / 2;
  return [
    [-x + chamfer, -y], [x - chamfer, -y], [x, -y + chamfer],
    [x, y - chamfer], [x - chamfer, y], [-x + chamfer, y],
    [-x, y - chamfer], [-x, -y + chamfer],
  ];
}
