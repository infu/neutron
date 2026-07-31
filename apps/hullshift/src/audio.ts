import type { EngineEvent } from "./model.ts";

export type HullshiftEffectKind =
  | "blocked"
  | "move"
  | "push"
  | "relay"
  | "dock"
  | "power"
  | "fracture"
  | "failure"
  | "victory";

const EFFECT_PRIORITY: readonly HullshiftEffectKind[] = [
  "victory",
  "failure",
  "fracture",
  "dock",
  "relay",
  "power",
  "push",
  "blocked",
  "move",
];

const EVENT_EFFECT: Readonly<Partial<Record<EngineEvent["type"], HullshiftEffectKind>>> = {
  blocked: "blocked",
  "player-moved": "move",
  "object-pushed": "push",
  "relay-toggled": "relay",
  "socket-docked": "dock",
  "channel-changed": "power",
  "fracture-collapsed": "fracture",
  "physical-failure": "failure",
  "causal-failure": "failure",
  victory: "victory",
};

const EFFECT_TONE: Readonly<Record<HullshiftEffectKind, {
  frequency: number;
  endFrequency: number;
  duration: number;
  wave: OscillatorType;
}>> = {
  blocked: { frequency: 105, endFrequency: 82, duration: 0.055, wave: "square" },
  move: { frequency: 145, endFrequency: 128, duration: 0.035, wave: "triangle" },
  push: { frequency: 118, endFrequency: 91, duration: 0.09, wave: "square" },
  relay: { frequency: 330, endFrequency: 440, duration: 0.11, wave: "square" },
  dock: { frequency: 420, endFrequency: 650, duration: 0.18, wave: "triangle" },
  power: { frequency: 245, endFrequency: 315, duration: 0.12, wave: "sine" },
  fracture: { frequency: 155, endFrequency: 55, duration: 0.2, wave: "sawtooth" },
  failure: { frequency: 130, endFrequency: 48, duration: 0.26, wave: "sawtooth" },
  victory: { frequency: 420, endFrequency: 840, duration: 0.32, wave: "triangle" },
};

export function effectForEvents(events: readonly EngineEvent[]): HullshiftEffectKind | null {
  const present = new Set(events.map((event) => EVENT_EFFECT[event.type]).filter(Boolean));
  return EFFECT_PRIORITY.find((effect) => present.has(effect)) ?? null;
}

/** Small procedural effects palette. It never loads media or affects simulation. */
export class HullshiftAudio {
  #context: AudioContext | null = null;
  #muted = false;
  #paused = false;
  #hidden = typeof document !== "undefined" && document.hidden;
  #lastEffectAt = -Infinity;

  setMuted(muted: boolean): void {
    this.#muted = muted;
    if (muted) void this.#context?.suspend();
  }

  setPaused(paused: boolean): void {
    this.#paused = paused;
    if (paused) void this.#context?.suspend();
  }

  setHidden(hidden: boolean): void {
    this.#hidden = hidden;
    if (hidden) void this.#context?.suspend();
  }

  /** Call synchronously from a trusted key/button action to unlock browser audio. */
  unlock(): void {
    if (this.#muted || this.#hidden || this.#paused) return;
    const context = this.#ensureContext();
    if (context?.state === "suspended") void context.resume();
  }

  playEvents(events: readonly EngineEvent[]): void {
    const effect = effectForEvents(events);
    if (effect === null || this.#muted || this.#hidden || this.#paused) return;
    const context = this.#ensureContext();
    if (context === null || context.state !== "running") return;
    // At most three cues per second, even if input arrives faster through an
    // assistive switch or an unusually fast resident response.
    if (context.currentTime - this.#lastEffectAt < 1 / 3) return;
    this.#lastEffectAt = context.currentTime;
    const tone = EFFECT_TONE[effect];
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = tone.wave;
    oscillator.frequency.setValueAtTime(tone.frequency, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(tone.endFrequency, context.currentTime + tone.duration);
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.035, context.currentTime + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + tone.duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(context.currentTime);
    oscillator.stop(context.currentTime + tone.duration + 0.01);
  }

  dispose(): void {
    const context = this.#context;
    this.#context = null;
    if (context !== null) void context.close();
  }

  #ensureContext(): AudioContext | null {
    if (this.#context !== null) return this.#context;
    if (typeof window === "undefined") return null;
    const AudioContextConstructor = window.AudioContext;
    if (!AudioContextConstructor) return null;
    try {
      this.#context = new AudioContextConstructor({ latencyHint: "interactive" });
      return this.#context;
    } catch {
      return null;
    }
  }
}
