import * as THREE from "three";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { HULLSHIFT_PALETTE, HULLSHIFT_PIXEL_PALETTE } from "./palette.ts";

export const MAX_SHADER_PALETTE_COLORS = 16 as const;

const FULLSCREEN_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const PALETTE_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2 resolution;
  uniform float paletteSize;
  uniform vec3 palette[${MAX_SHADER_PALETTE_COLORS}];
  uniform float ditherStrength;
  uniform float gradeStrength;
  varying vec2 vUv;

  float orderedDither(vec2 pixel) {
    vec2 cell = mod(floor(pixel), 4.0);
    float index = cell.x + cell.y * 4.0;
    if (index < 0.5) return 0.0;
    if (index < 1.5) return 8.0;
    if (index < 2.5) return 2.0;
    if (index < 3.5) return 10.0;
    if (index < 4.5) return 12.0;
    if (index < 5.5) return 4.0;
    if (index < 6.5) return 14.0;
    if (index < 7.5) return 6.0;
    if (index < 8.5) return 3.0;
    if (index < 9.5) return 11.0;
    if (index < 10.5) return 1.0;
    if (index < 11.5) return 9.0;
    if (index < 12.5) return 15.0;
    if (index < 13.5) return 7.0;
    if (index < 14.5) return 13.0;
    return 5.0;
  }

  vec3 nearestPaletteColor(vec3 source) {
    vec3 selected = palette[0];
    float selectedDistance = dot(source - selected, source - selected);

    for (int index = 1; index < ${MAX_SHADER_PALETTE_COLORS}; index += 1) {
      if (float(index) >= paletteSize) break;
      vec3 candidate = palette[index];
      vec3 delta = source - candidate;
      float candidateDistance = dot(delta, delta);
      if (candidateDistance < selectedDistance) {
        selected = candidate;
        selectedDistance = candidateDistance;
      }
    }
    return selected;
  }

  void main() {
    vec2 safeResolution = max(resolution, vec2(1.0));
    vec2 pixel = floor(vUv * safeResolution);
    vec4 source = texture2D(tDiffuse, vUv);
    float dither = (orderedDither(pixel) / 15.0 - 0.5) * ditherStrength;
    vec3 quantized = nearestPaletteColor(clamp(source.rgb + vec3(dither), 0.0, 1.0));
    // Palette attraction is intentionally subtle: the full-resolution source
    // retains material shading, antialiased edges, and small model details.
    gl_FragColor = vec4(mix(source.rgb, quantized, gradeStrength), source.a);
  }
`;

export interface HullshiftColorGradePass extends ShaderPass {
  readonly material: THREE.ShaderMaterial;
}

/**
 * One bounded full-resolution palette grade. Its uniforms are visual-only and
 * deliberately contain no level or engine state.
 */
export function createHullshiftColorGradePass(): HullshiftColorGradePass {
  const palette = HULLSHIFT_PIXEL_PALETTE.map((color) => {
    // Three's working color space is linear-sRGB; OutputPass performs the final
    // display transform after quantization.
    const linear = new THREE.Color(color);
    return new THREE.Vector3(linear.r, linear.g, linear.b);
  });
  const pass = new ShaderPass({
    name: "Hullshift subtle color grade",
    uniforms: {
      tDiffuse: { value: null },
      resolution: { value: new THREE.Vector2(1, 1) },
      paletteSize: { value: palette.length },
      palette: { value: palette },
      ditherStrength: { value: 0.5 / 255 },
      gradeStrength: { value: 0.14 },
    },
    vertexShader: FULLSCREEN_VERTEX_SHADER,
    fragmentShader: PALETTE_FRAGMENT_SHADER,
  }) as HullshiftColorGradePass;
  pass.material.depthTest = false;
  pass.material.depthWrite = false;
  return pass;
}

export function setColorGradePassSize(
  pass: HullshiftColorGradePass,
  width: number,
  height: number,
  reducedMotion: boolean,
): void {
  const uniforms = pass.material.uniforms;
  (uniforms.resolution?.value as THREE.Vector2 | undefined)?.set(
    Math.max(1, Math.floor(width)),
    Math.max(1, Math.floor(height)),
  );
  if (uniforms.ditherStrength) {
    uniforms.ditherStrength.value = reducedMotion ? 0 : 0.5 / 255;
  }
}

const PULSE_VERTEX_SHADER = /* glsl */ `
  varying vec3 vColor;

  void main() {
    #ifdef USE_INSTANCING_COLOR
      vColor = instanceColor;
    #else
      vColor = vec3(1.0);
    #endif
    vec4 localPosition = vec4(position, 1.0);
    #ifdef USE_INSTANCING
      localPosition = instanceMatrix * localPosition;
    #endif
    gl_Position = projectionMatrix * modelViewMatrix * localPosition;
  }
`;

const PULSE_FRAGMENT_SHADER = /* glsl */ `
  uniform float presentationTime;
  uniform float motionAmount;
  uniform float baseOpacity;
  varying vec3 vColor;

  void main() {
    float pulse = 0.78 + 0.22 * sin(presentationTime * 5.0);
    // The compound RingGeometry owns the radial halo silhouette. Keeping the
    // shader shape-agnostic avoids turning every powered fixture into the same
    // square UV border.
    float alpha = baseOpacity * mix(1.0, pulse, motionAmount);
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(vColor, alpha);
  }
`;

export interface PulseMaterialOptions {
  readonly opacity?: number;
  readonly reducedMotion?: boolean;
}

/** Shared instanced-material used for powered fixtures and bounded feedback. */
export function createPulseMaterial(options: PulseMaterialOptions = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: "Hullshift circuit pulse",
    uniforms: {
      presentationTime: { value: 0 },
      motionAmount: { value: options.reducedMotion === true ? 0 : 1 },
      baseOpacity: { value: options.opacity ?? 0.9 },
    },
    vertexShader: PULSE_VERTEX_SHADER,
    fragmentShader: PULSE_FRAGMENT_SHADER,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });
}

export function setPulsePresentation(
  material: THREE.ShaderMaterial,
  elapsedSeconds: number,
  reducedMotion: boolean,
): void {
  const time = material.uniforms.presentationTime;
  const motion = material.uniforms.motionAmount;
  if (time) time.value = Math.max(0, elapsedSeconds);
  if (motion) motion.value = reducedMotion ? 0 : 1;
}

/** A quiet, deterministic background material for the empty board surround. */
export function createBoardBackdropMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: HULLSHIFT_PALETTE.void,
    depthTest: false,
    depthWrite: false,
  });
}
