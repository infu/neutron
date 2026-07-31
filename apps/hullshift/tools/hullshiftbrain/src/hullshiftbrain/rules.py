"""Pure forward Hullshift mechanics mirror.

This is deliberately written for auditability, not cleverness.  Every inverse
proposal and generated witness is round-tripped through :func:`transition`.
The production TypeScript implementation still certifies catalog artifacts.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any, Literal

from .canonical import canonical_state_key
from .schema import (
    MAX_CASCADE_PASSES,
    Coord,
    Direction,
    Fixture,
    GameObject,
    InstalledCell,
    Level,
    ObjectKind,
    PuzzleState,
    assert_valid_level,
    canonical_state,
    fixtures,
    without_object,
)


@dataclass(frozen=True, slots=True)
class Source:
    fixture_id: str
    kind: Literal["plate", "relay", "socket"]
    channel: str
    position: Coord
    active: bool


@dataclass(frozen=True, slots=True)
class ChannelValue:
    id: str
    symbol: str
    active: bool


@dataclass(frozen=True, slots=True)
class Consumer:
    fixture_id: str
    kind: Literal["door", "bridge", "gate"]
    channel: str
    position: Coord
    powered: bool
    passable: bool
    jammed: bool


@dataclass(frozen=True, slots=True)
class Derived:
    sources: tuple[Source, ...]
    channels: tuple[ChannelValue, ...]
    consumers: tuple[Consumer, ...]


@dataclass(frozen=True, slots=True)
class Outcome:
    kind: Literal["playing", "physical-failure", "causal-failure", "victory"]
    reason: str | None = None
    position: Coord | None = None
    fixture_id: str | None = None
    gate_id: str | None = None


PLAYING = Outcome("playing")


@dataclass(frozen=True, slots=True)
class Snapshot:
    state: PuzzleState
    derived: Derived
    outcome: Outcome = PLAYING


@dataclass(frozen=True, slots=True)
class TransitionResult:
    accepted: bool
    pushed: bool
    action: Direction
    before: Snapshot
    after: Snapshot
    events: tuple[dict[str, Any], ...]
    internal_passes: int
    blocked_reason: str | None = None


def object_at(state: PuzzleState, position: Coord) -> GameObject | None:
    return next((item for item in state.objects if item.position == position), None)


def occupied(state: PuzzleState, position: Coord) -> bool:
    return state.player == position or object_at(state, position) is not None


def effective_terrain(level: Level, state: PuzzleState, position: Coord) -> str | None:
    cell = level.cell(position)
    if cell is None:
        return None
    if cell.terrain == "fracture" and position in state.collapsed_fractures:
        return "vacuum"
    return cell.terrain


def derive(level: Level, state: PuzzleState) -> Derived:
    relays = set(state.active_relay_ids)
    sockets = {item.socket_id for item in state.installed_cells}
    sources: list[Source] = []
    for position, fixture in fixtures(level):
        if fixture.kind == "plate":
            sources.append(Source(fixture.id, "plate", fixture.channel or "", position, occupied(state, position)))
        elif fixture.kind == "relay":
            sources.append(Source(fixture.id, "relay", fixture.channel or "", position, fixture.id in relays))
        elif fixture.kind == "socket":
            sources.append(Source(fixture.id, "socket", fixture.channel or "", position, fixture.id in sockets))

    channels = tuple(
        ChannelValue(
            item.id,
            item.symbol,
            any(source.channel == item.id and source.active for source in sources),
        )
        for item in sorted(level.channels, key=lambda channel: channel.id)
    )
    active = {item.id for item in channels if item.active}
    consumers: list[Consumer] = []
    for position, fixture in fixtures(level):
        if fixture.kind not in ("door", "bridge", "gate"):
            continue
        powered = (fixture.channel or "") in active
        jammed = fixture.kind == "door" and not powered and occupied(state, position)
        consumers.append(
            Consumer(
                fixture.id,
                fixture.kind,
                fixture.channel or "",
                position,
                powered,
                powered or jammed if fixture.kind == "door" else powered,
                jammed,
            )
        )
    return Derived(tuple(sources), channels, tuple(consumers))


def consumer_for(derived: Derived, fixture_id: str) -> Consumer | None:
    return next((item for item in derived.consumers if item.fixture_id == fixture_id), None)


def classify_player_entry(
    level: Level,
    state: PuzzleState,
    derived: Derived,
    position: Coord,
) -> tuple[str, str | None]:
    cell = level.cell(position)
    if cell is None:
        return "blocked", "edge"
    terrain = effective_terrain(level, state, position)
    if terrain == "bulkhead":
        return "blocked", "bulkhead"
    fixture = cell.fixture
    if fixture is not None and fixture.kind == "bridge":
        bridge = consumer_for(derived, fixture.id)
        return ("stable", None) if bridge is not None and bridge.passable else ("player-hazard", "bridge-lost")
    if terrain == "vacuum":
        return "player-hazard", "vacuum"
    if fixture is None or fixture.kind in ("plate", "relay"):
        return "stable", None
    if fixture.kind == "socket":
        installed = any(item.socket_id == fixture.id for item in state.installed_cells)
        return ("blocked", "installed-socket") if installed else ("stable", None)
    if fixture.kind == "door":
        door = consumer_for(derived, fixture.id)
        return ("stable", None) if door is not None and door.passable else ("blocked", "closed-door")
    if fixture.kind == "disposal":
        return "blocked", "disposal-blocks-player"
    if fixture.kind == "gate":
        gate = consumer_for(derived, fixture.id)
        return ("gate", None) if gate is not None and gate.powered else ("blocked", "inactive-gate")
    return "blocked", "unsupported-terrain"


def classify_object_entry(
    level: Level,
    state: PuzzleState,
    derived: Derived,
    position: Coord,
    object_kind: ObjectKind,
) -> tuple[str, str | None]:
    cell = level.cell(position)
    if cell is None:
        return "blocked", "edge"
    terrain = effective_terrain(level, state, position)
    if terrain == "bulkhead":
        return "blocked", "bulkhead"
    fixture = cell.fixture
    if fixture is not None and fixture.kind == "bridge":
        bridge = consumer_for(derived, fixture.id)
        return ("stable", None) if bridge is not None and bridge.passable else ("object-loss", "bridge-lost")
    if terrain == "vacuum":
        return "object-loss", "vacuum"
    if fixture is None or fixture.kind in ("plate", "relay"):
        return "stable", None
    if fixture.kind == "socket":
        if any(item.socket_id == fixture.id for item in state.installed_cells):
            return "blocked", "installed-socket"
        return ("dock", None) if object_kind == "reactor-cell" else ("stable", None)
    if fixture.kind == "door":
        door = consumer_for(derived, fixture.id)
        return ("stable", None) if door is not None and door.passable else ("blocked", "closed-door")
    if fixture.kind == "disposal":
        return "object-loss", "disposal"
    if fixture.kind == "gate":
        return "blocked", "gate-blocks-object"
    return "blocked", "unsupported-terrain"


def initial_state(level: Level) -> PuzzleState:
    relays = sorted(fixture.id for _, fixture in fixtures(level) if fixture.kind == "relay" and fixture.initial_on)
    installed = sorted(
        (
            InstalledCell(fixture.id, fixture.initial_cell_id or f"installed:{fixture.id}")
            for _, fixture in fixtures(level)
            if fixture.kind == "socket" and fixture.initially_installed
        ),
        key=lambda item: item.socket_id,
    )
    return canonical_state(
        PuzzleState(
            player=level.player_start,
            objects=tuple(level.objects),
            active_relay_ids=tuple(relays),
            installed_cells=tuple(installed),
        )
    )


def initial_snapshot(level: Level, *, validate: bool = True) -> Snapshot:
    if validate:
        assert_valid_level(level)
    state = initial_state(level)
    return Snapshot(state, derive(level, state), PLAYING)


def snapshot(level: Level, state: PuzzleState, outcome: Outcome = PLAYING) -> Snapshot:
    state = canonical_state(state)
    return Snapshot(state, derive(level, state), outcome)


def _blocked(before: Snapshot, action: Direction, attempt: str, reason: str, at: Coord) -> TransitionResult:
    return TransitionResult(
        accepted=False,
        pushed=False,
        action=action,
        before=before,
        after=before,
        events=({"type": "blocked", "action": action, "attempt": attempt, "reason": reason, "at": at.to_json()},),
        internal_passes=0,
        blocked_reason=reason,
    )


def _entity_ref(item: GameObject | None) -> dict[str, Any]:
    return {"kind": "player"} if item is None else {"kind": "object", "objectId": item.id, "objectKind": item.kind}


def _append_derived_changes(previous: Derived, nxt: Derived, events: list[dict[str, Any]]) -> None:
    old_sources = {item.fixture_id: item for item in previous.sources}
    for source in nxt.sources:
        old = old_sources.get(source.fixture_id)
        if old is not None and old.active == source.active:
            continue
        events.append({
            "type": "source-changed",
            "fixtureId": source.fixture_id,
            "sourceKind": source.kind,
            "channel": source.channel,
            "position": source.position.to_json(),
            "active": source.active,
        })
    old_channels = {item.id: item.active for item in previous.channels}
    for channel in nxt.channels:
        if old_channels.get(channel.id) != channel.active:
            events.append({"type": "channel-changed", "channel": channel.id, "active": channel.active})
    old_consumers = {item.fixture_id: item for item in previous.consumers}
    for consumer in nxt.consumers:
        old = old_consumers.get(consumer.fixture_id)
        if old is not None and (old.powered, old.passable, old.jammed) == (
            consumer.powered,
            consumer.passable,
            consumer.jammed,
        ):
            continue
        events.append({
            "type": "consumer-changed",
            "fixtureId": consumer.fixture_id,
            "consumerKind": consumer.kind,
            "channel": consumer.channel,
            "position": consumer.position.to_json(),
            "powered": consumer.powered,
            "passable": consumer.passable,
            "jammed": consumer.jammed,
        })


def transition(level: Level, input_snapshot: Snapshot, action: Direction) -> TransitionResult:
    """Resolve one cardinal action to a stable snapshot."""

    state = canonical_state(input_snapshot.state)
    before = Snapshot(state, derive(level, state), input_snapshot.outcome)
    player = state.player
    if before.outcome.kind != "playing" or player is None:
        return _blocked(before, action, "walk", "terminal", player or Coord(0, 0))

    adjacent = player.moved(action)
    pushed = object_at(state, adjacent)
    destination = adjacent
    if pushed is None:
        entry_kind, entry_reason = classify_player_entry(level, state, before.derived, adjacent)
        if entry_kind == "blocked":
            return _blocked(before, action, "walk", entry_reason or "unsupported-terrain", adjacent)
    else:
        destination = adjacent.moved(action)
        if object_at(state, destination) is not None:
            return _blocked(before, action, "push", "chain-push", destination)
        entry_kind, entry_reason = classify_object_entry(level, state, before.derived, destination, pushed.kind)
        if entry_kind == "blocked":
            return _blocked(before, action, "push", entry_reason or "unsupported-terrain", destination)

    moved_objects = tuple(
        replace(item, position=destination) if pushed is not None and item.id == pushed.id else item
        for item in state.objects
    )
    atomic = replace(state, player=adjacent, objects=moved_objects)
    next_state = atomic

    movements: list[tuple[GameObject | None, Coord, Coord]] = [(None, player, adjacent)]
    if pushed is not None:
        movements.append((pushed, adjacent, destination))
    # Player is ordered before every object by the production entity key.
    events: list[dict[str, Any]] = []
    for entity, origin, _ in movements:
        events.append({"type": "entity-exited", "entity": _entity_ref(entity), "position": origin.to_json()})
    events.append({"type": "player-moved", "from": player.to_json(), "to": adjacent.to_json()})
    if pushed is not None:
        events.append({
            "type": "object-pushed",
            "objectId": pushed.id,
            "objectKind": pushed.kind,
            "from": adjacent.to_json(),
            "to": destination.to_json(),
        })
    for entity, _, target in movements:
        events.append({"type": "entity-entered", "entity": _entity_ref(entity), "position": target.to_json()})

    physical_reason: str | None = None
    physical_position: Coord | None = None
    physical_fixture: str | None = None
    gate_fixture: Fixture | None = None
    gate_position: Coord | None = None

    for entity, _, target in movements:
        entered = level.fixture(target)
        if entity is None:
            if entered is not None and entered.kind == "relay":
                active = set(next_state.active_relay_ids)
                if entered.id in active:
                    active.remove(entered.id)
                else:
                    active.add(entered.id)
                next_state = replace(next_state, active_relay_ids=tuple(sorted(active)))
                events.append({
                    "type": "relay-toggled",
                    "fixtureId": entered.id,
                    "channel": entered.channel,
                    "position": target.to_json(),
                    "active": entered.id in active,
                })
            if entry_kind == "gate" and entered is not None and entered.kind == "gate":
                gate_fixture, gate_position = entered, target
                events.append({
                    "type": "gate-entered",
                    "fixtureId": entered.id,
                    "channel": entered.channel,
                    "position": target.to_json(),
                })
            elif entry_kind == "player-hazard":
                next_state = replace(next_state, player=None)
                physical_reason, physical_position = entry_reason, target
                if entered is not None and entered.kind == "bridge":
                    physical_fixture = entered.id
            continue

        if pushed is None or entity.id != pushed.id:
            continue
        moved = object_at(next_state, destination)
        if moved is None:
            continue
        if entry_kind == "dock" and entered is not None and entered.kind == "socket":
            next_state = without_object(next_state, moved.id, removed=False)
            next_state = replace(
                next_state,
                installed_cells=tuple(sorted(
                    (*next_state.installed_cells, InstalledCell(entered.id, moved.id)),
                    key=lambda item: (item.socket_id, item.object_id),
                )),
            )
            events.append({
                "type": "socket-docked",
                "fixtureId": entered.id,
                "channel": entered.channel,
                "objectId": moved.id,
                "position": target.to_json(),
            })
        elif entry_kind == "object-loss":
            next_state = without_object(next_state, moved.id, removed=True)
            event: dict[str, Any] = {
                "type": "object-removed",
                "objectId": moved.id,
                "objectKind": moved.kind,
                "position": target.to_json(),
                "reason": entry_reason,
            }
            if entered is not None and entered.kind in ("bridge", "disposal"):
                event["fixtureId"] = entered.id
            events.append(event)

    collapsed = list(next_state.collapsed_fractures)
    before_collapsed = set(state.collapsed_fractures)
    for index, cell in enumerate(level.cells):
        if cell.terrain != "fracture":
            continue
        position = level.coord(index)
        if position not in before_collapsed and occupied(state, position) and not occupied(atomic, position):
            collapsed.append(position)
            events.append({"type": "fracture-collapsed", "position": position.to_json()})
    next_state = replace(
        next_state,
        collapsed_fractures=tuple(sorted(set(collapsed), key=lambda p: (p.y, p.x))),
    )

    previous_derived = before.derived
    final_derived = previous_derived
    internal_passes = 0
    cascade_keys: set[str] = set()
    while True:
        internal_passes += 1
        if internal_passes > MAX_CASCADE_PASSES:
            raise RuntimeError(f"cascade exceeds {MAX_CASCADE_PASSES} passes")
        key = canonical_state_key(next_state)
        if key in cascade_keys:
            raise RuntimeError("cascade revisited a base state")
        cascade_keys.add(key)
        final_derived = derive(level, next_state)
        _append_derived_changes(previous_derived, final_derived, events)

        bridge_losses: list[tuple[GameObject, Fixture]] = []
        for item in next_state.objects:
            fixture = level.fixture(item.position)
            consumer = consumer_for(final_derived, fixture.id) if fixture is not None and fixture.kind == "bridge" else None
            if fixture is not None and fixture.kind == "bridge" and (consumer is None or not consumer.passable):
                bridge_losses.append((item, fixture))
        bridge_losses.sort(key=lambda value: value[0].id)
        player_loss: tuple[Coord, Fixture] | None = None
        if next_state.player is not None:
            fixture = level.fixture(next_state.player)
            consumer = consumer_for(final_derived, fixture.id) if fixture is not None and fixture.kind == "bridge" else None
            if fixture is not None and fixture.kind == "bridge" and (consumer is None or not consumer.passable):
                player_loss = (next_state.player, fixture)
        if not bridge_losses and player_loss is None:
            break
        for item, fixture in bridge_losses:
            next_state = without_object(next_state, item.id, removed=True)
            events.append({
                "type": "object-removed",
                "objectId": item.id,
                "objectKind": item.kind,
                "position": item.position.to_json(),
                "reason": "bridge-lost",
                "fixtureId": fixture.id,
            })
        if player_loss is not None:
            position, fixture = player_loss
            next_state = replace(next_state, player=None)
            physical_reason, physical_position, physical_fixture = "bridge-lost", position, fixture.id
        previous_derived = final_derived

    next_state = canonical_state(next_state)
    final_derived = derive(level, next_state)
    outcome = PLAYING
    if physical_reason is not None and physical_position is not None:
        outcome = Outcome("physical-failure", physical_reason, physical_position, physical_fixture)
        event = {"type": "physical-failure", "reason": physical_reason, "position": physical_position.to_json()}
        if physical_fixture is not None:
            event["fixtureId"] = physical_fixture
        events.append(event)
    elif gate_fixture is not None and gate_position is not None:
        outcome = Outcome("victory", position=gate_position, gate_id=gate_fixture.id)
        events.append({"type": "victory", "gateId": gate_fixture.id, "position": gate_position.to_json()})

    return TransitionResult(
        accepted=True,
        pushed=pushed is not None,
        action=action,
        before=before,
        after=Snapshot(next_state, final_derived, outcome),
        events=tuple(events),
        internal_passes=internal_passes,
    )


def replay(level: Level, actions: tuple[Direction, ...] | list[Direction]) -> tuple[Snapshot, tuple[TransitionResult, ...]]:
    current = initial_snapshot(level)
    results: list[TransitionResult] = []
    for action in actions:
        result = transition(level, current, action)
        results.append(result)
        if not result.accepted:
            break
        current = result.after
        if current.outcome.kind != "playing":
            break
    return current, tuple(results)
