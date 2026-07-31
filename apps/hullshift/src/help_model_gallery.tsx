import {
  useEffect,
  useId,
  useRef,
  useState,
  type RefCallback,
} from "react";
import * as THREE from "three";
import {
  attachReactorModelToInstalledSocket,
  createHullshiftFixtureModel,
  createHullshiftFixturePreview,
  disposeHullshiftFixtureModel,
  type HullshiftFixtureModelDescriptor,
  type HullshiftFixtureModelKind,
  type HullshiftFixtureModelState,
  type HullshiftFixturePreviewMaterials,
} from "./models_fixtures_3d.ts";
import {
  createHullshiftOccupantModel,
  disposeHullshiftOccupantModel,
  type HullshiftOccupantModelDescriptor,
  type HullshiftOccupantModelKind,
} from "./models_occupants_3d.ts";
import {
  createHullshiftTerrainModel,
  disposeHullshiftTerrainModel,
  type HullshiftTerrainModelDescriptor,
  type HullshiftTerrainModelKind,
} from "./models_terrain_3d.ts";
import {
  HULLSHIFT_BOARD_REFERENCE_ORDER,
  MECHANIC_REFERENCE,
} from "./mechanic_reference.ts";
import { HULLSHIFT_PALETTE } from "./palette.ts";
import "./help_model_gallery.scss";

/**
 * Help uses one transparent WebGL canvas over a semantic card grid. Each art
 * well is a scissored viewport into the same renderer, scene, camera, lights,
 * and context; the canvas is never the source of a mechanic's accessible name
 * or rule.
 */

export const HULLSHIFT_HELP_GALLERY_MAX_PIXEL_RATIO = 1.5;
export const HULLSHIFT_HELP_GALLERY_MAX_DRAWING_DIMENSION = 2_048;
export const HULLSHIFT_HELP_GALLERY_MAX_DRAWING_PIXELS = 3_145_728;
/**
 * Help is also demand-rendered, so its last complete scissored frame must
 * survive an embedded compositor rebuild while the dialog remains idle.
 */
export const HULLSHIFT_HELP_WEBGL_CONTEXT_OPTIONS = Object.freeze({
  alpha: true,
  antialias: true,
  depth: true,
  stencil: false,
  powerPreference: "low-power",
  preserveDrawingBuffer: true,
} satisfies THREE.WebGLRendererParameters);

export type HullshiftHelpModelKey =
  (typeof HULLSHIFT_BOARD_REFERENCE_ORDER)[number];

export type HullshiftHelpModelEntry = Readonly<{
  key: HullshiftHelpModelKey;
  label: string;
  rule: string;
  stateSummary: string;
}>;

const STATE_SUMMARIES: Readonly<Record<HullshiftHelpModelKey, string>> =
  Object.freeze({
    cargo: "Movable object",
    reactor: "Loose power cell",
    plate: "Released → pressed",
    relay: "Off → latched on",
    socket: "Empty → reactor installed",
    door: "Closed → powered open",
    bridge: "Void → powered deck",
    vacuum: "Open hull breach",
    fracture: "Intact → vacuum after leaving",
    disposal: "Objects only · one way",
    gate: "Locked → evacuation ready",
  });

export const HULLSHIFT_HELP_MODEL_ENTRIES: readonly HullshiftHelpModelEntry[] =
  Object.freeze(HULLSHIFT_BOARD_REFERENCE_ORDER.map((key) => {
    const mechanic = MECHANIC_REFERENCE[key]!;
    return Object.freeze({
      key,
      label: mechanic.label,
      rule: mechanic.rule,
      stateSummary: STATE_SUMMARIES[key],
    });
  }));

export type HullshiftHelpGalleryResources = Readonly<{
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  previews: ReadonlyMap<HullshiftHelpModelKey, THREE.Group>;
  dispose(): void;
}>;

export type HullshiftHelpModelGalleryProps = Readonly<{
  className?: string;
  /** Overrides the system setting. Help previews remain static either way. */
  reducedMotion?: boolean;
}>;

/**
 * The only integration API required by Help. It owns its WebGL lifecycle and
 * still renders every label/rule when WebGL is missing or its context is lost.
 */
export function HullshiftHelpModelGallery({
  className,
  reducedMotion,
}: HullshiftHelpModelGalleryProps) {
  const headingId = useId();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const viewportRefs = useRef(new Map<HullshiftHelpModelKey, HTMLDivElement>());
  const systemReducedMotion = useSystemReducedMotion(reducedMotion === undefined);
  const motionReduced = reducedMotion ?? systemReducedMotion;
  const [gpuMessage, setGpuMessage] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const surface = surfaceRef.current;
    if (canvas === null || surface === null) return;

    let renderer: THREE.WebGLRenderer | null = null;
    let resources: HullshiftHelpGalleryResources | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let scheduledFrame = 0;
    let stopped = false;
    let contextLost = false;
    let disposed = false;

    const releaseGpu = (): void => {
      if (disposed) return;
      disposed = true;
      stopped = true;
      if (scheduledFrame !== 0) {
        cancelAnimationFrame(scheduledFrame);
        scheduledFrame = 0;
      }
      resizeObserver?.disconnect();
      resizeObserver = null;
      window.removeEventListener("resize", scheduleRender);
      resources?.dispose();
      resources = null;
      if (renderer !== null) {
        renderer.setScissorTest(false);
        renderer.setAnimationLoop(null);
        renderer.renderLists.dispose();
        renderer.dispose();
        renderer = null;
      }
    };

    const fail = (message: string): void => {
      if (stopped) return;
      setGpuMessage(message);
      releaseGpu();
    };

    const draw = (): void => {
      if (stopped || contextLost || renderer === null || resources === null) return;
      const bounds = surface.getBoundingClientRect();
      const cssWidth = Math.max(1, Math.ceil(bounds.width));
      const cssHeight = Math.max(1, Math.ceil(bounds.height));
      const pixelRatio = boundedHullshiftHelpGalleryPixelRatio(
        cssWidth,
        cssHeight,
        window.devicePixelRatio,
      );

      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(cssWidth, cssHeight, false);
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, cssWidth, cssHeight);
      renderer.setClearColor(HULLSHIFT_PALETTE.void, 0);
      renderer.clear(true, true, true);
      renderer.setScissorTest(true);

      let visiblePreview: THREE.Group | null = null;
      for (const entry of HULLSHIFT_HELP_MODEL_ENTRIES) {
        const viewport = viewportRefs.current.get(entry.key);
        const preview = resources.previews.get(entry.key);
        if (viewport === undefined || preview === undefined) continue;
        const viewportBounds = viewport.getBoundingClientRect();
        const left = clamp(viewportBounds.left - bounds.left, 0, cssWidth);
        const right = clamp(viewportBounds.right - bounds.left, 0, cssWidth);
        const top = clamp(viewportBounds.top - bounds.top, 0, cssHeight);
        const bottom = clamp(viewportBounds.bottom - bounds.top, 0, cssHeight);
        const width = Math.max(0, right - left);
        const height = Math.max(0, bottom - top);
        if (width < 1 || height < 1) continue;

        if (visiblePreview !== null) visiblePreview.visible = false;
        preview.visible = true;
        visiblePreview = preview;
        configurePreviewCamera(resources.camera, width / height);
        const viewportY = cssHeight - bottom;
        renderer.setViewport(left, viewportY, width, height);
        renderer.setScissor(left, viewportY, width, height);
        renderer.clear(false, true, false);
        renderer.render(resources.scene, resources.camera);
      }
      if (visiblePreview !== null) visiblePreview.visible = false;
      renderer.setScissorTest(false);
    };

    function scheduleRender(): void {
      if (stopped || contextLost || scheduledFrame !== 0) return;
      scheduledFrame = requestAnimationFrame(() => {
        scheduledFrame = 0;
        try {
          draw();
        } catch (error) {
          fail(formatPreviewError(error));
        }
      });
    }

    const handleContextCreationError = (event: Event): void => {
      const contextEvent = event as WebGLContextEvent;
      const detail = contextEvent.statusMessage?.trim();
      fail(detail
        ? `3D previews unavailable: ${detail}`
        : "3D previews unavailable in this browser.");
    };
    const handleContextLost = (event: Event): void => {
      event.preventDefault();
      if (stopped) return;
      contextLost = true;
      if (scheduledFrame !== 0) {
        cancelAnimationFrame(scheduledFrame);
        scheduledFrame = 0;
      }
      setGpuMessage(
        "3D previews paused because the GPU context was lost. The mechanic labels and rules remain available.",
      );
    };
    const handleContextRestored = (): void => {
      if (stopped) return;
      contextLost = false;
      setGpuMessage(null);
      scheduleRender();
    };

    canvas.addEventListener("webglcontextcreationerror", handleContextCreationError);
    canvas.addEventListener("webglcontextlost", handleContextLost);
    canvas.addEventListener("webglcontextrestored", handleContextRestored);

    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        ...HULLSHIFT_HELP_WEBGL_CONTEXT_OPTIONS,
      });
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.autoClear = false;
      resources = createHullshiftHelpGalleryResources();
      resizeObserver = typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleRender);
      resizeObserver?.observe(surface);
      for (const viewport of viewportRefs.current.values()) {
        resizeObserver?.observe(viewport);
      }
      window.addEventListener("resize", scheduleRender, { passive: true });
      setGpuMessage(null);
      scheduleRender();
    } catch (error) {
      fail(formatPreviewError(error));
    }

    return () => {
      canvas.removeEventListener("webglcontextcreationerror", handleContextCreationError);
      canvas.removeEventListener("webglcontextlost", handleContextLost);
      canvas.removeEventListener("webglcontextrestored", handleContextRestored);
      releaseGpu();
    };
  }, [motionReduced]);

  const viewportRef = (key: HullshiftHelpModelKey): RefCallback<HTMLDivElement> => (
    node,
  ) => {
    if (node === null) viewportRefs.current.delete(key);
    else viewportRefs.current.set(key, node);
  };

  return (
    <section
      aria-labelledby={headingId}
      className={joinClassNames("nt-section", "hullshift-help-model-gallery", className)}
      data-reduced-motion={motionReduced ? "true" : "false"}
    >
      <header className="nt-section-header">
        <h2 className="nt-section-heading" id={headingId}>Board machinery</h2>
        <span className="nt-section-count">{HULLSHIFT_HELP_MODEL_ENTRIES.length}</span>
      </header>
      <p className="nt-help hullshift-help-model-gallery__intro">
        These are the same code-native 3D models used on the board. State pairs
        show the physical change that follows a rule.
      </p>
      {gpuMessage === null ? null : (
        <div
          aria-live="polite"
          className="nt-alert nt-alert--warning hullshift-help-model-gallery__status"
          role="status"
        >
          <h3 className="nt-section-title">Preview status</h3>
          <p className="nt-text">{gpuMessage}</p>
        </div>
      )}
      <div className="hullshift-help-model-gallery__surface" ref={surfaceRef}>
        <canvas
          aria-hidden="true"
          className="hullshift-help-model-gallery__canvas"
          data-tid="hullshift-help-model-gallery-canvas"
          ref={canvasRef}
        />
        <div className="hullshift-help-model-gallery__grid">
          {HULLSHIFT_HELP_MODEL_ENTRIES.map((entry) => {
            const labelId = `${headingId}-${entry.key}`;
            return (
              <article
                aria-labelledby={labelId}
                className="nt-metric hullshift-help-model-card"
                data-help-model={entry.key}
                key={entry.key}
              >
                <div
                  aria-hidden="true"
                  className="hullshift-help-model-card__art"
                  ref={viewportRef(entry.key)}
                />
                <div className="hullshift-help-model-card__copy">
                  <h3 className="nt-metric-value" id={labelId}>{entry.label}</h3>
                  <span className="nt-tag hullshift-help-model-card__state">
                    {entry.stateSummary}
                  </span>
                  <p className="nt-metric-detail">{entry.rule}</p>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/**
 * Builds all model previews without creating a renderer. Keeping this pure
 * makes ownership and disposal independently testable without a browser GPU.
 */
export function createHullshiftHelpGalleryResources(): HullshiftHelpGalleryResources {
  const scene = new THREE.Scene();
  scene.name = "Hullshift shared Help model scene";
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 30);
  camera.name = "Hullshift Help shallow top-down camera";
  camera.position.set(1.8, -4.4, 7.4);
  camera.up.set(0, 0, 1);
  camera.lookAt(0, 0, 0.17);
  camera.updateProjectionMatrix();

  const lights = createPreviewLights();
  scene.add(lights);

  const previews = new Map<HullshiftHelpModelKey, THREE.Group>();
  const fixtureModels = new Map<
    HullshiftFixtureModelKind,
    HullshiftFixtureModelDescriptor
  >();
  const occupantModels = new Map<
    HullshiftOccupantModelKind,
    HullshiftOccupantModelDescriptor
  >();
  const terrainModels = new Map<HullshiftTerrainModelKind, HullshiftTerrainModelDescriptor>();
  const materials = new Set<THREE.Material>();
  const customGeometries = new Set<THREE.BufferGeometry>();
  let disposed = false;

  const trackMaterial = <T extends THREE.Material>(material: T): T => {
    materials.add(material);
    return material;
  };
  const terrainModel = (kind: HullshiftTerrainModelKind): HullshiftTerrainModelDescriptor => {
    const current = terrainModels.get(kind);
    if (current !== undefined) return current;
    const created = createHullshiftTerrainModel(kind);
    terrainModels.set(kind, created);
    return created;
  };
  const terrainMaterials = new Map<HullshiftTerrainModelKind, THREE.Material>();
  const terrainMaterial = (kind: HullshiftTerrainModelKind): THREE.Material => {
    const current = terrainMaterials.get(kind);
    if (current !== undefined) return current;
    const created = trackMaterial(new THREE.MeshStandardMaterial({
      color: terrainColor(kind),
      roughness: kind === "vacuum" ? 0.58 : 0.84,
      metalness: kind === "vacuum" ? 0.38 : 0.18,
      flatShading: true,
      depthTest: true,
      depthWrite: true,
    }));
    terrainMaterials.set(kind, created);
    return created;
  };
  const pitGeometry = new THREE.PlaneGeometry(0.78, 0.78);
  pitGeometry.name = "Hullshift Help recessed void backing";
  customGeometries.add(pitGeometry);
  const pitMaterial = trackMaterial(new THREE.MeshBasicMaterial({
    color: HULLSHIFT_PALETTE.void,
    depthTest: true,
    depthWrite: true,
  }));

  const support = (
    kind: "floor" | "vacuum" | "fracture",
    includePit: boolean,
  ): THREE.Group => {
    const group = new THREE.Group();
    group.name = `Hullshift Help ${kind} support`;
    if (includePit) {
      const pit = new THREE.Mesh(pitGeometry, pitMaterial);
      pit.name = "Hullshift Help visible hull void";
      pit.position.z = -0.24;
      group.add(pit);
    }
    const model = terrainModel(kind);
    const mesh = new THREE.Mesh(model.geometry, terrainMaterial(kind));
    mesh.name = model.geometry.name;
    mesh.receiveShadow = true;
    group.add(mesh);
    return group;
  };

  const occupantMaterials = (
    kind: HullshiftOccupantModelKind,
  ): HullshiftFixturePreviewMaterials => {
    const colors = occupantColors(kind);
    return createPreviewMaterials(colors, trackMaterial);
  };
  const occupant = (kind: HullshiftOccupantModelKind): THREE.Group => {
    let model = occupantModels.get(kind);
    if (model === undefined) {
      model = createHullshiftOccupantModel(kind);
      occupantModels.set(kind, model);
    }
    const roleMaterials = occupantMaterials(kind);
    const group = new THREE.Group();
    group.name = model.semantic;
    group.userData.hullshiftModelKind = kind;
    for (const part of model.parts) {
      const mesh = new THREE.Mesh(part.geometry, roleMaterials[part.role]);
      mesh.name = part.semantic;
      group.add(mesh);
    }
    return group;
  };
  const fixture = (
    kind: HullshiftFixtureModelKind,
    state: HullshiftFixtureModelState,
  ): Readonly<{ model: HullshiftFixtureModelDescriptor; group: THREE.Group }> => {
    let model = fixtureModels.get(kind);
    if (model === undefined) {
      model = createHullshiftFixtureModel(kind);
      fixtureModels.set(kind, model);
    }
    const group = createHullshiftFixturePreview(
      model,
      state,
      createPreviewMaterials(fixtureColors(kind, state), trackMaterial),
    );
    return { model, group };
  };
  const sample = (
    model: THREE.Object3D,
    supportKind: "floor" | "vacuum" | "fracture" = "floor",
  ): THREE.Group => {
    const group = new THREE.Group();
    group.add(support(supportKind, supportKind !== "floor"));
    group.add(model);
    return group;
  };
  const paired = (first: THREE.Object3D, second: THREE.Object3D): THREE.Group => {
    const group = new THREE.Group();
    first.position.x = -0.49;
    second.position.x = 0.49;
    first.scale.setScalar(0.72);
    second.scale.setScalar(0.72);
    group.add(first, second);
    return group;
  };
  const register = (key: HullshiftHelpModelKey, preview: THREE.Group): void => {
    preview.name = `Hullshift Help preview: ${key}`;
    preview.userData.hullshiftHelpModelKey = key;
    preview.visible = false;
    previews.set(key, preview);
    scene.add(preview);
  };

  register("cargo", sample(occupant("cargo")));
  register("reactor", sample(occupant("reactor-cell")));

  const plateReleased = fixture("plate", "released").group;
  const plateDepressed = fixture("plate", "depressed").group;
  register("plate", paired(sample(plateReleased), sample(plateDepressed)));

  const relayOff = fixture("relay", "off").group;
  const relayOn = fixture("relay", "on").group;
  register("relay", paired(sample(relayOff), sample(relayOn)));

  const emptySocket = fixture("socket", "empty").group;
  const installedSocket = fixture("socket", "installed");
  attachReactorModelToInstalledSocket(
    installedSocket.group,
    installedSocket.model,
    occupant("reactor-cell"),
  );
  register(
    "socket",
    paired(sample(emptySocket), sample(installedSocket.group)),
  );

  const doorClosed = fixture("door", "closed").group;
  const doorOpen = fixture("door", "open").group;
  register("door", paired(sample(doorClosed), sample(doorOpen)));

  const bridgeInactive = fixture("bridge", "inactive").group;
  const bridgeActive = fixture("bridge", "active").group;
  register(
    "bridge",
    paired(sample(bridgeInactive, "vacuum"), sample(bridgeActive, "vacuum")),
  );

  register("vacuum", sample(new THREE.Group(), "vacuum"));
  register(
    "fracture",
    paired(
      sample(new THREE.Group(), "fracture"),
      sample(new THREE.Group(), "vacuum"),
    ),
  );

  const disposal = fixture("disposal", "idle").group;
  register("disposal", sample(disposal));

  const gateLocked = fixture("gate", "locked").group;
  const gateReady = fixture("gate", "ready").group;
  register("gate", paired(sample(gateLocked), sample(gateReady)));

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const preview of previews.values()) scene.remove(preview);
    scene.remove(lights);
    for (const model of fixtureModels.values()) disposeHullshiftFixtureModel(model);
    for (const model of occupantModels.values()) disposeHullshiftOccupantModel(model);
    for (const model of terrainModels.values()) disposeHullshiftTerrainModel(model);
    for (const geometry of customGeometries) geometry.dispose();
    for (const material of materials) material.dispose();
    previews.clear();
    scene.clear();
  };

  return Object.freeze({ scene, camera, previews, dispose });
}

export function boundedHullshiftHelpGalleryPixelRatio(
  cssWidth: number,
  cssHeight: number,
  requestedPixelRatio: number,
): number {
  const width = finitePositive(cssWidth);
  const height = finitePositive(cssHeight);
  const requested = Number.isFinite(requestedPixelRatio) && requestedPixelRatio > 0
    ? requestedPixelRatio
    : 1;
  const pixelBudgetRatio = Math.sqrt(HULLSHIFT_HELP_GALLERY_MAX_DRAWING_PIXELS)
    / Math.sqrt(width)
    / Math.sqrt(height);
  const bounded = Math.min(
    requested,
    HULLSHIFT_HELP_GALLERY_MAX_PIXEL_RATIO,
    HULLSHIFT_HELP_GALLERY_MAX_DRAWING_DIMENSION / width,
    HULLSHIFT_HELP_GALLERY_MAX_DRAWING_DIMENSION / height,
    pixelBudgetRatio,
  );
  return bounded > 0 ? bounded : Number.MIN_VALUE;
}

type PreviewColors = Readonly<{
  base: number;
  detail: number;
  emissive: number;
}>;

function createPreviewMaterials(
  colors: PreviewColors,
  track: <T extends THREE.Material>(material: T) => T,
): HullshiftFixturePreviewMaterials {
  return {
    base: track(new THREE.MeshStandardMaterial({
      color: colors.base,
      roughness: 0.62,
      metalness: 0.38,
      flatShading: true,
      depthTest: true,
      depthWrite: true,
    })),
    detail: track(new THREE.MeshStandardMaterial({
      color: colors.detail,
      roughness: 0.48,
      metalness: 0.66,
      flatShading: true,
      depthTest: true,
      depthWrite: true,
    })),
    emissive: track(new THREE.MeshBasicMaterial({
      color: colors.emissive,
      toneMapped: false,
      depthTest: true,
      depthWrite: true,
    })),
  };
}

function occupantColors(kind: HullshiftOccupantModelKind): PreviewColors {
  switch (kind) {
    case "maintenance-droid":
      return {
        base: HULLSHIFT_PALETTE.goalIvory,
        detail: HULLSHIFT_PALETTE.hullDeep,
        emissive: HULLSHIFT_PALETTE.focusCyan,
      };
    case "cargo":
      return {
        base: HULLSHIFT_PALETTE.cargoBlue,
        detail: HULLSHIFT_PALETTE.steel,
        emissive: HULLSHIFT_PALETTE.focusCyan,
      };
    case "reactor-cell":
      return {
        base: HULLSHIFT_PALETTE.reactorGold,
        detail: HULLSHIFT_PALETTE.hullEdge,
        emissive: HULLSHIFT_PALETTE.goalIvory,
      };
  }
}

function fixtureColors(
  kind: HullshiftFixtureModelKind,
  state: HullshiftFixtureModelState,
): PreviewColors {
  const base = kind === "door" || kind === "disposal"
    ? HULLSHIFT_PALETTE.hullDeep
    : kind === "bridge"
      ? HULLSHIFT_PALETTE.hull
      : HULLSHIFT_PALETTE.hullRaised;
  const detail = kind === "relay"
    ? HULLSHIFT_PALETTE.relayViolet
    : kind === "socket"
      ? HULLSHIFT_PALETTE.reactorGold
      : kind === "disposal"
        ? HULLSHIFT_PALETTE.hazardOrange
        : kind === "gate" && state === "ready"
          ? HULLSHIFT_PALETTE.powerGreen
          : HULLSHIFT_PALETTE.steel;
  const energized = [
    "depressed", "on", "installed", "open", "active", "ready",
  ].includes(state);
  const emissive = state === "jammed"
    ? HULLSHIFT_PALETTE.warningAmber
    : kind === "disposal"
      ? HULLSHIFT_PALETTE.hazardOrange
      : !energized
        ? HULLSHIFT_PALETTE.inactive
        : kind === "socket"
          ? HULLSHIFT_PALETTE.reactorGold
          : kind === "gate"
            ? HULLSHIFT_PALETTE.powerGreen
            : HULLSHIFT_PALETTE.focusCyan;
  return { base, detail, emissive };
}

function terrainColor(kind: HullshiftTerrainModelKind): number {
  switch (kind) {
    case "floor": return HULLSHIFT_PALETTE.hull;
    case "bulkhead": return HULLSHIFT_PALETTE.hullRaised;
    case "vacuum": return HULLSHIFT_PALETTE.hazardOrange;
    case "fracture": return HULLSHIFT_PALETTE.warningAmber;
  }
}

function createPreviewLights(): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Hullshift shared Help preview lights";
  const hemisphere = new THREE.HemisphereLight(0xa8c9d7, 0x071015, 1.45);
  const key = new THREE.DirectionalLight(0xd9efff, 2.35);
  key.position.set(-5, -7, 11);
  const rim = new THREE.DirectionalLight(0x6d8fb8, 0.72);
  rim.position.set(7, 5, 6);
  lights.add(hemisphere, key, rim);
  return lights;
}

function configurePreviewCamera(
  camera: THREE.OrthographicCamera,
  aspect: number,
): void {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  // Includes the full loose reactor silhouette at the production camera tilt;
  // paired state models still retain a clear gap at the narrowest card width.
  const viewHeight = 1.82;
  camera.left = -viewHeight * safeAspect / 2;
  camera.right = viewHeight * safeAspect / 2;
  camera.top = viewHeight / 2;
  camera.bottom = -viewHeight / 2;
  camera.updateProjectionMatrix();
}

function useSystemReducedMotion(enabled: boolean): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (!enabled || typeof window === "undefined" || window.matchMedia === undefined) {
      setReduced(false);
      return;
    }
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = (): void => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [enabled]);
  return reduced;
}

function finitePositive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function joinClassNames(
  ...classes: Array<string | undefined | null | false>
): string {
  return classes.filter(Boolean).join(" ");
}

function formatPreviewError(error: unknown): string {
  const detail = error instanceof Error ? error.message.trim() : String(error).trim();
  return detail.length > 0
    ? `3D previews unavailable: ${detail.slice(0, 200)}`
    : "3D previews unavailable in this browser.";
}
