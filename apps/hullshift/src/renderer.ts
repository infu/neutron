import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import type { Coord, EngineEvent, EngineSnapshot, LevelDefinition } from "./model.ts";
import { HULLSHIFT_PALETTE } from "./palette.ts";
import {
  HullshiftRenderLayers,
  type HullshiftLayerDiagnostics,
} from "./render_layers.ts";
import {
  createHullshiftColorGradePass,
  setColorGradePassSize,
  type HullshiftColorGradePass,
} from "./render_shaders.ts";

export const MAX_RENDER_PIXEL_RATIO = 2 as const;
export const MAX_RENDER_TARGET_DIMENSION = 2048 as const;
export const COLOR_GRADE_DOWNSAMPLE = 1 as const;
export const EVENT_ANIMATION_MILLISECONDS = 170 as const;
export const REDUCED_EVENT_ANIMATION_MILLISECONDS = 70 as const;
export const MAX_RENDER_EVENT_TRACE = 128 as const;
export const MIN_BOARD_CELL_CSS_PIXELS = 24 as const;
/**
 * The board renders only when state or presentation changes. Retaining the
 * completed default framebuffer keeps that settled frame available when an
 * embedded browser compositor later rebuilds its surface without another RAF.
 */
export const HULLSHIFT_WEBGL_CONTEXT_OPTIONS = Object.freeze({
  antialias: false,
  depth: false,
  stencil: false,
  alpha: false,
  powerPreference: "high-performance",
  preserveDrawingBuffer: true,
} satisfies THREE.WebGLRendererParameters);
/** Shallow diorama pitch measured away from strict top-down. */
export const HULLSHIFT_CAMERA_TILT_RADIANS = Math.PI * 28 / 180;

const CAMERA_PADDING_CELLS = 0.72;
// Covers the tallest droid/reactor feature (including the socket mount) with
// a little rim-light breathing room in a fitted view.
const CAMERA_MODEL_HEIGHT_CELLS = 1.15;
const CAMERA_TILT_COSINE = Math.cos(HULLSHIFT_CAMERA_TILT_RADIANS);
const CAMERA_TILT_SINE = Math.sin(HULLSHIFT_CAMERA_TILT_RADIANS);
const CAMERA_DISTANCE = 10;

export type HullshiftCameraView = "fit" | "follow";

export interface HullshiftCameraStatus {
  /** The concrete projection selected for the current viewport. */
  readonly view: HullshiftCameraView;
  /** Requested logical focus, retained even when edge clamping moves the camera. */
  readonly target: Readonly<Coord>;
  /** Actual fractional logical cell underneath the viewport center. */
  readonly center: Readonly<Coord>;
  readonly cellCssPixels: number;
  readonly frustumWidth: number;
  readonly frustumHeight: number;
  readonly boardFullyVisible: boolean;
  readonly canPan: boolean;
}

export interface HullshiftCameraLayoutInput {
  readonly boardWidth: number;
  readonly boardHeight: number;
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly target: Readonly<Coord>;
}

export interface HullshiftViewportBounds {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface HullshiftClientPointInput {
  readonly boardWidth: number;
  readonly boardHeight: number;
  readonly layout: Pick<
    HullshiftCameraStatus,
    "center" | "frustumWidth" | "frustumHeight"
  >;
  readonly bounds: HullshiftViewportBounds;
  readonly clientX: number;
  readonly clientY: number;
}

/**
 * Pure automatic camera policy. It fits the whole board only while one world
 * cell remains at least 24 CSS pixels, otherwise it follows the player at the
 * legible scale.
 */
export function calculateHullshiftCameraLayout(
  input: HullshiftCameraLayoutInput,
): HullshiftCameraStatus {
  const boardWidth = positiveInteger(input.boardWidth, "board width");
  const boardHeight = positiveInteger(input.boardHeight, "board height");
  const cssWidth = positiveFinite(input.cssWidth);
  const cssHeight = positiveFinite(input.cssHeight);
  const aspect = cssWidth / cssHeight;
  const paddedWidth = boardWidth + CAMERA_PADDING_CELLS * 2;
  const paddedBoardHeight = boardHeight + CAMERA_PADDING_CELLS * 2;
  const projectedHeight = paddedBoardHeight * CAMERA_TILT_COSINE
    + CAMERA_MODEL_HEIGHT_CELLS * CAMERA_TILT_SINE;
  const fitted = fittedFrustum(paddedWidth, projectedHeight, aspect);
  const fittedProjectionScale = Math.min(
    cssWidth / fitted.width,
    cssHeight / fitted.height,
  );
  // Vertical board-plane movement is foreshortened by the tilt, so this is
  // the smaller of the two projected cell axes.
  const fittedCellPixels = fittedProjectionScale * CAMERA_TILT_COSINE;
  const target = frozenCoord(
    clampFinite(input.target.x, 0, boardWidth - 1),
    clampFinite(input.target.y, 0, boardHeight - 1),
  );
  const fullBoardProjection = fittedCellPixels >= MIN_BOARD_CELL_CSS_PIXELS;

  if (fullBoardProjection) {
    const center = frozenCoord((boardWidth - 1) / 2, (boardHeight - 1) / 2);
    return Object.freeze({
      view: "fit",
      target,
      center,
      cellCssPixels: fittedCellPixels,
      frustumWidth: fitted.width,
      frustumHeight: fitted.height,
      boardFullyVisible: true,
      canPan: false,
    });
  }

  const cellCssPixels = MIN_BOARD_CELL_CSS_PIXELS;
  const projectionScale = cellCssPixels / CAMERA_TILT_COSINE;
  const frustumWidth = cssWidth / projectionScale;
  const frustumHeight = cssHeight / projectionScale;
  const targetWorldX = target.x - (boardWidth - 1) / 2;
  const targetWorldY = (boardHeight - 1) / 2 - target.y;
  const centerWorldX = clampCameraAxis(
    targetWorldX,
    -paddedWidth / 2,
    paddedWidth / 2,
    frustumWidth,
  );
  const centerProjectedY = clampCameraAxis(
    targetWorldY * CAMERA_TILT_COSINE,
    -projectedHeight / 2,
    projectedHeight / 2,
    frustumHeight,
  );
  const centerWorldY = centerProjectedY / CAMERA_TILT_COSINE;
  const center = frozenCoord(
    centerWorldX + (boardWidth - 1) / 2,
    (boardHeight - 1) / 2 - centerWorldY,
  );
  const boardFullyVisible = frustumWidth >= paddedWidth - Number.EPSILON
    && frustumHeight >= projectedHeight - Number.EPSILON;

  return Object.freeze({
    view: "follow",
    target,
    center,
    cellCssPixels,
    frustumWidth,
    frustumHeight,
    boardFullyVisible,
    canPan: !boardFullyVisible,
  });
}

/** Pure client-point hit test shared by the browser wrapper and unit tests. */
export function cellAtHullshiftClientPoint(
  input: HullshiftClientPointInput,
): Readonly<Coord> | null {
  const { bounds } = input;
  if (
    !Number.isInteger(input.boardWidth)
    || !Number.isInteger(input.boardHeight)
    || input.boardWidth < 1
    || input.boardHeight < 1
    || !Number.isFinite(input.clientX)
    || !Number.isFinite(input.clientY)
    || !Number.isFinite(bounds.left)
    || !Number.isFinite(bounds.top)
    || !Number.isFinite(bounds.width)
    || !Number.isFinite(bounds.height)
    || bounds.width <= 0
    || bounds.height <= 0
    || !Number.isFinite(input.layout.center.x)
    || !Number.isFinite(input.layout.center.y)
    || !Number.isFinite(input.layout.frustumWidth)
    || !Number.isFinite(input.layout.frustumHeight)
    || input.layout.frustumWidth <= 0
    || input.layout.frustumHeight <= 0
  ) return null;

  const normalizedX = (input.clientX - bounds.left) / bounds.width;
  const normalizedY = (input.clientY - bounds.top) / bounds.height;
  if (normalizedX < 0 || normalizedX >= 1 || normalizedY < 0 || normalizedY >= 1) {
    return null;
  }
  const centerWorldX = input.layout.center.x - (input.boardWidth - 1) / 2;
  const centerWorldY = (input.boardHeight - 1) / 2 - input.layout.center.y;
  const worldX = centerWorldX + (normalizedX - 0.5) * input.layout.frustumWidth;
  const worldY = centerWorldY
    + (0.5 - normalizedY) * input.layout.frustumHeight / CAMERA_TILT_COSINE;
  const x = Math.floor(worldX + input.boardWidth / 2);
  const y = Math.floor(input.boardHeight / 2 - worldY);
  if (x < 0 || x >= input.boardWidth || y < 0 || y >= input.boardHeight) return null;
  return frozenCoord(x, y);
}

/** Resolve the nearest rendered instance before falling back to the XY deck. */
export function cellAtHullshiftInstanceRay(
  raycaster: THREE.Raycaster,
  root: THREE.Object3D,
  boardWidth: number,
  boardHeight: number,
): Readonly<Coord> | null {
  for (const hit of raycaster.intersectObject(root, true)) {
    if (hit.instanceId === undefined) continue;
    const coords = hit.object.userData.hullshiftInstanceCoords;
    if (!Array.isArray(coords)) continue;
    const coord = coords[hit.instanceId] as CoordLikeForPicking | undefined;
    if (
      coord === undefined
      || !Number.isInteger(coord.x)
      || !Number.isInteger(coord.y)
      || coord.x < 0
      || coord.y < 0
      || coord.x >= boardWidth
      || coord.y >= boardHeight
    ) continue;
    return frozenCoord(coord.x, coord.y);
  }
  return null;
}

interface CoordLikeForPicking {
  readonly x: number;
  readonly y: number;
}

export type HullshiftRendererStatus =
  | { readonly kind: "ready"; readonly recovered: boolean }
  | { readonly kind: "context-lost" }
  | { readonly kind: "recovering" }
  | { readonly kind: "error"; readonly message: string; readonly retryable: true }
  | { readonly kind: "disposed" };

export interface HullshiftRendererOptions {
  readonly ariaLabel?: string;
  readonly reducedMotion?: boolean;
  readonly onStatus?: (status: HullshiftRendererStatus) => void;
  readonly onContextLost?: () => void;
  /** Fired after GPU rebuild; React should then fetch the latest resident revision. */
  readonly onContextRestored?: () => void;
  readonly onError?: (message: string) => void;
  readonly onPresentationChange?: (active: boolean) => void;
  readonly onCameraChange?: (status: HullshiftCameraStatus | null) => void;
}

export interface HullshiftBoardPresentationOptions {
  readonly animate?: boolean;
}

export interface HullshiftRendererDiagnostics {
  readonly status: HullshiftRendererStatus["kind"];
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly effectivePixelRatio: number;
  readonly targetWidth: number;
  readonly targetHeight: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly geometries: number;
  readonly textures: number;
  readonly board: HullshiftLayerDiagnostics | null;
  readonly camera: HullshiftCameraStatus | null;
}

export interface BoundedRenderDimensions {
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly effectivePixelRatio: number;
  readonly drawingWidth: number;
  readonly drawingHeight: number;
  readonly targetWidth: number;
  readonly targetHeight: number;
}

export function boundedRenderDimensions(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
): BoundedRenderDimensions {
  const width = Math.max(1, Math.floor(Number.isFinite(cssWidth) ? cssWidth : 1));
  const height = Math.max(1, Math.floor(Number.isFinite(cssHeight) ? cssHeight : 1));
  const requestedRatio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? devicePixelRatio
    : 1;
  const effectivePixelRatio = Math.min(
    MAX_RENDER_PIXEL_RATIO,
    requestedRatio,
    MAX_RENDER_TARGET_DIMENSION / width,
    MAX_RENDER_TARGET_DIMENSION / height,
  );
  const drawingWidth = Math.max(1, Math.min(
    MAX_RENDER_TARGET_DIMENSION,
    Math.floor(width * effectivePixelRatio),
  ));
  const drawingHeight = Math.max(1, Math.min(
    MAX_RENDER_TARGET_DIMENSION,
    Math.floor(height * effectivePixelRatio),
  ));
  return Object.freeze({
    cssWidth: width,
    cssHeight: height,
    effectivePixelRatio,
    drawingWidth,
    drawingHeight,
    targetWidth: Math.max(1, Math.ceil(drawingWidth / COLOR_GRADE_DOWNSAMPLE)),
    targetHeight: Math.max(1, Math.ceil(drawingHeight / COLOR_GRADE_DOWNSAMPLE)),
  });
}

/** Browser capability probe only; it is never part of game-state decisions. */
export function supportsWebGL(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    return canvas.getContext("webgl2") !== null;
  } catch {
    return false;
  }
}

export const supportsHullshiftWebGL = supportsWebGL;

/**
 * Tilted orthographic, render-on-demand GPU presentation for one Hullshift tile.
 *
 * The class owns browser/Three.js lifetime only. Level definitions and engine
 * snapshots are read-only inputs and are never modified or fed back into the
 * simulation.
 */
export class HullshiftRenderer {
  private readonly host: HTMLElement;
  private readonly ariaLabel: string;
  private readonly onStatus: ((status: HullshiftRendererStatus) => void) | undefined;
  private readonly onContextLost: (() => void) | undefined;
  private readonly onContextRestored: (() => void) | undefined;
  private readonly onError: ((message: string) => void) | undefined;
  private readonly onPresentationChange: ((active: boolean) => void) | undefined;
  private readonly onCameraChange: (
    (status: HullshiftCameraStatus | null) => void
  ) | undefined;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 100);
  private readonly resizeObserver: ResizeObserver | null;
  private readonly motionQuery: MediaQueryList | null;
  private reducedMotionOverride: boolean | null;

  private renderer: THREE.WebGLRenderer | null = null;
  private composer: EffectComposer | null = null;
  private renderPass: RenderPass | null = null;
  private colorGradePass: HullshiftColorGradePass | null = null;
  private outputPass: OutputPass | null = null;
  private layers: HullshiftRenderLayers | null = null;
  private level: LevelDefinition | null = null;
  private snapshot: EngineSnapshot | null = null;
  private eventTrace: readonly EngineEvent[] = [];
  private followTarget: Readonly<Coord> = Object.freeze({ x: 0, y: 0 });
  private cameraLayout: HullshiftCameraStatus | null = null;
  private frameRequest: number | null = null;
  private animationStartedAt = 0;
  private animationDuration = 0;
  private presentationActive = false;
  private compileRevision = 0;
  private cssWidth = 1;
  private cssHeight = 1;
  private effectivePixelRatio = 1;
  private targetWidth = 1;
  private targetHeight = 1;
  private status: HullshiftRendererStatus = { kind: "recovering" };
  private contextLost = false;
  private disposed = false;

  constructor(host: HTMLElement, options: HullshiftRendererOptions = {}) {
    this.host = host;
    this.ariaLabel = options.ariaLabel ?? "Hullshift spacecraft puzzle board";
    this.onStatus = options.onStatus;
    this.onContextLost = options.onContextLost;
    this.onContextRestored = options.onContextRestored;
    this.onError = options.onError;
    this.onPresentationChange = options.onPresentationChange;
    this.onCameraChange = options.onCameraChange;
    this.reducedMotionOverride = options.reducedMotion ?? null;
    this.scene.background = new THREE.Color(HULLSHIFT_PALETTE.void);
    this.scene.add(createHullshiftEnvironmentLights());
    this.camera.position.set(
      0,
      -CAMERA_DISTANCE * CAMERA_TILT_SINE,
      CAMERA_DISTANCE * CAMERA_TILT_COSINE,
    );
    this.camera.lookAt(0, 0, 0);
    this.camera.up.set(0, 1, 0);

    this.motionQuery = options.reducedMotion === undefined && typeof window !== "undefined"
      ? window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null
      : null;
    this.motionQuery?.addEventListener("change", this.handleMotionPreference);

    this.resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(this.handleResize);
    this.resizeObserver?.observe(this.host);
    if (typeof window !== "undefined") window.addEventListener("resize", this.handleResize);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.handleVisibilityChange);
    }

    this.initializeGpu(false);
  }

  get canvas(): HTMLCanvasElement | null {
    return this.renderer?.domElement ?? null;
  }

  get currentStatus(): HullshiftRendererStatus {
    return this.status;
  }

  get isPresenting(): boolean {
    return this.presentationActive;
  }

  get cameraStatus(): HullshiftCameraStatus | null {
    return this.cameraLayout;
  }

  /** Resolve a browser client point to a top-left-origin board cell. */
  cellAtClientPoint(clientX: number, clientY: number): Readonly<Coord> | null {
    const level = this.level;
    const canvas = this.canvas;
    const layout = this.cameraLayout;
    if (level === null || canvas === null || layout === null) return null;
    const bounds = canvas.getBoundingClientRect();
    if (
      clientX >= bounds.left
      && clientX < bounds.right
      && clientY >= bounds.top
      && clientY < bounds.bottom
      && bounds.width > 0
      && bounds.height > 0
      && this.layers !== null
    ) {
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2(
        (clientX - bounds.left) / bounds.width * 2 - 1,
        1 - (clientY - bounds.top) / bounds.height * 2,
      ), this.camera);
      const renderedCell = cellAtHullshiftInstanceRay(
        raycaster,
        this.layers.group,
        level.width,
        level.height,
      );
      if (renderedCell !== null) return renderedCell;
    }
    return cellAtHullshiftClientPoint({
      boardWidth: level.width,
      boardHeight: level.height,
      layout,
      bounds: {
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
      },
      clientX,
      clientY,
    });
  }

  /** Replace the immutable level/snapshot pair and present an optional event trace. */
  setBoard(
    level: LevelDefinition,
    snapshot: EngineSnapshot,
    eventTrace: readonly EngineEvent[] = [],
    options: HullshiftBoardPresentationOptions = {},
  ): void {
    this.assertNotDisposed();
    const levelChanged = this.level !== level;
    const previousOutcome = this.snapshot === null ? null : outcomeKind(this.snapshot);
    this.level = level;
    this.snapshot = snapshot;
    this.eventTrace = Object.freeze(eventTrace.slice(-MAX_RENDER_EVENT_TRACE));
    if (levelChanged) {
      const boardCenter = frozenCoord((level.width - 1) / 2, (level.height - 1) / 2);
      this.followTarget = snapshot.state.player === null
        ? boardCenter
        : clampedBoardCoord(snapshot.state.player, level);
    } else if (snapshot.state.player !== null) {
      this.followTarget = clampedBoardCoord(snapshot.state.player, level);
    }

    if (this.renderer === null || this.composer === null || this.contextLost) return;
    if (levelChanged || this.layers === null) {
      this.rebuildLayers();
    } else {
      this.layers.update(snapshot, this.eventTrace);
    }
    this.applyCamera();

    const terminalChanged = previousOutcome !== null && previousOutcome !== outcomeKind(snapshot);
    if (options.animate !== false && (this.eventTrace.length > 0 || terminalChanged)) {
      this.startEventAnimation();
    } else {
      this.stopAnimation();
      this.setPresentationActive(false);
      this.layers?.clearPresentation();
      this.renderOnce();
    }
  }

  /** Update the current level without requiring its stable definition again. */
  setSnapshot(
    snapshot: EngineSnapshot,
    eventTrace: readonly EngineEvent[] = [],
    options: HullshiftBoardPresentationOptions = {},
  ): void {
    if (this.level === null) {
      throw new Error("Set a Hullshift level before updating its snapshot");
    }
    this.setBoard(this.level, snapshot, eventTrace, options);
  }

  setReducedMotion(reducedMotion: boolean): void {
    this.assertNotDisposed();
    this.reducedMotionOverride = reducedMotion;
    this.handleMotionPreference();
  }

  /** End eligible feedback immediately while retaining the already-settled board. */
  finishPresentation(): void {
    this.assertNotDisposed();
    this.stopAnimation();
    this.layers?.clearPresentation();
    this.setPresentationActive(false);
    this.renderOnce();
  }

  clearBoard(): void {
    this.assertNotDisposed();
    this.stopAnimation();
    this.setPresentationActive(false);
    this.level = null;
    this.snapshot = null;
    this.eventTrace = [];
    this.removeLayers();
    this.applyCamera();
    this.renderOnce();
  }

  /** Recreate a failed/lost renderer and rebuild solely from owned source data. */
  retry(): boolean {
    this.assertNotDisposed();
    this.stopAnimation();
    this.setPresentationActive(false);
    this.destroyGpu();
    return this.initializeGpu(false);
  }

  renderOnce(): void {
    if (
      this.disposed
      || this.contextLost
      || this.renderer === null
      || this.composer === null
      || (typeof document !== "undefined" && document.hidden)
    ) return;
    this.composer.render(0);
  }

  diagnostics(): HullshiftRendererDiagnostics {
    const info = this.renderer?.info;
    return Object.freeze({
      status: this.status.kind,
      cssWidth: this.cssWidth,
      cssHeight: this.cssHeight,
      effectivePixelRatio: this.effectivePixelRatio,
      targetWidth: this.targetWidth,
      targetHeight: this.targetHeight,
      drawCalls: info?.render.calls ?? 0,
      triangles: info?.render.triangles ?? 0,
      geometries: info?.memory.geometries ?? 0,
      textures: info?.memory.textures ?? 0,
      board: this.layers?.diagnostics() ?? null,
      camera: this.cameraLayout,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopAnimation();
    this.setPresentationActive(false);
    this.resizeObserver?.disconnect();
    this.motionQuery?.removeEventListener("change", this.handleMotionPreference);
    if (typeof window !== "undefined") window.removeEventListener("resize", this.handleResize);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    }
    this.destroyGpu();
    this.scene.clear();
    this.setStatus({ kind: "disposed" });
  }

  private initializeGpu(recovered: boolean): boolean {
    if (this.disposed) return false;
    this.contextLost = false;
    try {
      const renderer = new THREE.WebGLRenderer(HULLSHIFT_WEBGL_CONTEXT_OPTIONS);
      renderer.setClearColor(HULLSHIFT_PALETTE.void, 1);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.domElement.className = "hullshift-board-canvas";
      renderer.domElement.setAttribute("aria-label", this.ariaLabel);
      renderer.domElement.setAttribute("role", "img");
      renderer.domElement.style.display = "block";
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      renderer.domElement.addEventListener("webglcontextlost", this.handleContextLost, false);
      renderer.domElement.addEventListener("webglcontextrestored", this.handleContextRestored, false);
      this.renderer = renderer;
      this.host.append(renderer.domElement);
      this.createComposer();
      this.rebuildLayers();
      this.handleResize();
      this.setStatus({ kind: "ready", recovered });
      this.renderOnce();
      return true;
    } catch (error) {
      this.destroyGpu();
      this.setStatus({
        kind: "error",
        message: rendererErrorMessage(error),
        retryable: true,
      });
      return false;
    }
  }

  private createComposer(): void {
    const renderer = this.renderer;
    if (renderer === null) return;
    const target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      samples: 2,
    });
    target.texture.generateMipmaps = false;
    target.texture.name = "Hullshift bounded antialiased color target";
    const composer = new EffectComposer(renderer, target);
    // EffectComposer starts with RenderPass writing `readBuffer` (its cloned
    // renderTarget2), then the grading ShaderPass writes renderTarget1. Keep
    // depth + 2x MSAA only on that scene buffer; the fullscreen grade target
    // is color-only and single-sample. This avoids duplicating the expensive
    // attachments at the 2048px allocation ceiling.
    composer.renderTarget1.depthBuffer = false;
    composer.renderTarget1.samples = 0;
    composer.renderTarget1.texture.name = "Hullshift bounded grade target";
    composer.renderTarget2.texture.name = "Hullshift bounded 2x-MSAA scene target";
    composer.setPixelRatio(1);
    const renderPass = new RenderPass(this.scene, this.camera);
    renderPass.clear = true;
    const colorGradePass = createHullshiftColorGradePass();
    const outputPass = new OutputPass();
    composer.addPass(renderPass);
    composer.addPass(colorGradePass);
    composer.addPass(outputPass);
    this.composer = composer;
    this.renderPass = renderPass;
    this.colorGradePass = colorGradePass;
    this.outputPass = outputPass;
  }

  private rebuildLayers(): void {
    this.removeLayers();
    if (this.level === null || this.snapshot === null) return;
    const layers = new HullshiftRenderLayers(this.level, this.snapshot, {
      reducedMotion: this.prefersReducedMotion(),
    });
    layers.update(this.snapshot, this.eventTrace);
    if (!this.presentationActive) layers.clearPresentation();
    this.layers = layers;
    this.scene.add(layers.group);
    const renderer = this.renderer;
    const revision = ++this.compileRevision;
    if (renderer !== null) {
      // Chromium may complete new StandardMaterial programs through
      // KHR_parallel_shader_compile after the immediate stable-state draw.
      // Present one bounded follow-up frame when that exact board is ready so
      // the initial idle screen cannot retain a partially compiled layer.
      void renderer.compileAsync(this.scene, this.camera).then(() => {
        if (
          this.disposed
          || this.contextLost
          || this.renderer !== renderer
          || this.layers !== layers
          || this.compileRevision !== revision
        ) return;
        this.renderOnce();
      }).catch(() => {
        // The ordinary render/error/context-loss paths remain authoritative.
      });
    }
  }

  private removeLayers(): void {
    this.compileRevision += 1;
    if (this.layers === null) return;
    this.scene.remove(this.layers.group);
    this.layers.dispose();
    this.layers = null;
  }

  private destroyGpu(): void {
    this.stopAnimation();
    this.removeLayers();
    this.renderPass?.dispose();
    this.colorGradePass?.dispose();
    this.outputPass?.dispose();
    this.composer?.dispose();
    this.renderPass = null;
    this.colorGradePass = null;
    this.outputPass = null;
    this.composer = null;
    if (this.renderer !== null) {
      const canvas = this.renderer.domElement;
      canvas.removeEventListener("webglcontextlost", this.handleContextLost);
      canvas.removeEventListener("webglcontextrestored", this.handleContextRestored);
      this.renderer.dispose();
      canvas.remove();
      this.renderer = null;
    }
  }

  private applyCamera(): void {
    const level = this.level;
    if (level === null) {
      if (this.cameraLayout !== null) {
        this.cameraLayout = null;
        callSafely(this.onCameraChange, null);
      }
      this.camera.position.set(
        0,
        -CAMERA_DISTANCE * CAMERA_TILT_SINE,
        CAMERA_DISTANCE * CAMERA_TILT_COSINE,
      );
      this.camera.left = -5;
      this.camera.right = 5;
      this.camera.top = 5;
      this.camera.bottom = -5;
      this.camera.updateProjectionMatrix();
      return;
    }

    const layout = calculateHullshiftCameraLayout({
      boardWidth: level.width,
      boardHeight: level.height,
      cssWidth: this.cssWidth,
      cssHeight: this.cssHeight,
      target: this.followTarget,
    });
    const centerWorldX = layout.center.x - (level.width - 1) / 2;
    const centerWorldY = (level.height - 1) / 2 - layout.center.y;
    this.camera.position.set(
      centerWorldX,
      centerWorldY - CAMERA_DISTANCE * CAMERA_TILT_SINE,
      CAMERA_DISTANCE * CAMERA_TILT_COSINE,
    );
    this.camera.lookAt(centerWorldX, centerWorldY, 0);
    this.camera.left = -layout.frustumWidth / 2;
    this.camera.right = layout.frustumWidth / 2;
    this.camera.top = layout.frustumHeight / 2;
    this.camera.bottom = -layout.frustumHeight / 2;
    this.camera.updateProjectionMatrix();

    const changed = !sameCameraStatus(this.cameraLayout, layout);
    this.cameraLayout = layout;
    const canvas = this.canvas;
    if (canvas !== null) {
      canvas.dataset.cameraView = layout.view;
    }
    if (changed) callSafely(this.onCameraChange, layout);
  }

  private startEventAnimation(): void {
    this.stopAnimation();
    this.setPresentationActive(true);
    if (this.layers !== null && this.snapshot !== null) {
      this.layers.update(this.snapshot, this.eventTrace);
    }
    this.animationStartedAt = typeof performance === "undefined" ? 0 : performance.now();
    this.animationDuration = this.prefersReducedMotion()
      ? REDUCED_EVENT_ANIMATION_MILLISECONDS
      : EVENT_ANIMATION_MILLISECONDS;
    if (typeof document !== "undefined" && document.hidden) return;
    this.frameRequest = requestAnimationFrame(this.animate);
  }

  private stopAnimation(): void {
    if (this.frameRequest !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(this.frameRequest);
    }
    this.frameRequest = null;
  }

  private readonly animate = (timestamp: number): void => {
    this.frameRequest = null;
    if (this.disposed || this.contextLost || this.layers === null) return;
    const elapsed = Math.max(0, timestamp - this.animationStartedAt);
    const progress = this.animationDuration <= 0 ? 1 : Math.min(1, elapsed / this.animationDuration);
    this.layers.updatePresentation(
      elapsed / 1000,
      progress,
      this.prefersReducedMotion(),
    );
    this.renderOnce();
    if (progress < 1 && !(typeof document !== "undefined" && document.hidden)) {
      this.frameRequest = requestAnimationFrame(this.animate);
    } else {
      this.layers.clearPresentation();
      this.setPresentationActive(false);
      this.renderOnce();
    }
  };

  private readonly handleResize = (): void => {
    if (this.disposed || this.contextLost || this.renderer === null || this.composer === null) return;
    const bounds = this.host.getBoundingClientRect();
    const deviceRatio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    const dimensions = boundedRenderDimensions(bounds.width, bounds.height, deviceRatio);
    const width = dimensions.cssWidth;
    const height = dimensions.cssHeight;
    this.cssWidth = width;
    this.cssHeight = height;
    this.effectivePixelRatio = dimensions.effectivePixelRatio;
    this.renderer.setPixelRatio(this.effectivePixelRatio);
    this.renderer.setSize(width, height, false);
    this.targetWidth = dimensions.targetWidth;
    this.targetHeight = dimensions.targetHeight;
    this.composer.setSize(this.targetWidth, this.targetHeight);
    if (this.colorGradePass !== null) {
      setColorGradePassSize(
        this.colorGradePass,
        this.targetWidth,
        this.targetHeight,
        this.prefersReducedMotion(),
      );
    }
    this.applyCamera();
    this.renderOnce();
  };

  private readonly handleVisibilityChange = (): void => {
    if (this.disposed) return;
    if (document.hidden) {
      this.stopAnimation();
      this.layers?.clearPresentation();
      this.setPresentationActive(false);
      return;
    }
    this.layers?.clearPresentation();
    this.renderOnce();
  };

  private readonly handleMotionPreference = (): void => {
    if (this.disposed) return;
    this.stopAnimation();
    this.layers?.clearPresentation();
    this.setPresentationActive(false);
    if (this.colorGradePass !== null) {
      setColorGradePassSize(
        this.colorGradePass,
        this.targetWidth,
        this.targetHeight,
        this.prefersReducedMotion(),
      );
    }
    this.renderOnce();
  };

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    if (this.disposed || this.contextLost) return;
    this.contextLost = true;
    this.stopAnimation();
    this.setPresentationActive(false);
    this.setStatus({ kind: "context-lost" });
    callSafely(this.onContextLost);
  };

  private readonly handleContextRestored = (): void => {
    if (this.disposed) return;
    this.setStatus({ kind: "recovering" });
    this.contextLost = false;
    try {
      this.removeLayers();
      this.renderPass?.dispose();
      this.colorGradePass?.dispose();
      this.outputPass?.dispose();
      this.composer?.dispose();
      this.renderPass = null;
      this.colorGradePass = null;
      this.outputPass = null;
      this.composer = null;
      this.renderer?.resetState();
      this.createComposer();
      this.rebuildLayers();
      this.handleResize();
      this.setStatus({ kind: "ready", recovered: true });
      callSafely(this.onContextRestored);
    } catch (error) {
      this.setStatus({
        kind: "error",
        message: rendererErrorMessage(error),
        retryable: true,
      });
    }
  };

  private prefersReducedMotion(): boolean {
    return this.reducedMotionOverride ?? this.motionQuery?.matches ?? false;
  }

  private setStatus(status: HullshiftRendererStatus): void {
    this.status = status;
    callSafely(this.onStatus, status);
    if (status.kind === "error") callSafely(this.onError, status.message);
  }

  private setPresentationActive(active: boolean): void {
    if (this.presentationActive === active) return;
    this.presentationActive = active;
    callSafely(this.onPresentationChange, active);
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error("Hullshift renderer is disposed");
  }
}

function outcomeKind(snapshot: EngineSnapshot): string {
  return snapshot.outcome.kind;
}

function fittedFrustum(
  paddedWidth: number,
  paddedHeight: number,
  aspect: number,
): Readonly<{ width: number; height: number }> {
  if (aspect >= paddedWidth / paddedHeight) {
    return Object.freeze({ width: paddedHeight * aspect, height: paddedHeight });
  }
  return Object.freeze({ width: paddedWidth, height: paddedWidth / aspect });
}

function clampCameraAxis(
  target: number,
  minimum: number,
  maximum: number,
  visibleSpan: number,
): number {
  if (visibleSpan >= maximum - minimum) return (minimum + maximum) / 2;
  const halfSpan = visibleSpan / 2;
  return Math.min(maximum - halfSpan, Math.max(minimum + halfSpan, target));
}

function clampedBoardCoord(
  coord: Readonly<Coord>,
  level: Pick<LevelDefinition, "width" | "height">,
): Readonly<Coord> {
  return frozenCoord(
    clampFinite(coord.x, 0, level.width - 1),
    clampFinite(coord.y, 0, level.height - 1),
  );
}

function frozenCoord(x: number, y: number): Readonly<Coord> {
  return Object.freeze({ x, y });
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`Hullshift ${label} must be a positive integer`);
  }
  return value;
}

function positiveFinite(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function clampFinite(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError("Hullshift camera coordinates must be finite");
  }
  return Math.min(maximum, Math.max(minimum, value));
}

function sameCameraStatus(
  previous: HullshiftCameraStatus | null,
  next: HullshiftCameraStatus,
): boolean {
  return previous !== null
    && previous.view === next.view
    && previous.target.x === next.target.x
    && previous.target.y === next.target.y
    && previous.center.x === next.center.x
    && previous.center.y === next.center.y
    && previous.cellCssPixels === next.cellCssPixels
    && previous.frustumWidth === next.frustumWidth
    && previous.frustumHeight === next.frustumHeight
    && previous.boardFullyVisible === next.boardFullyVisible
    && previous.canPan === next.canPan;
}

function rendererErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return `GPU rendering unavailable: ${error.message.slice(0, 240)}`;
  }
  return "GPU rendering unavailable in this browser.";
}

function createHullshiftEnvironmentLights(): THREE.Group {
  const environment = new THREE.Group();
  environment.name = "Hullshift bounded diorama lighting";

  const hemisphere = new THREE.HemisphereLight(0xa8c9d7, 0x071015, 1.45);
  hemisphere.name = "Hullshift cool ambient fill";
  environment.add(hemisphere);

  const key = new THREE.DirectionalLight(0xd9efff, 2.35);
  key.name = "Hullshift upper-left key";
  key.position.set(-5, -7, 11);
  environment.add(key);

  const rim = new THREE.DirectionalLight(0x6d8fb8, 0.72);
  rim.name = "Hullshift far rim";
  rim.position.set(7, 5, 6);
  environment.add(rim);

  return environment;
}

function callSafely<Arguments extends readonly unknown[]>(
  callback: ((...args: Arguments) => void) | undefined,
  ...args: Arguments
): void {
  if (callback === undefined) return;
  try {
    callback(...args);
  } catch {
    // Host callbacks cannot be allowed to corrupt renderer/context recovery.
  }
}
