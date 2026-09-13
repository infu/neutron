import { useEffect, useRef, useState } from "react";
import { IoArrowForward, IoHelpCircleOutline, IoPlay, IoSettingsOutline } from "react-icons/io5";
import { nt } from "neutron-design-system";
import { FREIGHT_DIFFICULTIES, generateFreightPuzzle } from "./freight_puzzles.ts";
import { SYSTEM_GUIDE } from "./freight_ui.tsx";
import { HullshiftRenderer } from "./renderer.ts";
import { createInitialSnapshot } from "./simulation.ts";
import { parseShareCode, type GeneratorVersion } from "./share_code.ts";
import { formatCanonicalSeed } from "./prng.ts";
import type { ResidentSnapshot, RunView } from "./resident.ts";
import { MECHANIC_REFERENCE } from "./mechanic_reference.ts";
import type { HintResponse } from "./hints.ts";

export function HomeSurface(props: {
  difficulty: number; busy: boolean; runs: ResidentSnapshot["runs"];
  onDifficulty(value: number): void; onStart(difficulty?: number, seed?: string, generatorVersion?: GeneratorVersion): void;
  onHelp(): void; onSettings(): void; onOpen(id: string): void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const profile = FREIGHT_DIFFICULTIES[props.difficulty]!;
  const recent = props.runs.filter((run) => run.trainingId === null && run.outcome.kind !== "victory");
  function openCode() {
    try {
      const identity = parseShareCode(code.trim());
      if (!["g4", "g5", "g6"].includes(identity.generatorVersion)) throw new Error("You can resume this older puzzle from your saved games.");
      setError(null);
      props.onDifficulty(identity.difficulty);
      props.onStart(identity.difficulty, formatCanonicalSeed(identity.seed), identity.generatorVersion);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Check the puzzle code."); }
  }
  return <section className="hullshift-home">
    <header className="hs-home-header"><span className="hs-brand"><i aria-hidden="true">◇</i> HULLSHIFT</span><div>
      <button aria-label="How to play" className={nt.iconButton} onClick={props.onHelp}><IoHelpCircleOutline /></button>
      <button aria-label="Settings" className={nt.iconButton} onClick={props.onSettings}><IoSettingsOutline /></button>
    </div></header>
    <div className="hs-home-main">
      <div className="hs-home-intro">
        <p className="hs-kicker">A little space to think.</p>
        <h1>Small moves.<br /><em>Big ideas.</em></h1>
        <p className="hullshift-home-copy">A tiny droid. A deck of possibilities. Park cargo, connect power, and plan around a world that changes with your moves.</p>
        <div className="hs-home-rules"><span><i className="hs-legend-pod" /> Push pods</span><span><i className="hs-legend-bay" /> Fill bays</span><span>↶ Undo freely</span></div>
      </div>
      <div className="hs-home-preview"><HomeDeck /><span>Find your way around the problem.</span></div>
      <div className="hullshift-start-panel">
        <div className="hullshift-difficulty-heading"><label htmlFor="hullshift-difficulty">Choose your challenge</label><output htmlFor="hullshift-difficulty">{props.difficulty + 1} / 9</output></div>
        <input aria-describedby="hullshift-difficulty-help" aria-label="Difficulty" className="hullshift-difficulty-slider" id="hullshift-difficulty" type="range" min={0} max={8} step={1} value={props.difficulty} onChange={(event) => props.onDifficulty(Number(event.target.value))} />
        <div className="hs-difficulty-labels"><span>Easy does it</span><span>Brain workout</span></div>
        <div className="hs-difficulty-copy" id="hullshift-difficulty-help"><strong>{profile.name}</strong><span>{profile.description}</span></div>
        <button className={nt.button} disabled={props.busy} onClick={() => props.onStart()}><IoPlay /> New puzzle <IoArrowForward /></button>
        <p className="hs-fresh-note">A fresh layout every time. No timer. No lives.</p>
      </div>
      <div className="hs-home-secondary">
        {recent.length > 0 ? <div className="hs-recent"><p className="hs-kicker">Pick up where you left off</p>{recent.slice(0, 3).map((run) => <button className="hs-recent-run" disabled={props.busy} key={run.id} onClick={() => props.onOpen(run.id)}><span><strong>Difficulty {run.difficulty + 1}</strong><small>{run.pushes} pushes · saved automatically</small></span><IoArrowForward /></button>)}</div> : <div className="hs-welcome-note"><strong>Easy to learn. Room to get lost.</strong><p>Move with arrow keys, WASD, or the on-screen controls. You can push, but you can’t pull. Stuck? Undo or ask for a hint.</p></div>}
        <div className="hs-system-preview" aria-label="Six puzzle systems">{Object.values(SYSTEM_GUIDE).map((s) => <span key={s.name}><i aria-hidden="true">{s.icon}</i>{s.name}</span>)}</div>
        <details className="hs-code"><summary>Have a puzzle code?</summary><form onSubmit={(event) => { event.preventDefault(); openCode(); }}><label className={nt.field}><span className={nt.label}>Puzzle code</span><input className={nt.input} value={code} onChange={(event) => setCode(event.target.value)} placeholder="HS1-G6-…" spellCheck={false} /></label><button className={nt.buttonSecondary} disabled={!code.trim() || props.busy}>Play this puzzle</button></form>{error ? <p role="alert">{error}</p> : null}</details>
      </div>
    </div>
    <footer className="hs-home-footer"><span>Six systems. Countless possibilities.</span><span>Made for a quiet moment.</span></footer>
  </section>;
}

function HomeDeck() {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let renderer: HullshiftRenderer | null = null;
    let cancelled = false;
    // A small illustrative board; playable puzzles always use the chosen seed.
    void generateFreightPuzzle(123n, 2).then(({ level }) => {
      if (cancelled || !hostRef.current) return;
      try {
        renderer = new HullshiftRenderer(hostRef.current);
        renderer.setReducedMotion(true);
        renderer.setBoard(level, createInitialSnapshot(level), [], { animate: false });
      } catch { /* The play screen offers renderer recovery if WebGL is absent. */ }
    });
    return () => { cancelled = true; renderer?.dispose(); };
  }, []);
  return <div aria-label="A little cargo deck with a white droid, orange pods, and glowing bays" className="hs-home-deck" ref={hostRef} role="img" />;
}

/** A readable, coordinate-labelled map makes hint locations unambiguous. */
export function CargoHintMap({ run, hint }: { run: RunView; hint: HintResponse }) {
  const { level, snapshot } = run;
  const highlights = hint.kind === "hint" ? hint.highlights : [];
  return <svg className="hs-hint-map" viewBox={`-0.6 -0.6 ${level.width + 0.8} ${level.height + 0.8}`} aria-label="Current puzzle with row and column labels and suggested positions" role="img">
    {Array.from({ length: level.width }, (_, x) => <text key={`x${x}`} x={x + 0.5} y={-0.15}>{String.fromCharCode(65 + x)}</text>)}
    {Array.from({ length: level.height }, (_, y) => <text key={`y${y}`} x={-0.28} y={y + 0.59}>{y + 1}</text>)}
    {level.cells.map((cell, index) => {
      const x = index % level.width, y = Math.floor(index / level.width);
      const collapsed = snapshot.state.collapsedFractures.some((p) => p.x === x && p.y === y);
      const fixture = cell.fixture;
      const bay = fixture?.kind === "bay" || level.objective === "cargo" && fixture?.kind === "plate";
      const channel = fixture && "channel" in fixture ? snapshot.derived.channels.find((c) => c.id === fixture.channel) : null;
      const installed = snapshot.state.installedCells.some((c) => c.socketId === fixture?.id);
      return <g key={index} transform={`translate(${x},${y})`}>
        <rect x={0.035} y={0.035} width={0.93} height={0.93} rx={0.08} fill={cell.terrain === "bulkhead" ? "#415773" : collapsed || cell.terrain === "vacuum" ? "#060b13" : "#162333"} />
        {bay ? <rect x={0.15} y={0.15} width={0.7} height={0.7} rx={0.08} fill="none" stroke="#79e3c0" strokeWidth={0.055} /> : fixture || cell.terrain === "fracture" ? <text x={0.5} y={0.66} style={{ fontSize: ".6px", fill: installed ? "#ffd677" : channel?.active ? "#79e3c0" : "#b5c5d6" }}>{fixture ? MECHANIC_REFERENCE[fixture.kind]?.symbol : collapsed ? "·" : "╳"}</text> : null}
        {channel && !bay ? <text x={0.81} y={0.28} style={{ fontSize: ".24px", fill: channel.active ? "#79e3c0" : "#b5c5d6" }}>{channel.symbol}</text> : null}
      </g>;
    })}
    {snapshot.state.objects.map((object) => object.kind === "reactor-cell" ? <path key={object.id} d={`M ${object.position.x + .5} ${object.position.y + .18} l .32 .32 l -.32 .32 l -.32 -.32 Z`} fill="#f7df61" /> : <rect key={object.id} x={object.position.x + 0.22} y={object.position.y + 0.22} width={0.56} height={0.56} rx={0.09} fill="#ffb663" />)}
    {snapshot.state.player ? <circle cx={snapshot.state.player.x + 0.5} cy={snapshot.state.player.y + 0.5} r={0.25} fill="#f6f0df" /> : null}
    {highlights.map((mark, i) => <g key={i}><rect x={mark.position.x + 0.08} y={mark.position.y + 0.08} width={0.84} height={0.84} rx={0.1} fill="none" stroke={i === 0 ? "#ffd677" : "#7fdcef"} strokeWidth={0.1} /><text x={mark.position.x + 0.5} y={mark.position.y + 0.6} style={{ fill: "#0b111a", fontWeight: 900 }}>{i + 1}</text></g>)}
  </svg>;
}
