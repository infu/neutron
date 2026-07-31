import { createRoot } from "react-dom/client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  JET_ABILITY_KINDS,
  JET_ABILITY_SPECS,
  JET_FLIGHT_SYSTEM_KEYS,
  type JetFlightSystemKind,
} from "./abilities";
import {
  JetcreeperGame,
  supportsWebGL,
  type GameSnapshot,
  type JetMovementDirection,
} from "./game";
import {
  brainButtonHudReadout,
  cooldownCounterLabel,
  skillActionHudReadouts,
  visibleWeaponEffects,
  type SkillActionHudReadout,
} from "./hud";
import {
  RUN_DIFFICULTY_LEVELS,
  runDifficultyProfile,
  type RunDifficultyLevel,
} from "./run_difficulty";
import { runCompleteQuote } from "./run_quotes";
import "./style.scss";

const numberFormatter = new Intl.NumberFormat("en-US");

const initialSnapshot: GameSnapshot = {
  status: "ready",
  difficultyLevel: "hard",
  score: 0,
  bestScore: 0,
  lives: 3,
  sector: 1,
  shielded: false,
  rapidFireSeconds: 0,
  autoPilotEnabled: true,
  emergencyAssistActive: false,
  emergencyAssistSeconds: 0,
  brainActive: false,
  brainMode: "Cruising",
  dashActiveSeconds: 0,
  dashCooldownSeconds: 0,
  burstSeconds: 0,
  lowProfileSeconds: 0,
  lowProfileCooldownSeconds: 0,
  missileCooldownSeconds: 0,
  remoteBombActive: false,
  remoteBombArmedSeconds: 0,
  remoteBombCooldownSeconds: 0,
  guardianWingSeconds: 0,
  guardianWingCooldownSeconds: 0,
  jetAbilities: JET_ABILITY_KINDS.map((kind) => ({
    kind,
    label: JET_ABILITY_SPECS[kind].label,
    key: JET_ABILITY_SPECS[kind].key,
    unlocked: false,
    cooldownSeconds: 0,
    activeSeconds: 0,
  })),
  bossActive: false,
  bossName: "Ravager Ace",
  bossHealth: 0,
  bossMaxHealth: 1,
  bossPhase: 1,
  bossPattern: "aimed-fan",
  pilotLineActive: false,
  pilotLineStep: 0,
  pilotLineDirection: "center",
  pilotLineSeconds: 0,
  pilotSync: 0,
  pilotSyncTarget: 3,
  pilotStyleScore: 0,
  activeWeaponEffects: [],
  announcement: "Super Brain systems armed",
};

function primaryLabel(status: GameSnapshot["status"]): string {
  switch (status) {
    case "ready":
      return "Launch";
    case "paused":
      return "Resume";
    case "game-over":
      return "New Game";
    case "unsupported":
      return "Reload";
    case "running":
      return "Launch";
  }
}

function bossPatternLabel(pattern: GameSnapshot["bossPattern"]): string {
  return pattern.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function pilotDirectionLabel(direction: GameSnapshot["pilotLineDirection"]): string {
  switch (direction) {
    case "left":
      return "Nudge left";
    case "right":
      return "Nudge right";
    case "center":
      return "Meet center";
  }
}

function announcementTone(announcement: string): "danger" | "warning" | "reward" | "system" {
  const normalized = announcement.toLowerCase();

  if (normalized.includes("breach") || normalized.includes("jet down")) {
    return "danger";
  }

  if (normalized.includes("locked") || normalized.includes("recharging") || normalized.includes("held")) {
    return "warning";
  }

  if (
    normalized.includes("counterflare parry")
    || normalized.includes("gravity knot anchored")
    || normalized.includes("phoenix squadron inbound")
    || normalized.includes("online")
    || normalized.includes("repaired")
    || normalized.includes("destroyed")
    || normalized.includes("crate")
    || normalized.includes("burst")
  ) {
    return "reward";
  }

  if (normalized.includes("inbound") || normalized.includes("final phase")) {
    return "warning";
  }

  return "system";
}

function SkillGlyph({ kind }: { kind: JetFlightSystemKind }) {
  let artwork;

  switch (kind) {
    case "dash":
      artwork = (
        <>
          <path className="jetastn-skill-glyph-shadow" d="M5 35 20 20l5 5-13 14Zm10 3 14-14 5 5-12 13Z" />
          <path className="jetastn-skill-glyph-primary" d="m18 8 16 12-8 3-4 12-5-10-8-4 8-3Z" />
          <path className="jetastn-skill-glyph-accent" d="m18 8 4 17-5-7-8 3 8-9Z" />
        </>
      );
      break;
    case "low-profile":
      artwork = (
        <>
          <circle className="jetastn-skill-glyph-line" cx="24" cy="24" r="12" />
          <path className="jetastn-skill-glyph-line" d="M24 5v10m0 18v10M5 24h10m18 0h10" />
          <path className="jetastn-skill-glyph-primary" d="M5 21h38v6H5z" />
          <path className="jetastn-skill-glyph-accent" d="M10 23h28v2H10z" />
          <circle className="jetastn-skill-glyph-accent" cx="24" cy="24" r="4" />
        </>
      );
      break;
    case "missiles":
      artwork = (
        <>
          <path className="jetastn-skill-glyph-shadow" d="m7 38 8-3-5-5Zm12 3 8-3-5-5Zm10-15 8-3-5-5Z" />
          <path className="jetastn-skill-glyph-primary" d="M9 29 25 8l6-1-1 6-16 20Zm12 4 15-19 5-1-1 6-14 18Z" />
          <path className="jetastn-skill-glyph-accent" d="m22 12 4-4 5-1-1 6-4 4Zm14 2 5-1-1 6-3 4Z" />
        </>
      );
      break;
    case "counterflare":
      artwork = (
        <>
          <path className="jetastn-skill-glyph-line" d="M24 5v8m0 22v8M5 24h8m22 0h8M10 10l6 6m16 16 6 6m0-28-6 6M16 32l-6 6" />
          <path className="jetastn-skill-glyph-primary" d="m24 12 4 8 9 4-9 4-4 8-4-8-9-4 9-4Z" />
          <circle className="jetastn-skill-glyph-accent" cx="24" cy="24" r="4" />
        </>
      );
      break;
    case "gravity-knot":
      artwork = (
        <>
          <ellipse className="jetastn-skill-glyph-line" cx="24" cy="24" rx="18" ry="8" />
          <ellipse className="jetastn-skill-glyph-line" cx="24" cy="24" rx="8" ry="18" transform="rotate(38 24 24)" />
          <circle className="jetastn-skill-glyph-primary" cx="24" cy="24" r="8" />
          <circle className="jetastn-skill-glyph-accent" cx="27" cy="21" r="3" />
          <circle className="jetastn-skill-glyph-accent" cx="8" cy="24" r="2" />
        </>
      );
      break;
    case "phoenix-squadron":
      artwork = (
        <>
          <path className="jetastn-skill-glyph-shadow" d="M24 42 15 29 4 25l8-5-6-9 15 7 3-12 3 12 15-7-6 9 8 5-11 4Z" />
          <path className="jetastn-skill-glyph-primary" d="m24 39-7-13-11-2 10-5-6-7 13 7 1-12 2 12 13-7-6 7 9 5-11 2Z" />
          <path className="jetastn-skill-glyph-accent" d="m24 12 4 14-4 11-4-11Z" />
        </>
      );
      break;
    case "remote-bomb":
      artwork = (
        <>
          <circle className="jetastn-skill-glyph-line" cx="24" cy="25" r="13" />
          <path className="jetastn-skill-glyph-shadow" d="M17 35h14l-3 7h-8Zm2-26h10l3 8H16Z" />
          <circle className="jetastn-skill-glyph-primary" cx="24" cy="25" r="9" />
          <path className="jetastn-skill-glyph-accent" d="M22 6h4v10h-4Zm-4 3h12v4H18Z" />
          <circle className="jetastn-skill-glyph-accent" cx="27" cy="22" r="3" />
        </>
      );
      break;
    case "guardian-wing":
      artwork = (
        <>
          <path className="jetastn-skill-glyph-shadow" d="m24 40-6-12-13 5 5-14 9 3 5-16 5 16 9-3 5 14-13-5Z" />
          <path className="jetastn-skill-glyph-primary" d="m24 37-4-13-10 5 4-8 7 3 3-13 3 13 7-3 4 8-10-5Z" />
          <path className="jetastn-skill-glyph-accent" d="m24 15 3 12-3 8-3-8Zm-10 11 6 1-8 5Zm20 0-6 1 8 5Z" />
        </>
      );
      break;
  }

  return (
    <svg aria-hidden="true" className="jetastn-skill-glyph" viewBox="0 0 48 48">
      <rect className="jetastn-skill-glyph-backdrop" height="44" rx="9" width="44" x="2" y="2" />
      {artwork}
      <rect className="jetastn-skill-glyph-frame" height="42" rx="8" width="42" x="3" y="3" />
    </svg>
  );
}

interface SkillActionButtonProps {
  readonly readout: SkillActionHudReadout;
  readonly onActivate: (kind: JetFlightSystemKind) => void;
}

function SkillActionButton({ readout, onActivate }: SkillActionButtonProps) {
  const cooldownLabel = cooldownCounterLabel(readout.cooldownSeconds);
  const ringOffset = 100 * (1 - readout.cooldownProgress);

  return (
    <button
      aria-keyshortcuts={readout.key}
      aria-label={`${readout.label}: ${readout.status}`}
      className={`jetastn-skill-button jetastn-skill-button--${readout.kind} jetastn-skill-button--${readout.phase}`}
      data-cooldown-progress={readout.cooldownProgress.toFixed(3)}
      data-phase={readout.phase}
      data-system={readout.kind}
      onClick={() => onActivate(readout.kind)}
      onPointerDown={(event) => event.stopPropagation()}
      title={`${readout.label} · ${readout.status}`}
      type="button"
    >
      <SkillGlyph kind={readout.kind} />
      <span aria-hidden="true" className="jetastn-skill-cooldown-shade" />
      <svg aria-hidden="true" className="jetastn-skill-cooldown" viewBox="0 0 52 52">
        <circle className="jetastn-skill-cooldown-track" cx="26" cy="26" pathLength="100" r="22" />
        <circle
          className="jetastn-skill-cooldown-progress"
          cx="26"
          cy="26"
          pathLength="100"
          r="22"
          strokeDasharray="100"
          strokeDashoffset={ringOffset}
        />
      </svg>
      {cooldownLabel ? <span aria-hidden="true" className="jetastn-skill-cooldown-label">{cooldownLabel}</span> : null}
      {readout.phase === "locked" ? (
        <span aria-hidden="true" className="jetastn-skill-lock"><span /></span>
      ) : null}
      {readout.phase === "active" ? <span aria-hidden="true" className="jetastn-skill-active-mark" /> : null}
      <kbd aria-hidden="true" className="jetastn-skill-key">{readout.key}</kbd>
      <span className="nt-sr-only">{readout.label}: {readout.status}</span>
    </button>
  );
}

function BrainSkillGlyph() {
  return (
    <svg aria-hidden="true" className="jetastn-skill-glyph" viewBox="0 0 48 48">
      <rect className="jetastn-skill-glyph-backdrop" height="44" rx="9" width="44" x="2" y="2" />
      <path className="jetastn-skill-glyph-shadow" d="M22 7c-6 0-10 4-10 9-4 2-6 6-4 10-2 5 1 10 6 11 2 4 7 5 10 2 3 3 8 2 10-2 5-1 8-6 6-11 2-4 0-8-4-10 0-5-4-9-10-9Z" />
      <path className="jetastn-skill-glyph-primary" d="M22 10c-4 0-7 3-7 7-4 1-5 5-3 8-2 3 0 7 4 8 1 4 6 4 8 1V14c0-2-1-4-2-4Zm4 4v20c2 3 7 3 8-1 4-1 6-5 4-8 2-3 1-7-3-8 0-4-3-7-7-7-1 0-2 2-2 4Z" />
      <path className="jetastn-skill-glyph-line" d="M16 19c3-1 5 1 5 4m-7 5c3-1 5 0 6 3m12-12c-3-1-5 1-5 4m7 5c-3-1-5 0-6 3M24 14v20" />
      <circle className="jetastn-skill-glyph-accent" cx="18" cy="25" r="2" />
      <circle className="jetastn-skill-glyph-accent" cx="30" cy="25" r="2" />
      <rect className="jetastn-skill-glyph-frame" height="42" rx="8" width="42" x="3" y="3" />
    </svg>
  );
}

interface BrainActionButtonProps {
  readonly enabled: boolean;
  readonly emergencyActive: boolean;
  readonly emergencySeconds: number;
  readonly onActivate: () => void;
}

function BrainActionButton({
  enabled,
  emergencyActive,
  emergencySeconds,
  onActivate,
}: BrainActionButtonProps) {
  const readout = brainButtonHudReadout(enabled, emergencyActive, emergencySeconds);
  const mode = readout.mode;

  return (
    <button
      aria-keyshortcuts="Q"
      aria-label={`Super Brain: ${mode}. Toggle flight mode`}
      aria-pressed={readout.pressed}
      className={`jetastn-skill-button jetastn-skill-button--brain${readout.active ? " jetastn-skill-button--brain-online" : ""}${emergencyActive ? " jetastn-skill-button--brain-emergency" : ""}`}
      data-system="super-brain"
      onClick={onActivate}
      onPointerDown={(event) => event.stopPropagation()}
      title={`Super Brain · ${mode} · Q`}
      type="button"
    >
      <BrainSkillGlyph />
      {readout.active ? <span aria-hidden="true" className="jetastn-skill-active-mark" /> : null}
      {emergencyActive ? <span aria-hidden="true" className="jetastn-brain-emergency-mark">!</span> : null}
      <kbd aria-hidden="true" className="jetastn-skill-key">Q</kbd>
      <span className="nt-sr-only">Super Brain: {mode}</span>
    </button>
  );
}

interface MovementControlButtonProps {
  readonly direction: JetMovementDirection;
  readonly label: string;
  readonly onChange: (direction: JetMovementDirection, pressed: boolean) => void;
}

function MovementControlButton({
  direction,
  label,
  onChange,
}: MovementControlButtonProps) {
  const activePointersRef = useRef(new Set<number>());
  const [pressed, setPressed] = useState(false);

  const releasePointer = useCallback((pointerId: number) => {
    if (!activePointersRef.current.delete(pointerId)) {
      return;
    }

    if (activePointersRef.current.size === 0) {
      setPressed(false);
      onChange(direction, false);
    }
  }, [direction, onChange]);

  useEffect(() => () => {
    if (activePointersRef.current.size === 0) {
      return;
    }

    activePointersRef.current.clear();
    onChange(direction, false);
  }, [direction, onChange]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const wasReleased = activePointersRef.current.size === 0;
    activePointersRef.current.add(event.pointerId);
    event.currentTarget.setPointerCapture(event.pointerId);
    if (wasReleased) {
      setPressed(true);
      onChange(direction, true);
    }
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    releasePointer(event.pointerId);
  };

  return (
    <button
      aria-keyshortcuts={`Arrow${direction[0]!.toUpperCase()}${direction.slice(1)}`}
      aria-label={label}
      className={`jetastn-movement-button jetastn-movement-button--${direction}`}
      data-pressed={pressed ? "true" : undefined}
      onContextMenu={(event) => event.preventDefault()}
      onLostPointerCapture={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerEnd}
      type="button"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M12 3 3.5 12H8v9h8v-9h4.5Z" />
      </svg>
    </button>
  );
}

function MobileMovementControls({
  onChange,
}: {
  readonly onChange: (
    direction: JetMovementDirection,
    pressed: boolean,
  ) => void;
}) {
  return (
    <div aria-label="Touch flight controls" className="jetastn-movement-controls">
      <div aria-label="Vertical movement" className="jetastn-movement-group jetastn-movement-group--vertical" role="group">
        <MovementControlButton direction="up" label="Move up" onChange={onChange} />
        <MovementControlButton direction="down" label="Move down" onChange={onChange} />
      </div>
      <div aria-label="Horizontal movement" className="jetastn-movement-group jetastn-movement-group--horizontal" role="group">
        <MovementControlButton direction="left" label="Move left" onChange={onChange} />
        <MovementControlButton direction="right" label="Move right" onChange={onChange} />
      </div>
    </div>
  );
}

function JetcreeperApp() {
  const stageRef = useRef<HTMLDivElement>(null);
  const resumeButtonRef = useRef<HTMLButtonElement>(null);
  const gameRef = useRef<JetcreeperGame | null>(null);
  const focusStatusRef = useRef(initialSnapshot.status);
  const previousScoreRef = useRef(0);
  const previousVitalsRef = useRef({ lives: 3, shielded: false, status: initialSnapshot.status });
  const [snapshot, setSnapshot] = useState<GameSnapshot>(initialSnapshot);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [scoreGain, setScoreGain] = useState<{ amount: number; token: number } | null>(null);
  const [damagePulse, setDamagePulse] = useState(0);

  useEffect(() => {
    const stage = stageRef.current;

    if (!stage) {
      return;
    }

    if (!supportsWebGL()) {
      setRuntimeError("WebGL is unavailable in this browser.");
      setSnapshot((current) => ({ ...current, status: "unsupported" }));
      return;
    }

    try {
      const game = new JetcreeperGame({
        host: stage,
        onSnapshot: setSnapshot,
      });
      gameRef.current = game;
      stage.focus({ preventScroll: true });

      return () => {
        game.dispose();
        gameRef.current = null;
      };
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "The GPU renderer could not start.");
      setSnapshot((current) => ({ ...current, status: "unsupported" }));
    }
  }, []);

  useEffect(() => {
    const previousScore = previousScoreRef.current;
    previousScoreRef.current = snapshot.score;

    if (snapshot.status !== "running" || snapshot.score <= previousScore) {
      if (snapshot.score === 0) {
        setScoreGain(null);
      }
      return;
    }

    setScoreGain({ amount: snapshot.score - previousScore, token: snapshot.score });
    const timeout = window.setTimeout(() => setScoreGain(null), 720);
    return () => window.clearTimeout(timeout);
  }, [snapshot.score, snapshot.status]);

  useEffect(() => {
    const previous = previousVitalsRef.current;
    const tookHit = previous.status === "running"
      && (snapshot.status === "running" || snapshot.status === "game-over")
      && (snapshot.lives < previous.lives || (previous.shielded && !snapshot.shielded));
    previousVitalsRef.current = {
      lives: snapshot.lives,
      shielded: snapshot.shielded,
      status: snapshot.status,
    };

    if (!tookHit) {
      return;
    }

    setDamagePulse((value) => value + 1);
  }, [snapshot.lives, snapshot.shielded, snapshot.status]);

  useEffect(() => {
    const previousStatus = focusStatusRef.current;
    focusStatusRef.current = snapshot.status;

    if (snapshot.status === "paused") {
      const frame = window.requestAnimationFrame(() => {
        resumeButtonRef.current?.focus({ preventScroll: true });
      });
      return () => window.cancelAnimationFrame(frame);
    }

    if (previousStatus === "paused" && snapshot.status === "running") {
      const timeout = window.setTimeout(() => {
        stageRef.current?.focus({ preventScroll: true });
      }, 0);
      return () => window.clearTimeout(timeout);
    }
  }, [snapshot.status]);

  const focusSelectedDifficulty = useCallback(() => {
    window.setTimeout(() => {
      document.querySelector<HTMLInputElement>(".jetastn-difficulty-input:checked")
        ?.focus({ preventScroll: true });
    }, 0);
  }, []);

  const handlePrimaryAction = useCallback(() => {
    if (snapshot.status === "unsupported") {
      window.location.reload();
      return;
    }

    if (snapshot.status === "game-over") {
      gameRef.current?.returnToReady();
      focusSelectedDifficulty();
      return;
    }

    gameRef.current?.start();
  }, [focusSelectedDifficulty, snapshot.status]);

  const handlePause = useCallback(() => {
    gameRef.current?.togglePause();
  }, []);

  const handleDifficultyChange = useCallback((level: RunDifficultyLevel) => {
    gameRef.current?.setNextDifficulty(level);
  }, []);

  const handleNewGame = useCallback(() => {
    gameRef.current?.returnToReady();
    focusSelectedDifficulty();
  }, [focusSelectedDifficulty]);

  const handleSkillActivation = useCallback((kind: JetFlightSystemKind) => {
    gameRef.current?.requestFlightSystem(kind);
  }, []);

  const handleAutoPilotToggle = useCallback(() => {
    gameRef.current?.requestAutoPilotToggle();
  }, []);

  const handleMovementControl = useCallback((
    direction: JetMovementDirection,
    pressed: boolean,
  ) => {
    gameRef.current?.setMovementControl(direction, pressed);
  }, []);

  const weaponEffects = visibleWeaponEffects(snapshot);
  const skillReadouts = skillActionHudReadouts(snapshot);
  const crateKinds = new Set<string>(JET_ABILITY_KINDS);
  const coreSkillReadouts = skillReadouts.filter((readout) => !crateKinds.has(readout.kind));
  const crateSkillReadouts = skillReadouts.filter((readout) => crateKinds.has(readout.kind));
  const showOverlay = snapshot.status !== "running";
  const bossHealthPercent = Math.max(0, Math.min(100, snapshot.bossHealth / Math.max(1, snapshot.bossMaxHealth) * 100));

  return (
    <main className="nt-app nt-app--fill jetastn">
      <section aria-label="Jetfreeper combat field" className="jetastn-combat">
        <div
          className={`jetastn-stage${snapshot.bossActive ? " jetastn-stage--boss" : ""}`}
          data-difficulty={snapshot.difficultyLevel}
          ref={stageRef}
          tabIndex={snapshot.status === "paused" || snapshot.status === "game-over" ? -1 : 0}
        >
          {snapshot.status === "running" ? (
            <header className="jetastn-statusbar">
              <div className="jetastn-hud" aria-label="Flight status">
                <div className="jetastn-vitals">
                  <div className="jetastn-score" aria-label={`Score ${numberFormatter.format(snapshot.score)}`}>
                    <span aria-hidden="true" className="jetastn-score-label">Score</span>
                    <strong aria-hidden="true">{numberFormatter.format(snapshot.score)}</strong>
                    {scoreGain ? (
                      <span aria-hidden="true" className="jetastn-score-gain" key={scoreGain.token}>
                        +{numberFormatter.format(scoreGain.amount)}
                      </span>
                    ) : null}
                  </div>
                  <div className="jetastn-lives" aria-label={`${snapshot.lives} lives remaining`}>
                    <span aria-hidden="true">{"♥".repeat(snapshot.lives)}</span>
                  </div>
                </div>
                <div className="jetastn-level" aria-label={`Level ${snapshot.sector}`}>
                  <span aria-hidden="true">{snapshot.sector}</span>
                </div>
              </div>
              <button className="jetastn-pause" onClick={handlePause} type="button" aria-label="Pause flight">
                <span aria-hidden="true" />
              </button>
            </header>
          ) : null}

          {damagePulse > 0 ? (
            <span aria-hidden="true" className="jetastn-damage-pulse" key={damagePulse} />
          ) : null}

          {snapshot.status === "running" ? (
            <>
              {snapshot.autoPilotEnabled && snapshot.pilotLineActive ? (
                <p
                  aria-live="polite"
                  className="jetastn-pilot-line-float"
                  key={`${snapshot.pilotLineDirection}-${snapshot.pilotLineStep}`}
                  role="status"
                >
                  Pilot line · {pilotDirectionLabel(snapshot.pilotLineDirection)} · {Math.min(3, snapshot.pilotLineStep + 1)}/3
                </p>
              ) : null}

              <nav aria-label="Flight skills" className="jetastn-skill-dock">
                <div aria-label="Core flight skills" className="jetastn-skill-cluster jetastn-skill-cluster--core" role="group">
                  <BrainActionButton
                    emergencyActive={snapshot.emergencyAssistActive}
                    emergencySeconds={snapshot.emergencyAssistSeconds}
                    enabled={snapshot.autoPilotEnabled}
                    onActivate={handleAutoPilotToggle}
                  />
                  {coreSkillReadouts.map((readout) => (
                    <SkillActionButton key={readout.kind} onActivate={handleSkillActivation} readout={readout} />
                  ))}
                </div>
                <div aria-label="Crate-unlocked skills" className="jetastn-skill-cluster jetastn-skill-cluster--crate" role="group">
                  {crateSkillReadouts.map((readout) => (
                    <SkillActionButton key={readout.kind} onActivate={handleSkillActivation} readout={readout} />
                  ))}
                </div>
              </nav>
              <MobileMovementControls onChange={handleMovementControl} />
            </>
          ) : null}

          {snapshot.bossActive ? (
            <div className={`jetastn-bossbar jetastn-bossbar--phase-${snapshot.bossPhase}`}>
              <div className="jetastn-bossbar-label">
                <span>{snapshot.bossName}</span>
                <strong>PHASE {snapshot.bossPhase} · {bossPatternLabel(snapshot.bossPattern)}</strong>
              </div>
              <div
                aria-label={`${snapshot.bossName} hull integrity`}
                aria-valuemax={snapshot.bossMaxHealth}
                aria-valuemin={0}
                aria-valuenow={snapshot.bossHealth}
                className="jetastn-bossbar-track"
                role="progressbar"
              >
                <span style={{ inlineSize: `${bossHealthPercent}%` }} />
              </div>
            </div>
          ) : null}

          {weaponEffects.length > 0 ? (
            <aside aria-label="Active weapons and crate effects" className="jetastn-effects">
              <ul aria-live="polite" className="jetastn-effect-list">
                {weaponEffects.map((effect) => (
                  <li className={`jetastn-effect-chip jetastn-effect-chip--${effect.id}`} key={effect.id}>
                    {effect.label}
                  </li>
                ))}
              </ul>
            </aside>
          ) : null}

          {showOverlay ? (
            <div
              aria-label={snapshot.status === "game-over" ? "Run complete" : undefined}
              aria-labelledby={snapshot.status === "paused" ? "jetfreeper-pause-title" : undefined}
              aria-modal={snapshot.status === "paused" || snapshot.status === "game-over" ? true : undefined}
              className={`jetastn-overlay jetastn-overlay--${snapshot.status}`}
              role={snapshot.status === "paused" || snapshot.status === "game-over" ? "dialog" : undefined}
            >
              <div className={`jetastn-overlay-card jetastn-overlay-card--${snapshot.status}`}>
                {snapshot.status === "ready" ? (
                  <>
                    <div className="jetastn-ready-intro">
                      <p className="jetastn-kicker">ARCADE FLIGHT</p>
                      <h1>Jetfreeper</h1>
                      <p className="jetastn-super-brain-copy">AI Autopilot + human intervention</p>
                      <p className="jetastn-promise">
                        AI Autopilot flies and fights, but human intervention gives you a better chance of survival.
                      </p>
                      <fieldset className="jetastn-difficulty-picker">
                        <legend>Select difficulty</legend>
                        <div className="jetastn-difficulty-options">
                          {RUN_DIFFICULTY_LEVELS.map((level) => {
                            const profile = runDifficultyProfile(level);
                            return (
                              <label className="jetastn-difficulty-option" key={level}>
                                <input
                                  checked={snapshot.difficultyLevel === level}
                                  className="jetastn-difficulty-input"
                                  name="jetfreeper-difficulty"
                                  onChange={() => handleDifficultyChange(level)}
                                  onKeyDown={(event) => {
                                    if (event.key !== "Enter") return;
                                    event.preventDefault();
                                    handlePrimaryAction();
                                  }}
                                  aria-describedby="jetfreeper-difficulty-summary"
                                  type="radio"
                                  value={level}
                                />
                                <span>{profile.label}</span>
                              </label>
                            );
                          })}
                        </div>
                        <p
                          aria-live="polite"
                          className="jetastn-difficulty-summary"
                          id="jetfreeper-difficulty-summary"
                        >
                          {runDifficultyProfile(snapshot.difficultyLevel).summary}
                        </p>
                      </fieldset>
                      <div aria-label="Automatic and manual flight toggle" className="jetastn-flight-onboarding">
                        <span aria-hidden="true" className="jetastn-flight-onboarding-key"><kbd>Q</kbd></span>
                        <span>
                          <strong>Auto / Manual Flight</strong>
                          <small>Manual: steer directly · emergency assist catches critical impact routes</small>
                        </span>
                      </div>
                      <div className="jetastn-ready-launch">
                        <button className="nt-button jetastn-primary" onClick={handlePrimaryAction} type="button">
                          Launch
                        </button>
                        <p className="jetastn-launch-hint"><kbd>Enter</kbd> to launch</p>
                      </div>
                    </div>
                    <div className="jetastn-ready-guide">
                      <div aria-label="Flight controls" className="jetastn-controls">
                        <span><strong><kbd>WASD</kbd> / <kbd>ARROWS</kbd></strong><small>Nudge in Auto · steer in Manual</small></span>
                        <span><strong><kbd className="jetastn-control-key">{JET_FLIGHT_SYSTEM_KEYS.dash}</kbd> DASH</strong><small>Short evade + 10× burst</small></span>
                        <span><strong><kbd className="jetastn-control-key">{JET_FLIGHT_SYSTEM_KEYS["low-profile"]}</kbd> LASER</strong><small>20% boss strike · 5× unit critical · 3× slow time</small></span>
                        <span><strong><kbd className="jetastn-control-key">{JET_FLIGHT_SYSTEM_KEYS.missiles}</kbd> MISSILES</strong><small>Launch 4 homing missiles</small></span>
                        <span><strong><kbd className="jetastn-control-key">{JET_FLIGHT_SYSTEM_KEYS["remote-bomb"]}</kbd> REMOTE BOMB</strong><small>270× blast · press again to detonate</small></span>
                        <span><strong><kbd className="jetastn-control-key">{JET_FLIGHT_SYSTEM_KEYS["guardian-wing"]}</kbd> GUARDIAN WING</strong><small>Two rapid-fire countermeasure wingmen</small></span>
                      </div>
                      <div aria-label="Crate-unlocked systems" className="jetastn-crate-unlocks">
                        <div className="jetastn-crate-unlocks-copy">
                          <strong>Find cores · unlock systems</strong>
                          <small>Super Brain deploys them automatically. Keys 4–6 let you call the moment.</small>
                        </div>
                        <div className="jetastn-crate-control-grid">
                          <span className="jetastn-crate-control jetastn-crate-control--counterflare">
                            <strong><kbd className="jetastn-control-key">{JET_FLIGHT_SYSTEM_KEYS.counterflare}</kbd> Counterflare</strong>
                            <small>Parry nearby fire</small>
                          </span>
                          <span className="jetastn-crate-control jetastn-crate-control--gravity-knot">
                            <strong><kbd className="jetastn-control-key">{JET_FLIGHT_SYSTEM_KEYS["gravity-knot"]}</kbd> Gravity Knot</strong>
                            <small>Hold threats in place</small>
                          </span>
                          <span className="jetastn-crate-control jetastn-crate-control--phoenix-squadron">
                            <strong><kbd className="jetastn-control-key">{JET_FLIGHT_SYSTEM_KEYS["phoenix-squadron"]}</kbd> Phoenix Squadron</strong>
                            <small>Call three strike jets</small>
                          </span>
                        </div>
                      </div>
                    </div>
                  </>
                ) : null}

                {snapshot.status === "paused" ? (
                  <>
                    <h2 id="jetfreeper-pause-title">
                      {snapshot.emergencyAssistActive
                        ? "Emergency assist paused"
                        : snapshot.autoPilotEnabled
                          ? "Paused"
                          : "Manual Flight paused"}
                    </h2>
                    <p className="jetastn-best">
                      {snapshot.emergencyAssistActive
                        ? "Emergency evade is frozen · Manual returns when the route is safe"
                        : snapshot.autoPilotEnabled
                        ? `Super Brain is holding position · ${runDifficultyProfile(snapshot.difficultyLevel).label}`
                        : "WASD / arrows resume direct steering. Auto cannon stays on."}
                    </p>
                  </>
                ) : null}

                {snapshot.status === "game-over" ? (
                  <>
                    <p className="jetastn-kicker">RUN COMPLETE</p>
                    <h2>{numberFormatter.format(snapshot.score)}</h2>
                    <p className="jetastn-best">
                      Best {numberFormatter.format(snapshot.bestScore)} · Sector {snapshot.sector}
                      {snapshot.pilotStyleScore > 0 ? ` · Style ${numberFormatter.format(snapshot.pilotStyleScore)}` : ""}
                    </p>
                    <p className="jetastn-run-tip">
                      “{runCompleteQuote(snapshot.score, snapshot.sector, snapshot.pilotStyleScore)}”
                    </p>
                  </>
                ) : null}

                {snapshot.status === "unsupported" ? (
                  <>
                    <h2>GPU unavailable</h2>
                    <p className="jetastn-error">{runtimeError ?? "Jetfreeper needs WebGL."}</p>
                  </>
                ) : null}

                {snapshot.status === "paused" ? (
                  <div className="jetastn-overlay-actions">
                    <button
                      autoFocus
                      className="nt-button jetastn-primary"
                      onClick={handlePrimaryAction}
                      ref={resumeButtonRef}
                      type="button"
                    >
                      Resume
                    </button>
                    <button className="nt-button nt-button--secondary jetastn-new-game" onClick={handleNewGame} type="button">
                      New Game
                    </button>
                  </div>
                ) : snapshot.status !== "ready" ? (
                  <button className="nt-button jetastn-primary" onClick={handlePrimaryAction} type="button">
                    {primaryLabel(snapshot.status)}
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          {snapshot.announcement ? (
            <p
              aria-live="polite"
              className={`jetastn-announcement jetastn-announcement--${announcementTone(snapshot.announcement)}`}
              key={snapshot.announcement}
              role="status"
            >
              {snapshot.announcement}
            </p>
          ) : null}
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<JetcreeperApp />);
