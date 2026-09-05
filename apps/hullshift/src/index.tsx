import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  IoAlertCircleOutline,
  IoArrowBack,
  IoArrowDown,
  IoArrowForward,
  IoArrowUp,
  IoArrowUndoOutline,
  IoAccessibilityOutline,
  IoCheckmarkCircleOutline,
  IoClose,
  IoHelpCircleOutline,
  IoInformationCircleOutline,
  IoMenu,
  IoReaderOutline,
  IoPlay,
  IoRefresh,
  IoSettingsOutline,
  IoVolumeHighOutline,
} from "react-icons/io5";
import { cx, nt } from "neutron-design-system";
import {
  callTool,
  loadTileContext,
  onAppStateChange,
  type JsonObject,
  type MsgBusEndpointId,
} from "neutron-tools/app";
import {
  HULLSHIFT_TOOLS,
  parseResidentResult,
  parseResidentSnapshot,
} from "./api.ts";
import {
  HULLSHIFT_STATE_TOPIC,
  type ResidentResult,
  type ResidentSnapshot,
  type RunView,
} from "./resident.ts";
import {
  HullshiftRenderer,
  supportsWebGL,
} from "./renderer.ts";
import type { Direction, EngineEvent } from "./model.ts";
import { HullshiftAudio } from "./audio.ts";
import {
  accessibleBoardSummary,
} from "./board_accessibility.ts";
import {
  mechanicReferencesForLevel,
  MECHANIC_REFERENCE,
} from "./mechanic_reference.ts";
import { HullshiftHelpModelGallery } from "./help_model_gallery.tsx";
import type { HintResponse } from "./hints.ts";
import { canonicalStateHash } from "./simulation.ts";
import {
  getTrainingDefinition,
} from "./training.ts";
import "./style.scss";

type Overlay = "menu" | "help" | "hint" | "settings" | "details" | "briefing" | "clear" | null;
type GpuStatus = "ready" | "lost" | "error";

const DIFFICULTY_COPY = [
  "Cadet · one clear system and generous recovery space",
  "Deckhand · short dependencies and forgiving staging",
  "Technician · deliberate pushes and a second system",
  "Specialist · coupled systems with recoverable commitments",
  "Engineer · longer plans and meaningful interleaving",
  "Chief · compact staging with controlled irreversible choices",
  "Navigator · deep dependencies and tighter recovery",
  "Commander · high system coupling and decision pressure",
  "Hullshifter · the full certified mechanism vocabulary",
] as const;

const EMPTY_SNAPSHOT: ResidentSnapshot | null = null;

export function App() {
  const context = useMemo(() => loadTileContext(), []);
  const tileId = context.instance ?? "standalone-hullshift-tile";
  const target = `app:${context.app ?? "hullshift"}:background` as MsgBusEndpointId;
  const mountedRef = useRef(true);
  const snapshotRef = useRef<ResidentSnapshot | null>(null);
  const inputLockedRef = useRef(false);
  const inputTimerRef = useRef<number | null>(null);
  const audioRef = useRef<HullshiftAudio | null>(null);
  const generationSeenRef = useRef<string | null>(null);
  const [snapshot, setSnapshot] = useState<ResidentSnapshot | null>(EMPTY_SNAPSHOT);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const overlayRef = useRef<Overlay>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inputLocked, setInputLocked] = useState(false);
  const [presentationEvents, setPresentationEvents] = useState<readonly EngineEvent[] | null>(null);
  const busyRef = useRef(false);
  const [difficulty, setDifficulty] = useState(2);
  const [gpuStatus, setGpuStatus] = useState<GpuStatus>("ready");
  const [clearConfirmation, setClearConfirmation] = useState("");
  const [hint, setHint] = useState<HintResponse | null>(null);

  const applySnapshot = useCallback((next: ResidentSnapshot) => {
    if (!mountedRef.current) return;
    snapshotRef.current = next;
    setSnapshot(next);
    setConnectionError(null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const value = await callTool(
        { target, name: HULLSHIFT_TOOLS.snapshot, arguments: { tileId } },
        10,
      );
      applySnapshot(parseResidentSnapshot(value));
    } catch (reason) {
      if (mountedRef.current) setConnectionError(errorMessage(reason));
    }
  }, [applySnapshot, target, tileId]);

  useEffect(() => {
    mountedRef.current = true;
    audioRef.current = new HullshiftAudio();
    void refresh();
    const unsubscribe = onAppStateChange(HULLSHIFT_STATE_TOPIC, () => void refresh());
    return () => {
      mountedRef.current = false;
      unsubscribe();
      if (inputTimerRef.current !== null) window.clearTimeout(inputTimerRef.current);
      audioRef.current?.dispose();
      audioRef.current = null;
    };
  }, [refresh]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.setMuted(!(snapshot?.settings.sound ?? true));
  }, [snapshot?.settings.sound]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.setPaused(overlay !== null);
  }, [overlay]);

  useEffect(() => {
    const handleVisibility = () => audioRef.current?.setHidden(document.hidden);
    document.addEventListener("visibilitychange", handleVisibility);
    handleVisibility();
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  useEffect(() => {
    const generating = snapshot?.generation?.state === "running" || snapshot?.generation?.state === "cancelling";
    if (!generating) return;
    const timer = window.setInterval(() => void refresh(), 400);
    return () => window.clearInterval(timer);
  }, [refresh, snapshot?.generation?.state]);

  useEffect(() => {
    if (snapshot === null) return;
    const job = snapshot.generation;
    if (job?.state === "complete" && job.runId && generationSeenRef.current !== job.id) {
      generationSeenRef.current = job.id;
      const run = snapshot?.activeRun;
      const allKnown = run !== null && run !== undefined && mechanicReferencesForLevel(run.level)
        .every((mechanic) => snapshot.learnedMechanics.includes(mechanic.key));
      if (!snapshot.settings.skipKnownBriefings || !allKnown) setOverlay("briefing");
    }
  }, [snapshot]);

  useEffect(() => {
    setPresentationEvents(null);
  }, [snapshot?.activeRunId]);

  const callMutation = useCallback(async (name: string, args: JsonObject): Promise<ResidentResult | null> => {
    if (busyRef.current) return null;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const value = await callTool({ target, name, arguments: args }, 180);
      const result = parseResidentResult(value);
      applySnapshot(result.snapshot);
      if (!result.ok) {
        setNotice(`Mission changed in another tile. Reloaded revision ${result.conflict.actualRevision}.`);
      }
      return result;
    } catch (reason) {
      setNotice(errorMessage(reason));
      return null;
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [applySnapshot, target]);

  const activeRun = snapshot?.activeRun ?? null;
  const reducedMotion = resolveReducedMotion(snapshot);

  const releaseInput = useCallback(() => {
    if (inputTimerRef.current !== null) {
      window.clearTimeout(inputTimerRef.current);
      inputTimerRef.current = null;
    }
    inputLockedRef.current = false;
    setInputLocked(false);
  }, []);

  const submitDirection = useCallback((direction: Direction) => {
    const current = snapshotRef.current;
    const run = current?.activeRun;
    if (!run || run.snapshot.outcome.kind !== "playing" || overlayRef.current !== null || gpuStatus !== "ready") return;
    if (inputLockedRef.current || busyRef.current) {
      return;
    }
    inputLockedRef.current = true;
    setInputLocked(true);
    audioRef.current?.unlock();
    void callMutation(HULLSHIFT_TOOLS.runAction, {
      tileId,
      runId: run.id,
      expectedRevision: run.revision,
      direction,
    }).then((result) => {
      if (result?.ok) {
        const events = result.events ?? [];
        setPresentationEvents(events);
        audioRef.current?.playEvents(events);
      }
    }).finally(() => {
      // Renderer completion normally releases the lock. This bounded fallback
      // covers context loss or a result with no presentation work.
      const delay = resolveReducedMotion(snapshotRef.current) ? 180 : 650;
      inputTimerRef.current = window.setTimeout(releaseInput, delay);
    });
  }, [callMutation, gpuStatus, releaseInput, tileId]);
  useEffect(() => {
    overlayRef.current = overlay;
  }, [overlay]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (inputLockedRef.current) return;
      if (event.key === "Escape" && activeRun?.snapshot.outcome.kind === "playing") {
        event.preventDefault();
        setOverlay((current) => current === null ? "menu" : null);
        return;
      }
      if (overlay !== null) return;
      const direction = directionForKey(event.key);
      if (
        direction !== null &&
        activeRun?.snapshot.outcome.kind === "playing" &&
        !isTextEntryControl(event.target)
      ) {
        event.preventDefault();
        submitDirection(direction);
        return;
      }
      if (isNativeControl(event.target)) return;
      if ((event.key.toLowerCase() === "z" && (event.ctrlKey || event.metaKey || !event.shiftKey)) && activeRun?.canUndo) {
        event.preventDefault();
        void undo(activeRun);
      } else if (event.key.toLowerCase() === "r" && activeRun) {
        event.preventDefault();
        void restart(activeRun);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeRun, overlay, submitDirection]);

  async function undo(run: RunView): Promise<void> {
    const result = await callMutation(HULLSHIFT_TOOLS.runUndo, {
      tileId,
      runId: run.id,
      expectedRevision: run.revision,
    });
    if (result?.ok) setPresentationEvents(result.snapshot.activeRun?.lastEvents ?? []);
  }

  async function restart(run: RunView): Promise<void> {
    const result = await callMutation(HULLSHIFT_TOOLS.runRestart, {
      tileId,
      runId: run.id,
      expectedRevision: run.revision,
    });
    if (result?.ok) {
      setPresentationEvents([]);
      setOverlay(null);
    }
  }

  async function requestHint(run: RunView): Promise<void> {
    const stateHash = canonicalStateHash(run.snapshot.state);
    const tier = hint?.kind === "hint" && hint.stateHash === stateHash ? 2 : 1;
    const result = await callMutation(HULLSHIFT_TOOLS.runHint, {
      tileId,
      runId: run.id,
      expectedRevision: run.revision,
      tier,
    });
    if (result?.ok && result.hint) {
      setHint(result.hint);
      setOverlay("hint");
    }
  }

  async function startMission(selectedDifficulty = difficulty, seed = randomSeed()): Promise<void> {
    const current = snapshotRef.current;
    if (!current) return;
    const result = await callMutation(HULLSHIFT_TOOLS.generationStart, {
      tileId,
      expectedServiceRevision: current.serviceRevision,
      seed,
      difficulty: selectedDifficulty,
    });
    if (result?.ok) {
      setOverlay(null);
    }
  }

  async function dismissGenerationJob(
    job: NonNullable<ResidentSnapshot["generation"]>,
  ): Promise<void> {
    const current = snapshotRef.current;
    if (!current) return;
    const dismissed = await callMutation(HULLSHIFT_TOOLS.generationDismiss, {
      tileId,
      expectedServiceRevision: current.serviceRevision,
      jobId: job.id,
    });
    if (!dismissed?.ok) return;
    const boundRun = dismissed.snapshot.activeRun;
    if (boundRun) {
      await callMutation(HULLSHIFT_TOOLS.runClose, {
        tileId,
        expectedServiceRevision: dismissed.snapshot.serviceRevision,
      });
    }
    setOverlay(null);
  }

  async function openRun(runId: string): Promise<void> {
    const current = snapshotRef.current;
    if (!current) return;
    const result = await callMutation(HULLSHIFT_TOOLS.runOpen, {
      tileId,
      expectedServiceRevision: current.serviceRevision,
      runId,
    });
    if (result?.ok) setOverlay(null);
  }

  async function goHome(): Promise<void> {
    const current = snapshotRef.current;
    if (!current) return;
    const result = await callMutation(HULLSHIFT_TOOLS.runClose, {
      tileId,
      expectedServiceRevision: current.serviceRevision,
    });
    if (result?.ok) {
      releaseInput();
      setPresentationEvents(null);
      setHint(null);
      setGpuStatus("ready");
      setOverlay(null);
    }
  }

  if (snapshot === null) {
    return (
      <main aria-busy="true" className={cx(nt.appFill, "hullshift hullshift--centered")}>
        {connectionError ? (
          <div className={nt.stateError} role="alert">
            <h2>Ship computer unavailable</h2>
            <p>{connectionError}</p>
          </div>
        ) : (
          <div
            aria-label="Connecting to ship computer"
            className={nt.stateLoading}
            role="status"
          >
            <span aria-hidden="true" className={nt.spinner} />
          </div>
        )}
        {connectionError ? <button className={nt.button} onClick={() => void refresh()}>Retry connection</button> : null}
      </main>
    );
  }

  const generationActive = snapshot.generation?.state === "running" || snapshot.generation?.state === "cancelling";
  const generationFailed = snapshot.generation?.state === "error";
  const continuableRun = snapshot.runs.find((run) => (
    run.trainingId === null && run.outcome.kind !== "victory"
  )) ?? null;

  return (
    <main className={cx(nt.appFill, "hullshift", reducedMotion && "hullshift--reduced-motion")}>
      {snapshot.storage.mode === "volatile" ? (
        <div className="hullshift-storage-warning" role="alert">
          <IoAlertCircleOutline aria-hidden="true" />
          <span><strong>Autosave unavailable.</strong> Progress lasts only while the resident stays open.</span>
          <button
            className={nt.buttonGhost}
            disabled={busy}
            onClick={() => void callMutation(HULLSHIFT_TOOLS.storageRetry, {
              tileId,
              expectedServiceRevision: snapshot.serviceRevision,
            })}
          >Retry</button>
        </div>
      ) : null}

      {generationActive ? (
        <GenerationSurface
          job={snapshot.generation!}
          busy={busy}
          onCancel={() => void callMutation(HULLSHIFT_TOOLS.generationCancel, {
            tileId,
            expectedServiceRevision: snapshot.serviceRevision,
            jobId: snapshot.generation!.id,
          })}
        />
      ) : generationFailed ? (
        <GenerationFailureSurface
          job={snapshot.generation!}
          busy={busy}
          onHome={() => void dismissGenerationJob(snapshot.generation!)}
        />
      ) : activeRun ? (
        <GameSurface
          run={activeRun}
          busy={busy}
          inputLocked={inputLocked}
          gpuStatus={gpuStatus}
          reducedMotion={reducedMotion}
          events={presentationEvents ?? activeRun.lastEvents}
          animateEvents={presentationEvents !== null}
          onDirection={submitDirection}
          onGpuStatus={setGpuStatus}
          onPresentationChange={(active) => { if (!active && inputLockedRef.current) releaseInput(); }}
          onRendererRestored={() => void refresh()}
          onExit={() => void goHome()}
          onMenu={() => setOverlay("menu")}
          onUndo={() => void undo(activeRun)}
          onRestart={() => void restart(activeRun)}
        />
      ) : (
        <HomeSurface
          busy={busy}
          difficulty={difficulty}
          onDifficulty={setDifficulty}
          onContinue={continuableRun ? () => void openRun(continuableRun.id) : null}
          onHelp={() => setOverlay("help")}
          onStart={() => void startMission()}
          onSettings={() => setOverlay("settings")}
        />
      )}

      {notice ? (
        <div className="hullshift-notice" role="status">
          <span>{notice}</span>
          <button aria-label="Dismiss message" className={nt.iconButton} onClick={() => setNotice(null)}><IoClose /></button>
        </div>
      ) : null}

      {!inputLocked && activeRun?.snapshot.outcome.kind === "physical-failure" ? (
        <TerminalPanel
          kind="failure"
          title="Hull breach"
          detail={outcomeReason(activeRun)}
          affected={failureReference(activeRun)}
          primary="Rewind"
          primaryDisabled={!activeRun.canUndo || busy}
          onPrimary={() => void undo(activeRun)}
          onRestart={() => void restart(activeRun)}
          onHome={() => void goHome()}
        />
      ) : !inputLocked && activeRun?.snapshot.outcome.kind === "causal-failure" ? (
        <TerminalPanel
          kind="failure"
          title="No evacuation route remains"
          detail={outcomeReason(activeRun)}
          affected={failureReference(activeRun)}
          primary="Rewind"
          primaryDisabled={!activeRun.canUndo || busy}
          onPrimary={() => void undo(activeRun)}
          onRestart={() => void restart(activeRun)}
          onHome={() => void goHome()}
        />
      ) : !inputLocked && activeRun?.snapshot.outcome.kind === "victory" ? (
        <VictoryPanel
          run={activeRun}
          busy={busy}
          onDetails={() => setOverlay("details")}
          onHome={() => void goHome()}
          primaryLabel="New mission at this difficulty"
          onNew={() => {
            setDifficulty(activeRun.identity.difficulty);
            void startMission(activeRun.identity.difficulty);
          }}
          onReplay={() => void restart(activeRun)}
        />
      ) : null}

      {overlay ? (
        <Modal onClose={() => setOverlay(null)} title={overlayTitle(overlay)}>
          {overlay === "menu" && activeRun ? (
            <MenuPanel
              run={activeRun}
              busy={busy}
              onDetails={() => setOverlay("details")}
              onHelp={() => setOverlay("help")}
              onHint={() => void requestHint(activeRun)}
              onHome={() => void goHome()}
              onRestart={() => void restart(activeRun)}
              onSettings={() => setOverlay("settings")}
            />
          ) : overlay === "details" && activeRun ? (
            <DetailsPanel run={activeRun} />
          ) : overlay === "hint" && hint ? (
            <HintPanel hint={hint} />
          ) : overlay === "briefing" && activeRun ? (
            <BriefingPanel
              learnedMechanics={snapshot.learnedMechanics}
              run={activeRun}
              onBegin={() => void callMutation(HULLSHIFT_TOOLS.runBriefed, {
                tileId,
                runId: activeRun.id,
                expectedRevision: activeRun.revision,
              }).then((result) => { if (result?.ok) setOverlay(null); })}
            />
          ) : overlay === "settings" ? (
            <SettingsPanel
              snapshot={snapshot}
              busy={busy}
              onClear={() => setOverlay("clear")}
              onUpdate={(patch) => void callMutation(HULLSHIFT_TOOLS.settingsUpdate, {
                tileId,
                expectedServiceRevision: snapshotRef.current!.serviceRevision,
                ...patch,
              })}
            />
          ) : overlay === "clear" ? (
            <ClearPanel
              value={clearConfirmation}
              busy={busy}
              onChange={setClearConfirmation}
              onClear={() => void callMutation(HULLSHIFT_TOOLS.clearData, {
                tileId,
                expectedServiceRevision: snapshotRef.current!.serviceRevision,
                confirmation: clearConfirmation,
              }).then((result) => {
                if (result?.ok) { setClearConfirmation(""); setOverlay(null); }
              })}
            />
          ) : (
            <HelpPanel reducedMotion={reducedMotion} />
          )}
        </Modal>
      ) : null}
    </main>
  );
}

function HomeSurface(props: {
  difficulty: number;
  busy: boolean;
  onDifficulty(value: number): void;
  onStart(): void;
  onHelp(): void;
  onSettings(): void;
  onContinue: (() => void) | null;
}) {
  return (
    <section className="hullshift-home">
      <div className="hullshift-home-mark" aria-hidden="true"><span>H</span></div>
      <p className={nt.eyebrow}>Emergency deck systems</p>
      <h1>Hullshift</h1>
      <p className="hullshift-home-copy">Push cargo. Route power. Escape a spacecraft that remembers every choice.</p>
      <div className="hullshift-start-panel">
        <label className={nt.field} htmlFor="hullshift-difficulty">
          <span className="hullshift-difficulty-heading"><span className={nt.label}>Difficulty</span><output htmlFor="hullshift-difficulty">{props.difficulty} · {DIFFICULTY_COPY[props.difficulty]?.split(" · ")[0]}</output></span>
          <input
            aria-describedby="hullshift-difficulty-help"
            className="hullshift-difficulty-slider"
            id="hullshift-difficulty"
            max={8}
            min={0}
            onChange={(event) => props.onDifficulty(Number(event.target.value))}
            step={1}
            type="range"
            value={props.difficulty}
          />
          <span className={nt.help} id="hullshift-difficulty-help">{DIFFICULTY_COPY[props.difficulty]}</span>
        </label>
        <button className={nt.button} disabled={props.busy} onClick={props.onStart}><IoPlay /> Start mission</button>
        {props.onContinue ? <button className={nt.buttonSecondary} disabled={props.busy} onClick={props.onContinue}>Continue last game</button> : null}
      </div>
      <div className="hullshift-home-utilities">
        <button className={nt.buttonGhost} onClick={props.onHelp}><IoHelpCircleOutline /> Help</button>
        <button className={nt.buttonGhost} onClick={props.onSettings}><IoSettingsOutline /> Settings</button>
      </div>
    </section>
  );
}

function GenerationSurface(props: { job: NonNullable<ResidentSnapshot["generation"]>; busy: boolean; onCancel(): void }) {
  const progress = props.job.progress;
  return (
    <section aria-busy="true" className="hullshift-generation">
      <div className="hullshift-scanner" aria-hidden="true"><span /><span /><span /></div>
      <p className={nt.eyebrow}>Ship computer</p>
      <h1>Building mission</h1>
      <dl>
        <div><dt>Difficulty</dt><dd>{props.job.difficulty} · {DIFFICULTY_COPY[props.job.difficulty]?.split(" · ")[0]}</dd></div>
        <div><dt>Stage</dt><dd>{progress?.stage.replaceAll("-", " ") ?? "starting"}</dd></div>
        <div><dt>Work</dt><dd>{progress ? `${progress.completed} / ${progress.total}` : "Preparing"}</dd></div>
      </dl>
      {progress ? <progress className={nt.progress} max={Math.max(1, progress.total)} value={progress.completed} /> : null}
      <button className={nt.buttonSecondary} disabled={props.busy || props.job.state === "cancelling"} onClick={props.onCancel}>
        {props.job.state === "cancelling" ? "Cancelling…" : "Cancel"}
      </button>
    </section>
  );
}

function GenerationFailureSurface(props: {
  job: NonNullable<ResidentSnapshot["generation"]>;
  busy: boolean;
  onHome(): void;
}) {
  return (
    <section className="hullshift-generation hullshift-generation--failed" role="alert">
      <IoAlertCircleOutline aria-hidden="true" />
      <p className={nt.eyebrow}>Map generator</p>
      <h1>Mission generation unavailable</h1>
      <p>{props.job.error ?? "HullshiftBrain could not certify this mission."}</p>
      <dl>
        <div><dt>Difficulty</dt><dd>{props.job.difficulty}</dd></div>
      </dl>
      <div><button autoFocus className={nt.button} disabled={props.busy} onClick={props.onHome}>Return home</button></div>
    </section>
  );
}

function GameSurface(props: {
  run: RunView;
  busy: boolean;
  inputLocked: boolean;
  gpuStatus: GpuStatus;
  reducedMotion: boolean;
  events: readonly EngineEvent[];
  animateEvents: boolean;
  onDirection(direction: Direction): void;
  onGpuStatus(status: GpuStatus): void;
  onPresentationChange(active: boolean): void;
  onRendererRestored(): void;
  onExit(): void;
  onMenu(): void;
  onUndo(): void;
  onRestart(): void;
}) {
  const [retryKey, setRetryKey] = useState(0);
  const consumerConsequence = [...props.events].reverse().find((event) => event.type === "consumer-changed");
  return (
    <section className="hullshift-game">
      <header className="hullshift-hud">
        <div className="hullshift-objective">
          <span className="hullshift-objective-mark" aria-hidden="true" />
          <span><small>{props.run.trainingId === null ? "Objective" : getTrainingDefinition(props.run.trainingId).briefing.title}</small>{props.run.trainingId === null ? "Reach the powered evacuation gate" : getTrainingDefinition(props.run.trainingId).briefing.objective}</span>
        </div>
        <div aria-label="Circuit status" className="hullshift-circuit-status">
          {props.run.snapshot.derived.channels.map((channel) => (
            <span
              aria-label={`${channel.symbol} ${channel.active ? "powered" : "unpowered"}`}
              className={channel.active ? "hullshift-circuit--active" : undefined}
              key={channel.id}
              title={`${channel.id}: ${channel.active ? "powered" : "unpowered"}`}
            >{channel.symbol}</span>
          ))}
        </div>
        <div className="hullshift-hud-actions">
          <button aria-keyshortcuts="Z Control+Z Meta+Z" aria-label="Undo move" className={nt.buttonGhost} disabled={!props.run.canUndo || props.busy || props.inputLocked} onClick={props.onUndo}><IoArrowUndoOutline /><span className="hullshift-action-label">Undo</span></button>
          <button aria-label="Exit to lobby" className={nt.buttonGhost} disabled={props.busy || props.inputLocked} onClick={props.onExit}><IoArrowBack /><span className="hullshift-action-label">Lobby</span></button>
          <button aria-label="Mission menu" className={nt.iconButton} disabled={props.busy || props.inputLocked} onClick={props.onMenu}><IoMenu /></button>
        </div>
      </header>
      <BoardStage
        run={props.run}
        events={props.events}
        animateEvents={props.animateEvents}
        reducedMotion={props.reducedMotion}
        retryKey={retryKey}
        onGpuStatus={props.onGpuStatus}
        onPresentationChange={props.onPresentationChange}
        onRendererRestored={props.onRendererRestored}
      />
      {props.gpuStatus !== "ready" ? (
        <div className="hullshift-gpu-error" role="alert">
          <IoAlertCircleOutline />
          <strong>{props.gpuStatus === "lost" ? "GPU context lost" : "WebGL renderer unavailable"}</strong>
          <span>Your mission is safe in the resident service. Restore WebGL, then retry.</span>
          <button className={nt.button} onClick={() => setRetryKey((value) => value + 1)}>Retry renderer</button>
        </div>
      ) : null}
      <div className="hullshift-turn-readout" aria-live="polite">
        <span>{eventSummary(props.events)}</span>
        <span>{props.run.statistics.acceptedActions} moves · {props.run.statistics.pushes} pushes</span>
      </div>
      {consumerConsequence?.type === "consumer-changed" ? (
        <div className="hullshift-consequence" role="status">
          <span aria-hidden="true">{MECHANIC_REFERENCE[consumerConsequence.consumerKind]?.symbol ?? "◇"}</span>
          <p><strong>{directionFrom(props.run.snapshot.state.player, consumerConsequence.position)} · channel {channelSymbol(props.run, consumerConsequence.channel)}</strong><small>{consumerName(consumerConsequence.consumerKind)} is {consumerConsequence.passable ? "passable" : consumerConsequence.jammed ? "jammed" : "closed"}.</small></p>
        </div>
      ) : null}
      <DirectionPad disabled={props.busy || props.inputLocked || props.run.snapshot.outcome.kind !== "playing"} onDirection={props.onDirection} />
      <button className="hullshift-restart-compact" disabled={props.busy || props.inputLocked} onClick={props.onRestart} aria-keyshortcuts="R"><IoRefresh /> Restart</button>
    </section>
  );
}

function BoardStage(props: {
  run: RunView;
  events: readonly EngineEvent[];
  animateEvents: boolean;
  reducedMotion: boolean;
  retryKey: number;
  onGpuStatus(status: GpuStatus): void;
  onPresentationChange(active: boolean): void;
  onRendererRestored(): void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<HullshiftRenderer | null>(null);
  const stableLevel = useMemo(() => props.run.level, [props.run.levelHash]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.focus({ preventScroll: true });
    if (!supportsWebGL()) {
      props.onGpuStatus("error");
      return;
    }
    let renderer: HullshiftRenderer;
    try {
      renderer = new HullshiftRenderer(host, {
        onContextLost: () => props.onGpuStatus("lost"),
        onContextRestored: () => { props.onGpuStatus("ready"); props.onRendererRestored(); },
        onError: () => props.onGpuStatus("error"),
        onPresentationChange: props.onPresentationChange,
      });
      rendererRef.current = renderer;
      renderer.setReducedMotion(props.reducedMotion);
      renderer.setBoard(stableLevel, props.run.snapshot, [], { animate: false });
      props.onGpuStatus(renderer.currentStatus.kind === "ready" ? "ready" : renderer.currentStatus.kind === "context-lost" ? "lost" : "error");
    } catch {
      props.onGpuStatus("error");
      return;
    }
    return () => {
      renderer.dispose();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (props.retryKey === 0) return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    const restored = renderer.retry();
    props.onGpuStatus(restored ? "ready" : "error");
    if (restored) props.onRendererRestored();
  }, [props.retryKey]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setReducedMotion(props.reducedMotion);
    renderer.setBoard(stableLevel, props.run.snapshot, props.events, { animate: props.animateEvents });
  }, [props.animateEvents, props.events, props.reducedMotion, props.run.snapshot, stableLevel]);

  return (
    <div
      aria-label={accessibleBoardSummary(props.run)}
      className="hullshift-board-stage"
      data-retry={props.retryKey}
      onPointerDown={(event) => event.currentTarget.focus({ preventScroll: true })}
      ref={hostRef}
      role="img"
      tabIndex={0}
    />
  );
}

function DirectionPad(props: { disabled: boolean; onDirection(direction: Direction): void }) {
  return (
    <div aria-label="Movement controls" className="hullshift-dpad" role="group">
      <button aria-label="Move north" aria-keyshortcuts="ArrowUp W" disabled={props.disabled} onClick={() => props.onDirection("N")}><IoArrowUp /></button>
      <button aria-label="Move west" aria-keyshortcuts="ArrowLeft A" disabled={props.disabled} onClick={() => props.onDirection("W")}><IoArrowBack /></button>
      <span aria-hidden="true" />
      <button aria-label="Move east" aria-keyshortcuts="ArrowRight D" disabled={props.disabled} onClick={() => props.onDirection("E")}><IoArrowForward /></button>
      <button aria-label="Move south" aria-keyshortcuts="ArrowDown S" disabled={props.disabled} onClick={() => props.onDirection("S")}><IoArrowDown /></button>
    </div>
  );
}

function Modal(props: { title: string; onClose(): void; children: React.ReactNode }) {
  const dialogRef = useModalFocus(props.onClose);
  return (
    <div aria-label={props.title} aria-modal="true" className="hullshift-modal-backdrop" role="dialog">
      <section className={cx(nt.panel, "hullshift-modal")} ref={dialogRef}>
        <header><h2>{props.title}</h2><button aria-label="Close" className={nt.iconButton} onClick={props.onClose}><IoClose /></button></header>
        <div className="hullshift-modal-body">{props.children}</div>
      </section>
    </div>
  );
}

function MenuPanel(props: {
  run: RunView;
  busy: boolean;
  onRestart(): void;
  onDetails(): void;
  onHelp(): void;
  onHint(): void;
  onSettings(): void;
  onHome(): void;
}) {
  return (
    <div className="hullshift-menu-list">
      <button className={nt.buttonSecondary} disabled={props.busy} onClick={props.onRestart}><IoRefresh /> Restart mission</button>
      <button className={nt.buttonGhost} onClick={props.onDetails}><IoInformationCircleOutline /> Mission details</button>
      <button className={nt.buttonGhost} disabled={props.busy || props.run.snapshot.outcome.kind !== "playing"} onClick={props.onHint}><IoHelpCircleOutline /> Hint</button>
      <button className={nt.buttonGhost} onClick={props.onHelp}><IoHelpCircleOutline /> Mechanics & controls</button>
      <button className={nt.buttonGhost} onClick={props.onSettings}><IoSettingsOutline /> Settings</button>
      <button className={nt.buttonGhost} onClick={props.onHome}><IoArrowBack /> Save and exit to lobby</button>
    </div>
  );
}

function DetailsPanel({ run }: { run: RunView }) {
  const mechanics = mechanicsFor(run);
  return (
    <div className="hullshift-details">
      <dl className={nt.detailGrid}>
        <div className={nt.detail}><dt className={nt.detailLabel}>Difficulty</dt><dd className={nt.detailValue}>{run.identity.difficulty} · {DIFFICULTY_COPY[run.identity.difficulty]?.split(" · ")[0]}</dd></div>
        <div className={nt.detail}><dt className={nt.detailLabel}>Board</dt><dd className={nt.detailValue}>{run.level.width} × {run.level.height}</dd></div>
        <div className={nt.detail}><dt className={nt.detailLabel}>Systems</dt><dd className={nt.detailValue}>{mechanics.length}</dd></div>
      </dl>
      <div aria-label="Circuit legend" className="hullshift-circuit-legend">
        {run.snapshot.derived.channels.map((channel) => {
          const sources = run.snapshot.derived.sources.filter((source) => source.channel === channel.id).map((source) => MECHANIC_REFERENCE[source.kind]?.label ?? source.kind);
          const consumers = run.snapshot.derived.consumers.filter((consumer) => consumer.channel === channel.id).map((consumer) => `${consumerName(consumer.kind)} ${consumer.passable ? "open" : consumer.jammed ? "jammed" : "closed"}`);
          return <div key={channel.id}><span className={channel.active ? "hullshift-circuit--active" : undefined}>{channel.symbol}</span><p><strong>{channel.id} · {channel.active ? "powered" : "unpowered"}</strong><small>Sources: {sources.join(", ") || "none"} · Consumers: {consumers.join(", ") || "none"}</small></p></div>;
        })}
      </div>
    </div>
  );
}

function HintPanel({ hint }: { hint: HintResponse }) {
  if (hint.kind === "rewind") {
    return <div className="hullshift-hint"><p className={nt.eyebrow}>Route analysis</p><p>{hint.message}</p><p className={nt.muted}>Use Rewind to return to a certified winning position.</p></div>;
  }
  if (hint.kind === "unavailable") {
    return <div className="hullshift-hint"><p className={nt.eyebrow}>Route analysis unavailable</p><p>{hint.message}</p></div>;
  }
  return (
    <div className="hullshift-hint">
      <p className={nt.eyebrow}>Hint tier {hint.tier}</p>
      {hint.channel ? <div className="hullshift-hint-channel"><span aria-hidden="true">{hint.channel.symbol}</span> Channel {hint.channel.symbol}</div> : null}
      <p>{hint.message}</p>
      {hint.pair ? <p className={nt.muted}>Inspect: {hint.pair.first.label} + {hint.pair.second.label}</p> : <p className={nt.muted}>Ask again from the same position to identify the relevant pair.</p>}
    </div>
  );
}

function BriefingPanel(props: { run: RunView; learnedMechanics: readonly string[]; onBegin(): void }) {
  if (props.run.trainingId !== null) {
    const training = getTrainingDefinition(props.run.trainingId);
    return (
      <div className="hullshift-briefing">
        <p className={nt.eyebrow}>{training.briefing.title}</p>
        <p><strong>{training.briefing.objective}</strong></p>
        <p>{training.briefing.summary}</p>
        <div className="hullshift-training-cards">
          {training.briefing.cards.map((card) => (
            <article key={card.mechanic}><span aria-hidden="true">{card.symbol}</span><p><strong>{card.name}</strong><small>{card.rule}</small></p></article>
          ))}
        </div>
        {training.practice.length > 0 ? <div className="hullshift-practice"><strong>Practice and recover</strong>{training.practice.map((practice) => <p key={practice.id}>{practice.prompt}{practice.recovery ? ` Then use ${practice.recovery}.` : ""}</p>)}</div> : null}
        <button autoFocus className={nt.button} onClick={props.onBegin}>Begin training</button>
      </div>
    );
  }
  const mechanics = mechanicReferencesForLevel(props.run.level);
  const introduced = mechanics.find((mechanic) => !props.learnedMechanics.includes(mechanic.key));
  return (
    <div className="hullshift-briefing">
      <p className={nt.eyebrow}>Mission certified</p>
      <p>Restore a route through the damaged deck and enter the evacuation gate after its channel is active.</p>
      {introduced ? (
        <div className="hullshift-mechanic-callout">
          <p><strong>New: {introduced.label}</strong><small>{introduced.rule}</small></p>
        </div>
      ) : null}
      <div className={nt.tagList}>{mechanics.map((mechanic) => <span className={nt.tag} key={mechanic.key}>{mechanic.label}</span>)}</div>
      <p className={nt.muted}>Difficulty {props.run.identity.difficulty} · {DIFFICULTY_COPY[props.run.identity.difficulty]?.split(" · ")[0]}</p>
      <button autoFocus className={nt.button} onClick={props.onBegin}>Begin mission</button>
    </div>
  );
}

function SettingsPanel(props: {
  snapshot: ResidentSnapshot;
  busy: boolean;
  onUpdate(patch: JsonObject): void;
  onClear(): void;
}) {
  const settings = props.snapshot.settings;
  return (
    <div className={cx(nt.stack, "hullshift-settings")}>
      <section aria-labelledby="hullshift-settings-heading" className={nt.section}>
        <header className={nt.sectionHeader}><h3 className={nt.sectionHeading} id="hullshift-settings-heading">Gameplay preferences</h3><span className={nt.sectionCount}>3</span></header>
        <div className={nt.settingsList}>
          <div className={nt.settingsRow}>
            <span aria-hidden="true" className={nt.settingsIcon}><IoVolumeHighOutline /></span>
            <label className={nt.settingsMain} htmlFor="hullshift-setting-sound"><strong className={nt.settingsTitle}>Sound feedback</strong><span className={nt.settingsDescription}>Device and movement cues; never required for rules.</span></label>
            <span className={nt.settingsMeta}>{settings.sound ? "On" : "Off"}</span>
            <span className={nt.settingsActions}><input checked={settings.sound} className={nt.checkbox} disabled={props.busy} id="hullshift-setting-sound" onChange={(event) => props.onUpdate({ sound: event.target.checked })} type="checkbox" /></span>
          </div>
          <div className={nt.settingsRow}>
            <span aria-hidden="true" className={nt.settingsIcon}><IoAccessibilityOutline /></span>
            <label className={nt.settingsMain} htmlFor="hullshift-setting-motion"><strong className={nt.settingsTitle}>Motion</strong><span className={nt.settingsDescription}>Shorten movement and circuit reactions.</span></label>
            <span className={nt.settingsMeta}>{settings.reducedMotion === "system" ? "System" : settings.reducedMotion === "on" ? "Reduced" : "Full"}</span>
            <span className={nt.settingsActions}><select className={nt.select} disabled={props.busy} id="hullshift-setting-motion" value={settings.reducedMotion} onChange={(event) => props.onUpdate({ reducedMotion: event.target.value })}><option value="system">Follow system</option><option value="on">Reduced</option><option value="off">Full</option></select></span>
          </div>
          <div className={nt.settingsRow}>
            <span aria-hidden="true" className={nt.settingsIcon}><IoReaderOutline /></span>
            <label className={nt.settingsMain} htmlFor="hullshift-setting-briefings"><strong className={nt.settingsTitle}>Known briefings</strong><span className={nt.settingsDescription}>Skip mechanic briefings already seen.</span></label>
            <span className={nt.settingsMeta}>{settings.skipKnownBriefings ? "Skip" : "Show"}</span>
            <span className={nt.settingsActions}><input checked={settings.skipKnownBriefings} className={nt.checkbox} disabled={props.busy} id="hullshift-setting-briefings" onChange={(event) => props.onUpdate({ skipKnownBriefings: event.target.checked })} type="checkbox" /></span>
          </div>
        </div>
      </section>
      <button className={nt.buttonDanger} disabled={props.busy} onClick={props.onClear}>Clear local data…</button>
    </div>
  );
}

function ClearPanel(props: { value: string; busy: boolean; onChange(value: string): void; onClear(): void }) {
  return (
    <div className={nt.form}>
      <div className={nt.alertDanger}>This permanently deletes all local missions, completion summaries, and settings.</div>
      <label className={nt.field}><span className={nt.label}>Type CLEAR HULLSHIFT to confirm</span><input autoFocus className={nt.input} value={props.value} onChange={(event) => props.onChange(event.target.value)} /></label>
      <button className={nt.buttonDanger} disabled={props.busy || props.value !== "CLEAR HULLSHIFT"} onClick={props.onClear}>Clear local data</button>
    </div>
  );
}

function HelpPanel({ reducedMotion }: { reducedMotion: boolean }) {
  return (
    <div className="hullshift-help">
      <p>Move the maintenance droid with arrow keys, WASD, or the direction pad. Push one object at a time; objects cannot be pulled or chain-pushed.</p>
      <HullshiftHelpModelGallery reducedMotion={reducedMotion} />
      <p><kbd>Z</kbd> undo · <kbd>R</kbd> restart · <kbd>Esc</kbd> menu</p>
    </div>
  );
}

function TerminalPanel(props: { kind: "failure"; title: string; detail: string; affected: { symbol: string; label: string } | null; primary: string; primaryDisabled: boolean; onPrimary(): void; onRestart(): void; onHome(): void }) {
  const dialogRef = useModalFocus();
  return (
    <div aria-label={props.title} aria-modal="true" className="hullshift-terminal-backdrop" role="dialog">
      <section className="hullshift-terminal hullshift-terminal--failure" ref={dialogRef}>
        <IoAlertCircleOutline aria-hidden="true" />
        <h2>{props.title}</h2><p>{props.detail}</p>
        {props.affected ? <p className="hullshift-affected"><span aria-hidden="true">{props.affected.symbol}</span> Affected: {props.affected.label}</p> : null}
        <div><button autoFocus className={nt.button} disabled={props.primaryDisabled} onClick={props.onPrimary}>{props.primary}</button><button className={nt.buttonSecondary} onClick={props.onRestart}>Restart</button><button className={nt.buttonGhost} onClick={props.onHome}><IoArrowBack /> Exit to lobby</button></div>
      </section>
    </div>
  );
}

function VictoryPanel(props: { run: RunView; busy: boolean; primaryLabel: string; onReplay(): void; onNew(): void; onDetails(): void; onHome(): void }) {
  const dialogRef = useModalFocus();
  const reference = props.run.optimalActions === null
    ? "Certified route complete."
    : `Certified reference: ${props.run.optimalActions} actions${props.run.optimalPushes === null ? "" : ` and ${props.run.optimalPushes} pushes`}. Your route is one valid solution, not a score.`;
  return (
    <div aria-label="Evacuation complete" aria-modal="true" className="hullshift-terminal-backdrop" role="dialog">
      <section className="hullshift-terminal hullshift-terminal--victory" ref={dialogRef}>
        <IoCheckmarkCircleOutline aria-hidden="true" />
        <p className={nt.eyebrow}>Evacuation complete</p><h2>Hull shifted. Route secured.</h2>
        <div className="hullshift-results">
          <span><strong>{props.run.trainingId === null ? props.run.identity.difficulty : getTrainingDefinition(props.run.trainingId).order}</strong> {props.run.trainingId === null ? "difficulty" : "training"}</span>
          <span><strong>{props.run.statistics.acceptedActions}</strong> actions</span>
          <span><strong>{props.run.statistics.pushes}</strong> pushes</span>
          <span><strong>{props.run.statistics.commitments}</strong> commitments</span>
          <span><strong>{props.run.statistics.rewinds}</strong> rewinds</span>
          <span><strong>{props.run.statistics.hints}</strong> hints</span>
        </div>
        <p className="hullshift-reference">{reference}</p>
        <div><button autoFocus className={nt.button} disabled={props.busy} onClick={props.onNew}>{props.primaryLabel}</button><button className={nt.buttonSecondary} onClick={props.onReplay}>Replay</button><button className={nt.buttonGhost} onClick={props.onDetails}>Mission details</button><button className={nt.buttonGhost} onClick={props.onHome}><IoArrowBack /> Exit to lobby</button></div>
      </section>
    </div>
  );
}

function useModalFocus(onEscape?: () => void) {
  const containerRef = useRef<HTMLElement>(null);
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () => [...container.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
    )].filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
    (container.querySelector<HTMLElement>("[autofocus]") ?? focusables()[0] ?? container).focus({ preventScroll: true });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && onEscapeRef.current) {
        event.preventDefault();
        event.stopPropagation();
        onEscapeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const candidates = focusables();
      if (candidates.length === 0) {
        event.preventDefault();
        return;
      }
      const first = candidates[0]!;
      const last = candidates.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      previous?.focus({ preventScroll: true });
    };
  }, []);
  return containerRef;
}

function directionForKey(key: string): Direction | null {
  switch (key.toLowerCase()) {
    case "arrowup": case "w": return "N";
    case "arrowright": case "d": return "E";
    case "arrowdown": case "s": return "S";
    case "arrowleft": case "a": return "W";
    default: return null;
  }
}

function isNativeControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("button, a, input, select, textarea, [role='button']") !== null;
}

function isTextEntryControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("input, select, textarea, [contenteditable='true']") !== null;
}

function randomSeed(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function resolveReducedMotion(snapshot: ResidentSnapshot | null): boolean {
  const setting = snapshot?.settings.reducedMotion ?? "system";
  if (setting === "on") return true;
  if (setting === "off") return false;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Hullshift request failed";
}

function overlayTitle(overlay: Exclude<Overlay, null>): string {
  return ({ menu: "Mission menu", help: "Mechanics & controls", hint: "Ship computer hint", settings: "Settings", details: "Mission details", briefing: "Mission briefing", clear: "Clear local data" })[overlay];
}

function mechanicsFor(run: RunView): string[] {
  return mechanicReferencesForLevel(run.level).map((mechanic) => mechanic.label);
}

function eventSummary(events: readonly EngineEvent[]): string {
  const last = events.at(-1);
  if (!last) return "Ship systems stable";
  if (last.type === "blocked") {
    return `${last.attempt === "push" ? "Push" : "Movement"} blocked · ${last.reason.replaceAll("-", " ")}`;
  }
  return ({
    "object-pushed": "Cargo shifted",
    "relay-toggled": "Relay toggled",
    "socket-docked": "Reactor cell docked",
    "source-changed": "Power source changed",
    "channel-changed": "Power routing changed",
    "consumer-changed": "Connected ship system changed",
    "fracture-collapsed": "Deck fracture collapsed",
    "object-removed": "Object lost from the deck",
    "gate-entered": "Evacuation gate reached",
    "physical-failure": "Hull breach detected",
    "causal-failure": "Evacuation route lost",
    victory: "Evacuation route complete",
    "player-moved": "Droid moved",
    "entity-entered": "Cell entered",
    "entity-exited": "Cell vacated",
  } as Record<string, string>)[last.type] ?? "Ship state changed";
}

function outcomeReason(run: RunView): string {
  const reason = "reason" in run.snapshot.outcome ? run.snapshot.outcome.reason : null;
  return typeof reason === "string" && reason.length > 0 ? reason.replaceAll("-", " ") : "The last action left no safe route to evacuation.";
}

function channelSymbol(run: RunView, channelId: string): string {
  return run.snapshot.derived.channels.find((channel) => channel.id === channelId)?.symbol ?? channelId;
}

function consumerName(kind: "door" | "bridge" | "gate"): string {
  return ({ door: "Blast door", bridge: "Phase bridge", gate: "Evacuation gate" } as const)[kind];
}

function directionFrom(origin: { x: number; y: number } | null, target: { x: number; y: number }): string {
  if (origin === null) return "Remote";
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  if (dx === 0 && dy === 0) return "Here";
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "East" : "West";
  return dy > 0 ? "South" : "North";
}

function failureReference(run: RunView): { symbol: string; label: string } | null {
  const events = [...run.lastEvents].reverse();
  const physical = events.find((event) => event.type === "physical-failure");
  if (physical?.type === "physical-failure") {
    const key = physical.reason === "bridge-lost" ? "bridge" : "vacuum";
    const mechanic = MECHANIC_REFERENCE[key]!;
    return { symbol: mechanic.symbol, label: mechanic.label };
  }
  const removed = events.find((event) => event.type === "object-removed");
  if (removed?.type === "object-removed") {
    const mechanic = MECHANIC_REFERENCE[removed.objectKind === "reactor-cell" ? "reactor" : "cargo"]!;
    return { symbol: mechanic.symbol, label: mechanic.label };
  }
  const consumer = events.find((event) => event.type === "consumer-changed" && !event.powered);
  if (consumer?.type === "consumer-changed") {
    const mechanic = MECHANIC_REFERENCE[consumer.consumerKind]!;
    return mechanic ? { symbol: mechanic.symbol, label: `${mechanic.label} · channel ${consumer.channel}` } : null;
  }
  return null;
}

const root = document.getElementById("root");
if (!root) throw new Error("Hullshift root element is missing");
createRoot(root).render(<App />);
