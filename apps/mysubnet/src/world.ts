import landTopologyData from "./land-110m.json";

export type GeoPoint = readonly [longitude: number, latitude: number];
export type GeoRing = GeoPoint[];
export type GeoPolygon = GeoRing[];

interface TopologyTransform {
  scale: [number, number];
  translate: [number, number];
}

interface TopologyGeometry {
  type: "Polygon" | "MultiPolygon" | "GeometryCollection";
  arcs?: number[][] | number[][][];
  geometries?: TopologyGeometry[];
}

interface LandTopology {
  type: "Topology";
  transform: TopologyTransform;
  arcs: Array<Array<[number, number]>>;
  objects: {
    land: TopologyGeometry;
  };
}

const topology = landTopologyData as unknown as LandTopology;

export function decodeLandPolygons(): GeoPolygon[] {
  const decodedArcs = new Map<number, GeoPoint[]>();

  function decodeArc(reference: number): GeoPoint[] {
    const index = reference < 0 ? ~reference : reference;
    let points = decodedArcs.get(index);

    if (!points) {
      const arc = topology.arcs[index];
      if (!arc) return [];

      let x = 0;
      let y = 0;
      points = arc.map(([deltaX, deltaY]) => {
        x += deltaX;
        y += deltaY;
        return [
          x * topology.transform.scale[0] + topology.transform.translate[0],
          y * topology.transform.scale[1] + topology.transform.translate[1],
        ] as GeoPoint;
      });
      decodedArcs.set(index, points);
    }

    return reference < 0 ? [...points].reverse() : points;
  }

  function stitchRing(references: number[]): GeoRing {
    const ring: GeoRing = [];

    references.forEach((reference, arcIndex) => {
      const arc = decodeArc(reference);
      ring.push(...(arcIndex === 0 ? arc : arc.slice(1)));
    });

    return ring;
  }

  function collect(geometry: TopologyGeometry): GeoPolygon[] {
    if (geometry.type === "GeometryCollection") {
      return (geometry.geometries ?? []).flatMap(collect);
    }

    if (geometry.type === "Polygon") {
      const rings = geometry.arcs as number[][] | undefined;
      return rings ? [rings.map(stitchRing)] : [];
    }

    const polygons = geometry.arcs as number[][][] | undefined;
    return polygons ? polygons.map((rings) => rings.map(stitchRing)) : [];
  }

  return collect(topology.objects.land);
}

export function createEarthTextureCanvas(): HTMLCanvasElement {
  const width = 1536;
  const height = 768;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas textures are unavailable in this browser.");
  }

  const landPaths = createLandPaths(width, height);
  const mask = document.createElement("canvas");
  mask.width = width;
  mask.height = height;
  const maskContext = mask.getContext("2d", { willReadFrequently: true });
  if (!maskContext) throw new Error("Land mask rendering is unavailable.");
  maskContext.fillStyle = "#ffffff";
  landPaths.forEach((path) => maskContext.fill(path, "evenodd"));
  const landMask = maskContext.getImageData(0, 0, width, height).data;
  const image = context.createImageData(width, height);

  for (let y = 0; y < height; y += 1) {
    const latitude = 90 - y / (height - 1) * 180;
    const absoluteLatitude = Math.abs(latitude);

    for (let x = 0; x < width; x += 1) {
      const longitude = x / (width - 1) * 360 - 180;
      const offset = (y * width + x) * 4;
      const noise = surfaceNoise(longitude, latitude);
      const isLand = landMask[offset + 3]! > 100;
      let red: number;
      let green: number;
      let blue: number;

      if (isLand) {
        const polar = smoothstep(58, 79, absoluteLatitude);
        const desertBand = 1 - Math.min(1, Math.abs(absoluteLatitude - 27) / 15);
        const aridSignal = smoothstep(0.48, 0.78, noise * 0.7 + desertBand * 0.42);
        const lushSignal = smoothstep(0.22, 0.67, 1 - noise + Math.max(0, 1 - absoluteLatitude / 48) * 0.2);
        const relief = (noise - 0.5) * 32;
        const temperate = [58 + relief, 121 + relief * 0.55, 71 + relief * 0.25];
        const lush = [37 + relief * 0.35, 132 + relief * 0.45, 78 + relief * 0.2];
        const arid = [167 + relief * 0.45, 137 + relief * 0.3, 76 + relief * 0.12];
        const vegetation = mixColor(temperate, lush, lushSignal * 0.64);
        const terrain = mixColor(vegetation, arid, aridSignal * (1 - polar));
        const snow = [194 + relief * 0.12, 216 + relief * 0.08, 213 + relief * 0.06];
        [red, green, blue] = mixColor(terrain, snow, polar);
      } else {
        const depth = noise * 24;
        const polarWater = smoothstep(70, 87, absoluteLatitude);
        const ocean = [7 + depth * 0.18, 64 + depth * 0.55, 105 + depth];
        const ice = [163, 207, 220];
        [red, green, blue] = mixColor(ocean, ice, polarWater * 0.72);
      }

      image.data[offset] = clampByte(red);
      image.data[offset + 1] = clampByte(green);
      image.data[offset + 2] = clampByte(blue);
      image.data[offset + 3] = 255;
    }
  }

  context.putImageData(image, 0, 0);
  context.strokeStyle = "rgba(180, 240, 208, 0.56)";
  context.lineWidth = 1.05;
  context.lineJoin = "round";
  landPaths.forEach((path) => context.stroke(path));

  return canvas;
}

export function createCloudTextureCanvas(): HTMLCanvasElement {
  const width = 768;
  const height = 384;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Cloud texture rendering is unavailable.");
  const image = context.createImageData(width, height);

  for (let y = 0; y < height; y += 1) {
    const v = y / height;
    const latitude = 90 - v * 180;
    const polarFade = 1 - smoothstep(68, 88, Math.abs(latitude));

    for (let x = 0; x < width; x += 1) {
      const u = x / width;
      const offset = (y * width + x) * 4;
      const warpedV = v + Math.sin(u * Math.PI * 4) * 0.018;
      const noise = fractalNoise(u, warpedV);
      const bands = 0.5 + 0.5 * Math.sin(latitude * Math.PI / 21 + noise * 3.1);
      const density = smoothstep(0.57, 0.76, noise + bands * 0.055) * polarFade;

      image.data[offset] = 226;
      image.data[offset + 1] = 244;
      image.data[offset + 2] = 250;
      image.data[offset + 3] = clampByte(density * 122);
    }
  }

  context.putImageData(image, 0, 0);
  return canvas;
}

function createLandPaths(width: number, height: number): Path2D[] {
  return decodeLandPolygons().map((polygon) => {
    const path = new Path2D();

    for (const ring of polygon) {
      const projected = unwrapRing(ring, width, height);
      for (const offset of [-width, 0, width]) {
        projected.forEach(([x, y], index) => {
          if (index === 0) path.moveTo(x + offset, y);
          else path.lineTo(x + offset, y);
        });
        path.closePath();
      }
    }

    return path;
  });
}

function surfaceNoise(longitude: number, latitude: number): number {
  const x = longitude * Math.PI / 180;
  const y = latitude * Math.PI / 180;
  const value = Math.sin(x * 2.7 + Math.sin(y * 3.1)) * 0.31
    + Math.sin(x * 6.2 - y * 4.4) * 0.19
    + Math.cos(x * 11.3 + y * 7.7) * 0.12
    + Math.sin(x * 19.1 - y * 13.2) * 0.07;
  return Math.max(0, Math.min(1, value * 0.72 + 0.5));
}

function fractalNoise(u: number, v: number): number {
  let total = 0;
  let weight = 0;
  let amplitude = 0.56;

  for (let octave = 0; octave < 5; octave += 1) {
    const periodX = 6 * 2 ** octave;
    const periodY = 3 * 2 ** octave;
    total += periodicValueNoise(u * periodX, v * periodY, periodX) * amplitude;
    weight += amplitude;
    amplitude *= 0.5;
  }

  return total / weight;
}

function periodicValueNoise(x: number, y: number, periodX: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = fade(x - x0);
  const ty = fade(y - y0);
  const left = modulo(x0, periodX);
  const right = modulo(x0 + 1, periodX);
  const topLeft = hashGrid(left, y0);
  const topRight = hashGrid(right, y0);
  const bottomLeft = hashGrid(left, y0 + 1);
  const bottomRight = hashGrid(right, y0 + 1);
  return lerp(lerp(topLeft, topRight, tx), lerp(bottomLeft, bottomRight, tx), ty);
}

function hashGrid(x: number, y: number): number {
  const value = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return value - Math.floor(value);
}

function fade(value: number): number {
  return value * value * (3 - 2 * value);
}

function modulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function lerp(start: number, end: number, amount: number): number {
  return start + (end - start) * amount;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const amount = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return amount * amount * (3 - 2 * amount);
}

function mixColor(start: number[], end: number[], amount: number): [number, number, number] {
  return [
    lerp(start[0]!, end[0]!, amount),
    lerp(start[1]!, end[1]!, amount),
    lerp(start[2]!, end[2]!, amount),
  ];
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function unwrapRing(
  ring: GeoRing,
  width: number,
  height: number,
): Array<readonly [number, number]> {
  const points: Array<readonly [number, number]> = [];
  let previousX: number | null = null;
  let wrapOffset = 0;

  for (const [longitude, latitude] of ring) {
    const baseX = longitudeToX(longitude, width);
    let x = baseX + wrapOffset;

    if (previousX !== null) {
      const difference = x - previousX;
      if (difference > width / 2) {
        wrapOffset -= width;
        x -= width;
      } else if (difference < -width / 2) {
        wrapOffset += width;
        x += width;
      }
    }

    points.push([x, latitudeToY(latitude, height)]);
    previousX = x;
  }

  return points;
}

function longitudeToX(longitude: number, width: number): number {
  return (longitude + 180) / 360 * width;
}

function latitudeToY(latitude: number, height: number): number {
  return (90 - latitude) / 180 * height;
}
