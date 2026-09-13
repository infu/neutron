import { useState } from "react";
import type { LevelDefinition, EngineSnapshot } from "./model.ts";
import type { FreightMechanism } from "./freight_puzzles.ts";

export const SYSTEM_GUIDE: Readonly<Record<FreightMechanism, { name: string; icon: string; rule: string }>> = {
  plate: { name: "Pressure plate", icon: "◈", rule: "Keep a droid or object on the round plate to power its matching doors and bridges. Moving the weight away cuts the power." },
  relay: { name: "Toggle relay", icon: "◐", rule: "Step onto the lever to flip its circuit on or off. It remembers its setting when you leave. Pushing a pod across it does not flip it." },
  reactor: { name: "Reactor docking", icon: "◆", rule: "Push the gold reactor cell into its round socket for permanent power. The installed cell stays there and blocks that square." },
  bridge: { name: "Powered bridge", icon: "═", rule: "A bridge is safe only while its circuit has power. Switch it off and anything standing on it falls. Plan your way back." },
  fracture: { name: "Cracked floor", icon: "╳", rule: "The yellow cracked tile collapses after the last occupant leaves. You cannot cross the hole again. Undo restores it." },
  disposal: { name: "Disposal chute", icon: "▽", rule: "Push unwanted cargo into the chute to clear a passage. It removes the object; the droid cannot enter. Keep enough pods for every mint bay." },
};

export { bayProgress } from "./mechanics.ts";

export function systemsFor(level: LevelDefinition): FreightMechanism[] {
  return (Object.keys(SYSTEM_GUIDE) as FreightMechanism[]).filter((kind) => level.cells.some((cell) => kind === "fracture" ? cell.terrain === "fracture" : cell.fixture?.kind === (kind === "reactor" ? "socket" : kind)));
}

export function SystemsOnDeck({ level, snapshot }: { level: LevelDefinition; snapshot: EngineSnapshot }) {
  const systems = systemsFor(level);
  const [selected, setSelected] = useState<FreightMechanism | null>(systems[0] ?? null);
  return <div className="hs-deck-systems">
    <div className="hs-system-buttons" aria-label="Systems on this deck"><span>On this deck</span>{systems.map((system) => <button key={system} type="button" aria-pressed={selected === system} onClick={() => setSelected(selected === system ? null : system)}><i aria-hidden="true">{SYSTEM_GUIDE[system].icon}</i>{SYSTEM_GUIDE[system].name}</button>)}</div>
    {selected ? <p className="hs-system-rule">{SYSTEM_GUIDE[selected].rule}</p> : null}
    <div className="hs-live-circuits" aria-label="Circuit status"><span>Match the marks:</span>{snapshot.derived.channels.map((channel, index) => <span key={channel.id} className={channel.active ? "is-powered" : ""}><b>{"•".repeat(index + 1)} {channel.symbol}</b> {channel.active ? "on" : "off"}</span>)}</div>
  </div>;
}
