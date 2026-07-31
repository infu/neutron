/**
 * Timed hardware attachments collected from the normal crate shuffle.
 *
 * Consumables (repair, shield, and an immediate missile salvo) and permanent
 * flight-system cores intentionally live outside this roster. Each attachment
 * owns one primary modifier family so the advertised twenty are mechanically
 * distinct rather than differently named copies of the same bonus.
 */
export const JET_ATTACHMENT_KINDS = Object.freeze([
  "rapid",
  "spread",
  "plasma",
  "beam",
  "drone",
  "overdrive",
  "stasis",
  "piercing",
  "ricochet",
  "chain-lightning",
  "explosive",
  "cryo",
  "targeting",
  "accelerator",
  "afterburner",
  "phase-hull",
  "magnet",
  "nanorepair",
  "missile-rack",
  "bomb-amplifier",
] as const);

export type JetAttachmentKind = typeof JET_ATTACHMENT_KINDS[number];

export const JET_ATTACHMENT_MODIFIER_FAMILIES = Object.freeze([
  "cannon-cadence",
  "cannon-volley",
  "cannon-payload",
  "beam-emitter",
  "drone-hardpoints",
  "system-overdrive",
  "hostile-time",
  "projectile-piercing",
  "projectile-ricochet",
  "chain-damage",
  "splash-damage",
  "target-slow",
  "aim-computer",
  "projectile-velocity",
  "flight-thrust",
  "collision-profile",
  "pickup-attractor",
  "kill-repair",
  "missile-payload",
  "bomb-payload",
] as const);

export type JetAttachmentModifierFamily = typeof JET_ATTACHMENT_MODIFIER_FAMILIES[number];

export interface JetAttachmentSpec {
  readonly kind: JetAttachmentKind;
  readonly label: string;
  readonly durationSeconds: number;
  readonly modifierFamily: JetAttachmentModifierFamily;
  /** Exact gameplay contract the renderer-backed runtime still has to honor. */
  readonly effect: string;
}

export const JET_ATTACHMENT_SPECS: Readonly<
  Record<JetAttachmentKind, Readonly<JetAttachmentSpec>>
> = Object.freeze({
  rapid: Object.freeze({
    kind: "rapid",
    label: "Rapid fire",
    durationSeconds: 8,
    modifierFamily: "cannon-cadence",
    effect: "Shorten cannon fire interval and accelerate cannon rounds.",
  }),
  spread: Object.freeze({
    kind: "spread",
    label: "Scatter shot",
    durationSeconds: 10,
    modifierFamily: "cannon-volley",
    effect: "Add two angled rounds to every cannon volley.",
  }),
  plasma: Object.freeze({
    kind: "plasma",
    label: "Plasma rounds",
    durationSeconds: 8,
    modifierFamily: "cannon-payload",
    effect: "Increase cannon-round damage and radius plus laser damage.",
  }),
  beam: Object.freeze({
    kind: "beam",
    label: "Laser beam",
    durationSeconds: 6,
    modifierFamily: "beam-emitter",
    effect: "Replace cannon volleys with a continuous forward damage beam.",
  }),
  drone: Object.freeze({
    kind: "drone",
    label: "Wing drones",
    durationSeconds: 12,
    modifierFamily: "drone-hardpoints",
    effect: "Add two visible wing-drone firing hardpoints.",
  }),
  overdrive: Object.freeze({
    kind: "overdrive",
    label: "Overdrive",
    durationSeconds: 7,
    modifierFamily: "system-overdrive",
    effect: "Boost cruise speed, fire cadence, projectile speed, and weapon damage.",
  }),
  stasis: Object.freeze({
    kind: "stasis",
    label: "Time stasis",
    durationSeconds: 8,
    modifierFamily: "hostile-time",
    effect: "Slow hostile movement, firing, and projectiles without slowing the jet.",
  }),
  piercing: Object.freeze({
    kind: "piercing",
    label: "Piercing jacket",
    durationSeconds: 10,
    modifierFamily: "projectile-piercing",
    effect: "Let each cannon round continue through one additional target.",
  }),
  ricochet: Object.freeze({
    kind: "ricochet",
    label: "Ricochet matrix",
    durationSeconds: 9,
    modifierFamily: "projectile-ricochet",
    effect: "Redirect a spent cannon round once toward a second target.",
  }),
  "chain-lightning": Object.freeze({
    kind: "chain-lightning",
    label: "Arc coupler",
    durationSeconds: 8,
    modifierFamily: "chain-damage",
    effect: "Arc cannon-hit damage to nearby enemies in a bounded chain.",
  }),
  explosive: Object.freeze({
    kind: "explosive",
    label: "Blast warhead",
    durationSeconds: 8,
    modifierFamily: "splash-damage",
    effect: "Add a bounded area-damage blast to cannon impacts.",
  }),
  cryo: Object.freeze({
    kind: "cryo",
    label: "Cryo injector",
    durationSeconds: 10,
    modifierFamily: "target-slow",
    effect: "Cannon hits temporarily slow the struck enemy's movement and fire cadence.",
  }),
  targeting: Object.freeze({
    kind: "targeting",
    label: "Predictive optics",
    durationSeconds: 12,
    modifierFamily: "aim-computer",
    effect: "Increase cannon intercept lead and projectile steering toward valid targets.",
  }),
  accelerator: Object.freeze({
    kind: "accelerator",
    label: "Rail accelerator",
    durationSeconds: 10,
    modifierFamily: "projectile-velocity",
    effect: "Increase cannon projectile velocity without changing firing cadence.",
  }),
  afterburner: Object.freeze({
    kind: "afterburner",
    label: "Afterburner vanes",
    durationSeconds: 10,
    modifierFamily: "flight-thrust",
    effect: "Increase jet cruise speed, acceleration, and braking authority.",
  }),
  "phase-hull": Object.freeze({
    kind: "phase-hull",
    label: "Phase hull",
    durationSeconds: 7,
    modifierFamily: "collision-profile",
    effect: "Reduce the jet's physical collision radius while preserving its visible size.",
  }),
  magnet: Object.freeze({
    kind: "magnet",
    label: "Magnet scoop",
    durationSeconds: 12,
    modifierFamily: "pickup-attractor",
    effect: "Pull nearby crates toward the jet and enlarge collection reach.",
  }),
  nanorepair: Object.freeze({
    kind: "nanorepair",
    label: "Nanorepair loom",
    durationSeconds: 10,
    modifierFamily: "kill-repair",
    effect: "Convert a bounded number of enemy kills into hull-repair charge.",
  }),
  "missile-rack": Object.freeze({
    kind: "missile-rack",
    label: "Missile rack",
    durationSeconds: 10,
    modifierFamily: "missile-payload",
    effect: "Increase homing-salvo missile count and per-missile damage.",
  }),
  "bomb-amplifier": Object.freeze({
    kind: "bomb-amplifier",
    label: "Bomb amplifier",
    durationSeconds: 10,
    modifierFamily: "bomb-payload",
    effect: "Increase remote-bomb blast damage and radius.",
  }),
});

export function jetAttachmentSpec(kind: JetAttachmentKind): Readonly<JetAttachmentSpec> {
  return JET_ATTACHMENT_SPECS[kind];
}

export function isJetAttachmentKind(kind: string): kind is JetAttachmentKind {
  return (JET_ATTACHMENT_KINDS as readonly string[]).includes(kind);
}
