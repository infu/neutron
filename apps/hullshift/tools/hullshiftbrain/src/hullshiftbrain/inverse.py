"""Verified predecessor proposal operators.

An inverse operator never mutates the game rules.  It proposes a predecessor,
replays the ordinary forward transition, and retains the edge only when the
result is byte-for-byte the requested successor state.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Iterable, Literal

from .canonical import canonical_state_key
from .rules import PLAYING, Snapshot, snapshot, transition
from .schema import (
    DIRECTIONS,
    Coord,
    Direction,
    GameObject,
    Level,
    PuzzleState,
    InstalledCell,
    canonical_state,
)

InverseKind = Literal["walk", "push", "dock", "loss"]


@dataclass(frozen=True, slots=True)
class InverseEdge:
    predecessor: PuzzleState
    successor: PuzzleState
    action: Direction
    kind: InverseKind
    object_id: str | None = None


def _toggle_relay_entered(level: Level, state: PuzzleState, entered: Coord) -> PuzzleState:
    fixture = level.fixture(entered)
    if fixture is None or fixture.kind != "relay":
        return state
    active = set(state.active_relay_ids)
    if fixture.id in active:
        active.remove(fixture.id)
    else:
        active.add(fixture.id)
    return replace(state, active_relay_ids=tuple(sorted(active)))


def _restore_departed_fracture(level: Level, state: PuzzleState, origin: Coord) -> PuzzleState:
    cell = level.cell(origin)
    if cell is None or cell.terrain != "fracture" or origin not in state.collapsed_fractures:
        return state
    return replace(
        state,
        collapsed_fractures=tuple(item for item in state.collapsed_fractures if item != origin),
    )


def _verify(
    level: Level,
    successor: PuzzleState,
    predecessor: PuzzleState,
    action: Direction,
    kind: InverseKind,
    object_id: str | None = None,
) -> InverseEdge | None:
    predecessor = canonical_state(predecessor)
    if predecessor.player is None:
        return None
    # States constructed backward must themselves be stable playing states.
    before = snapshot(level, predecessor, PLAYING)
    result = transition(level, before, action)
    if not result.accepted or result.after.outcome.kind != "playing":
        return None
    if canonical_state_key(result.after.state) != canonical_state_key(successor):
        return None
    return InverseEdge(predecessor, canonical_state(successor), action, kind, object_id)


def walk_predecessors(level: Level, successor: PuzzleState) -> tuple[InverseEdge, ...]:
    if successor.player is None:
        return ()
    result: list[InverseEdge] = []
    for action in DIRECTIONS:
        origin = successor.player.moved(_opposite(action))
        if not level.inside(origin):
            continue
        if any(item.position == origin for item in successor.objects):
            continue
        predecessor = replace(successor, player=origin)
        predecessor = _toggle_relay_entered(level, predecessor, successor.player)
        predecessor = _restore_departed_fracture(level, predecessor, origin)
        edge = _verify(level, successor, predecessor, action, "walk")
        if edge is not None:
            result.append(edge)
    return tuple(result)


def push_predecessors(level: Level, successor: PuzzleState) -> tuple[InverseEdge, ...]:
    player = successor.player
    if player is None:
        return ()
    result: list[InverseEdge] = []
    for action in DIRECTIONS:
        object_position = player.moved(action)
        moved = next((item for item in successor.objects if item.position == object_position), None)
        if moved is None:
            continue
        origin = player.moved(_opposite(action))
        if not level.inside(origin) or any(item.position == origin for item in successor.objects):
            continue
        objects = tuple(
            replace(item, position=player) if item.id == moved.id else item
            for item in successor.objects
        )
        predecessor = replace(successor, player=origin, objects=objects)
        predecessor = _toggle_relay_entered(level, predecessor, player)
        predecessor = _restore_departed_fracture(level, predecessor, origin)
        edge = _verify(level, successor, predecessor, action, "push", moved.id)
        if edge is not None:
            result.append(edge)
    return tuple(result)


def dock_predecessors(level: Level, successor: PuzzleState) -> tuple[InverseEdge, ...]:
    player = successor.player
    if player is None:
        return ()
    by_socket = {item.socket_id: item for item in successor.installed_cells}
    result: list[InverseEdge] = []
    for action in DIRECTIONS:
        socket_position = player.moved(action)
        fixture = level.fixture(socket_position)
        installed = by_socket.get(fixture.id) if fixture is not None and fixture.kind == "socket" else None
        if installed is None:
            continue
        origin = player.moved(_opposite(action))
        if not level.inside(origin) or any(item.position in (origin, player) for item in successor.objects):
            continue
        predecessor = replace(
            successor,
            player=origin,
            objects=(*successor.objects, GameObject(installed.object_id, "reactor-cell", player)),
            installed_cells=tuple(item for item in successor.installed_cells if item != installed),
        )
        predecessor = _toggle_relay_entered(level, predecessor, player)
        predecessor = _restore_departed_fracture(level, predecessor, origin)
        edge = _verify(level, successor, predecessor, action, "dock", installed.object_id)
        if edge is not None:
            result.append(edge)
    return tuple(result)


def loss_predecessors(level: Level, successor: PuzzleState) -> tuple[InverseEdge, ...]:
    """Restore a single directly pushed loss; simultaneous losses verify out."""

    player = successor.player
    if player is None:
        return ()
    original = {item.id: item.kind for item in level.objects}
    result: list[InverseEdge] = []
    for object_id in successor.removed_object_ids:
        kind = original.get(object_id)
        if kind is None:
            continue
        for action in DIRECTIONS:
            destination = player.moved(action)
            origin = player.moved(_opposite(action))
            if not level.inside(origin) or not level.inside(destination):
                continue
            if any(item.position in (origin, player) for item in successor.objects):
                continue
            predecessor = replace(
                successor,
                player=origin,
                objects=(*successor.objects, GameObject(object_id, kind, player)),
                removed_object_ids=tuple(item for item in successor.removed_object_ids if item != object_id),
            )
            predecessor = _toggle_relay_entered(level, predecessor, player)
            predecessor = _restore_departed_fracture(level, predecessor, origin)
            edge = _verify(level, successor, predecessor, action, "loss", object_id)
            if edge is not None:
                result.append(edge)
    return tuple(result)


def predecessors(
    level: Level,
    successor: PuzzleState,
    kinds: Iterable[InverseKind] = ("walk", "push", "dock", "loss"),
) -> tuple[InverseEdge, ...]:
    selected = set(kinds)
    result: list[InverseEdge] = []
    if "walk" in selected:
        result.extend(walk_predecessors(level, successor))
    if "push" in selected:
        result.extend(push_predecessors(level, successor))
    if "dock" in selected:
        result.extend(dock_predecessors(level, successor))
    if "loss" in selected:
        result.extend(loss_predecessors(level, successor))
    result.sort(key=lambda edge: (DIRECTIONS.index(edge.action), edge.kind, edge.object_id or "", canonical_state_key(edge.predecessor)))
    return tuple(result)


def predecessor_with_player(
    level: Level,
    successor: PuzzleState,
    desired_player: Coord,
) -> InverseEdge | None:
    return next((edge for edge in walk_predecessors(level, successor) if edge.predecessor.player == desired_player), None)


def pull_predecessor(
    level: Level,
    successor: PuzzleState,
    object_id: str,
    move_dx: int,
    move_dy: int,
) -> InverseEdge | None:
    """Move an object by ``(dx,dy)`` in reverse time, if exactly invertible."""

    moved = next((item for item in successor.objects if item.id == object_id), None)
    if moved is None or successor.player != moved.position.plus(move_dx, move_dy):
        return None
    return next(
        (
            edge
            for edge in push_predecessors(level, successor)
            if edge.object_id == object_id
            and next(item for item in edge.predecessor.objects if item.id == object_id).position
            == moved.position.plus(move_dx, move_dy)
        ),
        None,
    )


def _opposite(direction: Direction) -> Direction:
    return {"N": "S", "E": "W", "S": "N", "W": "E"}[direction]
