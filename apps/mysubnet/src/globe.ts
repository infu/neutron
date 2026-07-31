import * as THREE from "three";
import {
  Lensflare,
  LensflareElement,
} from "three/addons/objects/Lensflare.js";
import type { SubnetNode } from "./registry";
import {
  createCloudTextureCanvas,
  createEarthTextureCanvas,
} from "./world";

const EARTH_RADIUS = 1.52;
const MARKER_RADIUS = EARTH_RADIUS + 0.072;
const FIT_RADIUS = 1.76;
const FIT_PADDING = 1.2;
const SUN_Z = 1;

interface GlobeOptions {
  host: HTMLElement;
}

interface MarkerVisual {
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  phase: number;
}

interface DragState {
  pointerId: number;
  previousX: number;
  previousY: number;
}

type LocatedNode = SubnetNode & { latitude: number; longitude: number };

export function supportsWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

export class SubnetGlobe {
  private readonly host: HTMLElement;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(36, 1, 0.1, 80);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly world = new THREE.Group();
  private readonly markerLayer = new THREE.Group();
  private readonly markerVisuals: MarkerVisual[] = [];
  private readonly resizeObserver: ResizeObserver;
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  private readonly surfaceTexture: THREE.CanvasTexture;
  private readonly cloudTexture: THREE.CanvasTexture;
  private readonly flareTextures: THREE.CanvasTexture[];
  private readonly clouds: THREE.Mesh<THREE.SphereGeometry, THREE.MeshPhongMaterial>;
  private readonly sunLight: THREE.DirectionalLight;
  private readonly sunFlare: THREE.PointLight;
  private readonly lensflare: Lensflare;
  private animationFrame = 0;
  private lastFrameTime = performance.now();
  private drag: DragState | null = null;
  private interactionUntil = 0;

  constructor(options: GlobeOptions) {
    this.host = options.host;
    this.scene.background = new THREE.Color(0x030a12);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.04;
    this.renderer.domElement.className = "mysubnet-canvas";
    this.renderer.domElement.tabIndex = 0;
    this.renderer.domElement.setAttribute(
      "aria-label",
      "Rotating Earth globe showing this Internet Computer subnet. Drag or use arrow keys to rotate.",
    );
    this.host.appendChild(this.renderer.domElement);

    this.surfaceTexture = new THREE.CanvasTexture(createEarthTextureCanvas());
    this.surfaceTexture.colorSpace = THREE.SRGBColorSpace;
    this.surfaceTexture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());

    this.cloudTexture = new THREE.CanvasTexture(createCloudTextureCanvas());
    this.cloudTexture.colorSpace = THREE.SRGBColorSpace;
    this.cloudTexture.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());

    const earth = new THREE.Mesh(
      new THREE.SphereGeometry(EARTH_RADIUS, 80, 60),
      new THREE.MeshPhysicalMaterial({
        map: this.surfaceTexture,
        bumpMap: this.surfaceTexture,
        bumpScale: 0.014,
        color: 0xffffff,
        emissive: 0x001321,
        emissiveIntensity: 0.24,
        roughness: 0.73,
        metalness: 0,
        clearcoat: 0.12,
        clearcoatRoughness: 0.68,
      }),
    );
    this.world.add(earth);

    this.clouds = new THREE.Mesh(
      new THREE.SphereGeometry(EARTH_RADIUS + 0.018, 72, 54),
      new THREE.MeshPhongMaterial({
        map: this.cloudTexture,
        transparent: true,
        opacity: 0.6,
        depthWrite: false,
        shininess: 4,
        specular: 0xd9f4ff,
      }),
    );
    this.world.add(this.clouds);
    this.world.add(createAtmosphere());
    this.world.add(this.markerLayer);
    this.world.rotation.set(-0.08, -Math.PI / 2, 0);
    this.scene.add(this.world);

    this.scene.add(new THREE.AmbientLight(0x4b7894, 0.52));
    const nightFill = new THREE.DirectionalLight(0x256895, 0.58);
    nightFill.position.set(-4, -1.5, 2);
    this.scene.add(nightFill);

    this.sunLight = new THREE.DirectionalLight(0xf1f9ff, 2.75);
    this.sunLight.target.position.set(0, 0, 0);
    this.scene.add(this.sunLight, this.sunLight.target);

    this.flareTextures = [
      createFlareTexture(256, "rgba(255,255,255,1)", "rgba(137,207,255,0.36)"),
      createFlareTexture(192, "rgba(188,240,255,0.78)", "rgba(74,154,255,0.18)"),
      createFlareTexture(128, "rgba(174,225,255,0.55)", "rgba(61,132,238,0.08)"),
    ];
    this.lensflare = new Lensflare();
    this.lensflare.addElement(new LensflareElement(this.flareTextures[0]!, 390, 0, new THREE.Color(0xf3fbff)));
    this.lensflare.addElement(new LensflareElement(this.flareTextures[1]!, 118, 0.24, new THREE.Color(0xa8e6ff)));
    this.lensflare.addElement(new LensflareElement(this.flareTextures[2]!, 62, 0.45, new THREE.Color(0x70aaff)));
    this.lensflare.addElement(new LensflareElement(this.flareTextures[1]!, 88, 0.68, new THREE.Color(0x8ddcff)));
    this.lensflare.addElement(new LensflareElement(this.flareTextures[2]!, 42, 0.86, new THREE.Color(0xffd7a3)));
    this.sunFlare = new THREE.PointLight(0xdcefff, 0, 24, 2);
    this.sunFlare.add(this.lensflare);
    this.scene.add(this.sunFlare);

    this.scene.add(createStars());

    const canvas = this.renderer.domElement;
    canvas.style.cursor = "grab";
    canvas.addEventListener("pointerdown", this.handlePointerDown);
    canvas.addEventListener("pointermove", this.handlePointerMove);
    canvas.addEventListener("pointerup", this.handlePointerUp);
    canvas.addEventListener("pointercancel", this.handlePointerCancel);
    canvas.addEventListener("keydown", this.handleKeyDown);

    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(this.host);
    this.resize();
    this.animationFrame = requestAnimationFrame(this.animate);
  }

  setNodes(nodes: SubnetNode[]): void {
    this.clearMarkers();

    const clusters = new Map<string, LocatedNode[]>();
    for (const node of nodes.filter(hasCoordinates)) {
      const key = node.dataCenterId ?? `${node.latitude},${node.longitude}`;
      const cluster = clusters.get(key) ?? [];
      cluster.push(node);
      clusters.set(key, cluster);
    }

    for (const cluster of clusters.values()) {
      cluster.forEach((node, index) => {
        const coordinates = spreadCoordinates(node, index, cluster.length);
        this.addMarker(node, coordinates.latitude, coordinates.longitude);
      });
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.animationFrame);
    this.resizeObserver.disconnect();

    const canvas = this.renderer.domElement;
    canvas.removeEventListener("pointerdown", this.handlePointerDown);
    canvas.removeEventListener("pointermove", this.handlePointerMove);
    canvas.removeEventListener("pointerup", this.handlePointerUp);
    canvas.removeEventListener("pointercancel", this.handlePointerCancel);
    canvas.removeEventListener("keydown", this.handleKeyDown);

    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points) {
        geometries.add(object.geometry);
        const material = object.material;
        if (Array.isArray(material)) material.forEach((entry) => materials.add(entry));
        else materials.add(material);
      }
    });
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    this.lensflare.dispose();
    this.surfaceTexture.dispose();
    this.cloudTexture.dispose();
    this.flareTextures.forEach((texture) => texture.dispose());
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    canvas.remove();
  }

  private addMarker(node: SubnetNode, latitude: number, longitude: number): void {
    const normal = coordinateVector(latitude, longitude, 1).normalize();
    const surface = normal.clone().multiplyScalar(EARTH_RADIUS + 0.022);
    const position = normal.clone().multiplyScalar(MARKER_RADIUS);
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.032, 12, 10),
      new THREE.MeshStandardMaterial({
        color: 0xb7fff0,
        emissive: 0x45e4cb,
        emissiveIntensity: 2.25,
        roughness: 0.22,
      }),
    );
    core.position.copy(position);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.043, 0.057, 24),
      new THREE.MeshBasicMaterial({
        color: 0x70f0dd,
        transparent: true,
        opacity: 0.52,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    ring.position.copy(position.clone().addScaledVector(normal, 0.004));
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);

    const stem = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([surface, position]),
      new THREE.LineBasicMaterial({ color: 0x79e8d5, transparent: true, opacity: 0.68 }),
    );

    this.markerLayer.add(stem, ring, core);
    this.markerVisuals.push({ ring, phase: hashPhase(node.nodeId) });
  }

  private clearMarkers(): void {
    this.markerLayer.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
        object.geometry.dispose();
        if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
        else object.material.dispose();
      }
    });
    this.markerLayer.clear();
    this.markerVisuals.length = 0;
  }

  private readonly animate = (time: number): void => {
    const delta = Math.min(0.05, Math.max(0, (time - this.lastFrameTime) / 1000));
    this.lastFrameTime = time;

    if (!this.reducedMotion && !this.drag && time > this.interactionUntil) {
      this.world.rotation.y += delta * 0.052;
    }
    if (!this.reducedMotion) {
      this.clouds.rotation.y += delta * 0.006;
      for (const visual of this.markerVisuals) {
        const pulse = 1 + 0.3 * (0.5 + 0.5 * Math.sin(time * 0.002 + visual.phase));
        visual.ring.scale.setScalar(pulse);
      }
    }

    this.renderer.render(this.scene, this.camera);
    this.animationFrame = requestAnimationFrame(this.animate);
  };

  private readonly resize = (): void => {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    const aspect = width / height;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.8));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = aspect;

    const verticalFov = THREE.MathUtils.degToRad(this.camera.fov);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * aspect);
    const limitingFov = Math.min(verticalFov, horizontalFov);
    const distance = FIT_RADIUS * FIT_PADDING / Math.sin(limitingFov / 2);
    this.camera.position.set(0, 0, distance);
    this.camera.updateProjectionMatrix();

    const sunDepth = distance - SUN_Z;
    const halfHeight = Math.tan(verticalFov / 2) * sunDepth;
    const halfWidth = halfHeight * aspect;
    const sunPosition = new THREE.Vector3(halfWidth * 0.82, halfHeight * 0.38, SUN_Z);
    this.sunLight.position.copy(sunPosition);
    this.sunFlare.position.copy(sunPosition);
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    this.renderer.domElement.setPointerCapture(event.pointerId);
    this.renderer.domElement.style.cursor = "grabbing";
    this.drag = {
      pointerId: event.pointerId,
      previousX: event.clientX,
      previousY: event.clientY,
    };
    this.pauseRotation();
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (this.drag?.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - this.drag.previousX;
    const deltaY = event.clientY - this.drag.previousY;
    this.drag.previousX = event.clientX;
    this.drag.previousY = event.clientY;
    this.world.rotation.y += deltaX * 0.006;
    this.world.rotation.x = THREE.MathUtils.clamp(
      this.world.rotation.x + deltaY * 0.005,
      -0.78,
      0.78,
    );
    this.pauseRotation();
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (this.drag?.pointerId !== event.pointerId) return;
    this.drag = null;
    this.renderer.domElement.style.cursor = "grab";
    if (this.renderer.domElement.hasPointerCapture(event.pointerId)) {
      this.renderer.domElement.releasePointerCapture(event.pointerId);
    }
    this.pauseRotation();
  };

  private readonly handlePointerCancel = (event: PointerEvent): void => {
    if (this.drag?.pointerId !== event.pointerId) return;
    this.drag = null;
    this.renderer.domElement.style.cursor = "grab";
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    let handled = true;
    switch (event.key) {
      case "ArrowLeft":
        this.world.rotation.y -= 0.12;
        break;
      case "ArrowRight":
        this.world.rotation.y += 0.12;
        break;
      case "ArrowUp":
        this.world.rotation.x = Math.max(-0.78, this.world.rotation.x - 0.1);
        break;
      case "ArrowDown":
        this.world.rotation.x = Math.min(0.78, this.world.rotation.x + 0.1);
        break;
      default:
        handled = false;
    }

    if (handled) {
      event.preventDefault();
      this.pauseRotation();
    }
  };

  private pauseRotation(): void {
    this.interactionUntil = performance.now() + 4200;
  }
}

function createAtmosphere(): THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial> {
  return new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_RADIUS + 0.058, 72, 54),
    new THREE.ShaderMaterial({
      vertexShader: `
        varying vec3 vWorldNormal;
        varying vec3 vViewDirection;
        void main() {
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vWorldNormal = normalize(mat3(modelMatrix) * normal);
          vViewDirection = normalize(cameraPosition - worldPosition.xyz);
          gl_Position = projectionMatrix * viewMatrix * worldPosition;
        }
      `,
      fragmentShader: `
        varying vec3 vWorldNormal;
        varying vec3 vViewDirection;
        void main() {
          float fresnel = pow(1.0 - max(dot(normalize(vWorldNormal), normalize(vViewDirection)), 0.0), 2.5);
          vec3 atmosphere = mix(vec3(0.08, 0.42, 0.92), vec3(0.32, 0.88, 1.0), fresnel);
          gl_FragColor = vec4(atmosphere, fresnel * 0.58);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.FrontSide,
    }),
  );
}

function createFlareTexture(size: number, center: string, edge: string): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Lens flare rendering is unavailable.");
  const centerPoint = size / 2;
  const radius = size / 2;
  const flare = context.createRadialGradient(centerPoint, centerPoint, 0, centerPoint, centerPoint, radius);
  flare.addColorStop(0, center);
  flare.addColorStop(0.1, center);
  flare.addColorStop(0.42, edge);
  flare.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = flare;
  context.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function hasCoordinates(node: SubnetNode): node is LocatedNode {
  return node.latitude !== null && node.longitude !== null;
}

function spreadCoordinates(
  node: LocatedNode,
  index: number,
  count: number,
): { latitude: number; longitude: number } {
  if (count <= 1) return { latitude: node.latitude, longitude: node.longitude };

  const angle = index / count * Math.PI * 2 + hashPhase(node.nodeId) * 0.15;
  const spread = Math.min(0.56, 0.25 + count * 0.03);
  const latitude = THREE.MathUtils.clamp(node.latitude + Math.cos(angle) * spread, -88, 88);
  const longitudeScale = Math.max(0.3, Math.cos(THREE.MathUtils.degToRad(node.latitude)));
  const longitude = normalizeLongitude(node.longitude + Math.sin(angle) * spread / longitudeScale);
  return { latitude, longitude };
}

function coordinateVector(latitude: number, longitude: number, radius: number): THREE.Vector3 {
  const latitudeRadians = THREE.MathUtils.degToRad(latitude);
  const longitudeRadians = THREE.MathUtils.degToRad(longitude);
  const horizontal = Math.cos(latitudeRadians) * radius;

  return new THREE.Vector3(
    horizontal * Math.cos(longitudeRadians),
    Math.sin(latitudeRadians) * radius,
    -horizontal * Math.sin(longitudeRadians),
  );
}

function createStars(): THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> {
  const random = seededRandom(0x1c5b7a9);
  const positions = new Float32Array(680 * 3);

  for (let index = 0; index < 680; index += 1) {
    const radius = 10 + random() * 25;
    const z = random() * 2 - 1;
    const angle = random() * Math.PI * 2;
    const horizontal = Math.sqrt(1 - z * z);
    positions[index * 3] = horizontal * Math.cos(angle) * radius;
    positions[index * 3 + 1] = z * radius;
    positions[index * 3 + 2] = horizontal * Math.sin(angle) * radius;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      color: 0xb9d8eb,
      size: 0.026,
      transparent: true,
      opacity: 0.72,
      sizeAttenuation: true,
      depthWrite: false,
    }),
  );
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function hashPhase(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffff_ffff * Math.PI * 2;
}

function normalizeLongitude(value: number): number {
  return ((value + 180) % 360 + 360) % 360 - 180;
}
