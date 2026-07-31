"""Frozen Python representation of ``src/model.ts``.

The generator intentionally uses small immutable records.  Conversion at the
JSON boundary keeps the app's camelCase field names, while the Python code uses
snake_case.  Validation mirrors the production bounds closely enough to reject
bad proposals early; TypeScript remains the release authority.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any, Iterable, Literal, Mapping, Sequence

Direction = Literal["N", "E", "S", "W"]
TerrainKind = Literal["floor", "bulkhead", "vacuum", "fracture"]
ObjectKind = Literal["cargo", "reactor-cell"]
FixtureKind = Literal["plate", "relay", "socket", "door", "bridge", "disposal", "gate"]

DIRECTIONS: tuple[Direction, ...] = ("N", "E", "S", "W")
DIRECTION_DELTAS: dict[Direction, tuple[int, int]] = {
    "N": (0, -1),
    "E": (1, 0),
    "S": (0, 1),
    "W": (-1, 0),
}
OPPOSITE: dict[Direction, Direction] = {"N": "S", "E": "W", "S": "N", "W": "E"}
TERRAINS = frozenset(("floor", "bulkhead", "vacuum", "fracture"))
OBJECT_KINDS = frozenset(("cargo", "reactor-cell"))
FIXTURE_KINDS = frozenset(("plate", "relay", "socket", "door", "bridge", "disposal", "gate"))

MIN_WIDTH = 7
MIN_HEIGHT = 7
MAX_WIDTH = 16
MAX_HEIGHT = 16
MAX_NON_BULKHEAD_CELLS = 160
MAX_OBJECTS = 8
MAX_CHANNELS = 4
MAX_FIXTURES = 24
MAX_CASCADE_PASSES = 32


@dataclass(frozen=True, order=True, slots=True)
class Coord:
    x: int
    y: int

    def moved(self, direction: Direction) -> Coord:
        dx, dy = DIRECTION_DELTAS[direction]
        return Coord(self.x + dx, self.y + dy)

    def plus(self, dx: int, dy: int) -> Coord:
        return Coord(self.x + dx, self.y + dy)

    def to_json(self) -> dict[str, int]:
        return {"x": self.x, "y": self.y}

    @classmethod
    def from_json(cls, value: Mapping[str, Any]) -> Coord:
        return cls(int(value["x"]), int(value["y"]))


@dataclass(frozen=True, slots=True)
class Channel:
    id: str
    symbol: str

    def to_json(self) -> dict[str, str]:
        return {"id": self.id, "symbol": self.symbol}

    @classmethod
    def from_json(cls, value: Mapping[str, Any]) -> Channel:
        return cls(str(value["id"]), str(value["symbol"]))


@dataclass(frozen=True, slots=True)
class Fixture:
    id: str
    kind: FixtureKind
    channel: str | None = None
    initial_on: bool | None = None
    initially_installed: bool | None = None
    initial_cell_id: str | None = None

    def to_json(self) -> dict[str, Any]:
        value: dict[str, Any] = {"id": self.id, "kind": self.kind}
        if self.kind != "disposal":
            value["channel"] = self.channel
        if self.kind == "relay":
            value["initialOn"] = self.initial_on
        if self.kind == "socket":
            value["initiallyInstalled"] = self.initially_installed
            if self.initial_cell_id is not None:
                value["initialCellId"] = self.initial_cell_id
        return value

    @classmethod
    def from_json(cls, value: Mapping[str, Any]) -> Fixture:
        kind = str(value["kind"])
        return cls(
            id=str(value["id"]),
            kind=kind,  # type: ignore[arg-type]
            channel=None if kind == "disposal" else str(value.get("channel", "")),
            initial_on=bool(value.get("initialOn")) if kind == "relay" else None,
            initially_installed=bool(value.get("initiallyInstalled")) if kind == "socket" else None,
            initial_cell_id=(str(value["initialCellId"]) if "initialCellId" in value else None),
        )


@dataclass(frozen=True, slots=True)
class Cell:
    terrain: TerrainKind
    fixture: Fixture | None = None

    def to_json(self) -> dict[str, Any]:
        result: dict[str, Any] = {"terrain": self.terrain}
        if self.fixture is not None:
            result["fixture"] = self.fixture.to_json()
        return result

    @classmethod
    def from_json(cls, value: Mapping[str, Any]) -> Cell:
        fixture = value.get("fixture")
        return cls(
            str(value["terrain"]),  # type: ignore[arg-type]
            Fixture.from_json(fixture) if isinstance(fixture, Mapping) else None,
        )


@dataclass(frozen=True, slots=True)
class GameObject:
    id: str
    kind: ObjectKind
    position: Coord

    def to_json(self) -> dict[str, Any]:
        return {"id": self.id, "kind": self.kind, "position": self.position.to_json()}

    @classmethod
    def from_json(cls, value: Mapping[str, Any]) -> GameObject:
        return cls(
            str(value["id"]),
            str(value["kind"]),  # type: ignore[arg-type]
            Coord.from_json(value["position"]),
        )


@dataclass(frozen=True, slots=True)
class InstalledCell:
    socket_id: str
    object_id: str


@dataclass(frozen=True, slots=True)
class PuzzleState:
    player: Coord | None
    objects: tuple[GameObject, ...]
    active_relay_ids: tuple[str, ...] = ()
    installed_cells: tuple[InstalledCell, ...] = ()
    collapsed_fractures: tuple[Coord, ...] = ()
    removed_object_ids: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class Level:
    generator_version: str
    width: int
    height: int
    channels: tuple[Channel, ...]
    cells: tuple[Cell, ...]
    player_start: Coord
    objects: tuple[GameObject, ...]

    def inside(self, position: Coord) -> bool:
        return 0 <= position.x < self.width and 0 <= position.y < self.height

    def index(self, position: Coord) -> int:
        return position.y * self.width + position.x if self.inside(position) else -1

    def coord(self, index: int) -> Coord:
        return Coord(index % self.width, index // self.width)

    def cell(self, position: Coord) -> Cell | None:
        index = self.index(position)
        return self.cells[index] if 0 <= index < len(self.cells) else None

    def fixture(self, position: Coord) -> Fixture | None:
        cell = self.cell(position)
        return None if cell is None else cell.fixture

    def with_start(self, state: PuzzleState) -> Level:
        if state.player is None:
            raise ValueError("an initial state must contain the player")
        if state.collapsed_fractures or state.removed_object_ids:
            raise ValueError("collapsed fractures and removed objects are not encodable initially")
        active_relays = set(state.active_relay_ids)
        installed = {entry.socket_id: entry.object_id for entry in state.installed_cells}
        cells: list[Cell] = []
        for cell in self.cells:
            fixture = cell.fixture
            if fixture is not None and fixture.kind == "relay":
                fixture = replace(fixture, initial_on=fixture.id in active_relays)
            elif fixture is not None and fixture.kind == "socket":
                object_id = installed.get(fixture.id)
                fixture = replace(
                    fixture,
                    initially_installed=object_id is not None,
                    initial_cell_id=object_id,
                )
            cells.append(Cell(cell.terrain, fixture))
        return replace(
            self,
            cells=tuple(cells),
            player_start=state.player,
            objects=tuple(sorted(state.objects, key=lambda item: item.id)),
        )

    def to_json(self) -> dict[str, Any]:
        return {
            "generatorVersion": self.generator_version,
            "width": self.width,
            "height": self.height,
            "channels": [channel.to_json() for channel in self.channels],
            "cells": [cell.to_json() for cell in self.cells],
            "playerStart": self.player_start.to_json(),
            "objects": [item.to_json() for item in self.objects],
        }

    @classmethod
    def from_json(cls, value: Mapping[str, Any]) -> Level:
        return cls(
            generator_version=str(value["generatorVersion"]),
            width=int(value["width"]),
            height=int(value["height"]),
            channels=tuple(Channel.from_json(item) for item in value["channels"]),
            cells=tuple(Cell.from_json(item) for item in value["cells"]),
            player_start=Coord.from_json(value["playerStart"]),
            objects=tuple(GameObject.from_json(item) for item in value["objects"]),
        )


def level_from_json(value: Mapping[str, Any]) -> Level:
    return Level.from_json(value)


def level_to_json(level: Level) -> dict[str, Any]:
    return level.to_json()


def state_to_json(state: PuzzleState) -> dict[str, Any]:
    state = canonical_state(state)
    return {
        "player": None if state.player is None else state.player.to_json(),
        "objects": [item.to_json() for item in state.objects],
        "activeRelayIds": list(state.active_relay_ids),
        "installedCells": [
            {"socketId": item.socket_id, "objectId": item.object_id}
            for item in state.installed_cells
        ],
        "collapsedFractures": [item.to_json() for item in state.collapsed_fractures],
        "removedObjectIds": list(state.removed_object_ids),
    }


def state_from_json(value: Mapping[str, Any]) -> PuzzleState:
    player = value.get("player")
    return canonical_state(PuzzleState(
        player=Coord.from_json(player) if isinstance(player, Mapping) else None,
        objects=tuple(GameObject.from_json(item) for item in value.get("objects", ())),
        active_relay_ids=tuple(str(item) for item in value.get("activeRelayIds", ())),
        installed_cells=tuple(
            InstalledCell(str(item["socketId"]), str(item["objectId"]))
            for item in value.get("installedCells", ())
        ),
        collapsed_fractures=tuple(
            Coord.from_json(item) for item in value.get("collapsedFractures", ())
        ),
        removed_object_ids=tuple(str(item) for item in value.get("removedObjectIds", ())),
    ))


FIXTURE_TERRAINS: dict[str, frozenset[str]] = {
    "plate": frozenset(("floor",)),
    "relay": frozenset(("floor",)),
    "socket": frozenset(("floor",)),
    "door": frozenset(("floor",)),
    "bridge": frozenset(("vacuum",)),
    "disposal": frozenset(("floor",)),
    "gate": frozenset(("floor",)),
}


def fixtures(level: Level) -> Iterable[tuple[Coord, Fixture]]:
    for index, cell in enumerate(level.cells):
        if cell.fixture is not None:
            yield level.coord(index), cell.fixture


def validate_level(level: Level) -> tuple[str, ...]:
    """Return deterministic, human-readable proposal validation failures."""

    issues: list[str] = []
    if not level.generator_version:
        issues.append("generator-version")
    if not (MIN_WIDTH <= level.width <= MAX_WIDTH and MIN_HEIGHT <= level.height <= MAX_HEIGHT):
        issues.append("board-size")
    if len(level.cells) != level.width * level.height:
        issues.append("cell-count")
    if len(level.channels) > MAX_CHANNELS:
        issues.append("channel-limit")
    if len(level.objects) > MAX_OBJECTS:
        issues.append("object-limit")

    channel_ids = [channel.id for channel in level.channels]
    symbols = [channel.symbol for channel in level.channels]
    if any(not value for value in channel_ids) or len(set(channel_ids)) != len(channel_ids):
        issues.append("channel-id")
    if any(not value for value in symbols) or len(set(symbols)) != len(symbols):
        issues.append("channel-symbol")

    entity_ids: set[str] = set()
    occupied: set[Coord] = set()
    for item in level.objects:
        if not item.id or item.id in entity_ids:
            issues.append("object-id")
        entity_ids.add(item.id)
        if item.kind not in OBJECT_KINDS:
            issues.append("object-kind")
        if not level.inside(item.position):
            issues.append("object-position")
        elif item.position in occupied:
            issues.append("overlapping-objects")
        occupied.add(item.position)
    if not level.inside(level.player_start):
        issues.append("player-position")
    elif level.player_start in occupied:
        issues.append("player-overlap")

    gate_count = 0
    fixture_count = 0
    non_bulkhead = 0
    for index, cell in enumerate(level.cells[: max(0, level.width * level.height)]):
        position = level.coord(index)
        if cell.terrain not in TERRAINS:
            issues.append("terrain-kind")
            continue
        if cell.terrain != "bulkhead":
            non_bulkhead += 1
        fixture = cell.fixture
        if fixture is None:
            continue
        fixture_count += 1
        gate_count += fixture.kind == "gate"
        if fixture.kind not in FIXTURE_KINDS:
            issues.append("fixture-kind")
            continue
        if not fixture.id or fixture.id in entity_ids:
            issues.append("fixture-id")
        entity_ids.add(fixture.id)
        if cell.terrain not in FIXTURE_TERRAINS[fixture.kind]:
            issues.append("fixture-terrain")
        if fixture.kind != "disposal" and fixture.channel not in set(channel_ids):
            issues.append("fixture-channel")
        if fixture.kind == "relay" and fixture.initial_on is None:
            issues.append("relay-initial")
        if fixture.kind == "socket":
            if fixture.initially_installed is None:
                issues.append("socket-initial")
            if not fixture.initially_installed and fixture.initial_cell_id is not None:
                issues.append("socket-cell-id")
            if fixture.initially_installed:
                installed_id = fixture.initial_cell_id or f"installed:{fixture.id}"
                if installed_id in entity_ids:
                    issues.append("duplicate-id")
                entity_ids.add(installed_id)

    if non_bulkhead > MAX_NON_BULKHEAD_CELLS:
        issues.append("cell-limit")
    if fixture_count > MAX_FIXTURES:
        issues.append("fixture-limit")
    if gate_count != 1:
        issues.append("gate-count")

    # Import lazily to avoid a schema/rules import cycle.
    if not issues:
        from .rules import initial_snapshot, object_at, classify_object_entry, classify_player_entry

        snapshot = initial_snapshot(level, validate=False)
        assert snapshot.state.player is not None
        assessment = classify_player_entry(level, snapshot.state, snapshot.derived, snapshot.state.player)
        fixture = level.fixture(snapshot.state.player)
        if assessment[0] != "stable" or (fixture is not None and fixture.kind == "gate"):
            issues.append("initial-player")
        for item in snapshot.state.objects:
            assessment = classify_object_entry(level, snapshot.state, snapshot.derived, item.position, item.kind)
            fixture = level.fixture(item.position)
            resting_socket = assessment[0] == "dock" and fixture is not None and fixture.kind == "socket"
            if assessment[0] != "stable" and not resting_socket:
                issues.append(f"initial-object:{item.id}")
        if object_at(snapshot.state, snapshot.state.player) is not None:
            issues.append("player-overlap")
    return tuple(issues)


def assert_valid_level(level: Level) -> None:
    issues = validate_level(level)
    if issues:
        raise ValueError("invalid Hullshift level: " + ", ".join(issues))


def canonical_state(state: PuzzleState) -> PuzzleState:
    return PuzzleState(
        player=state.player,
        objects=tuple(sorted(state.objects, key=lambda item: item.id)),
        active_relay_ids=tuple(sorted(set(state.active_relay_ids))),
        installed_cells=tuple(sorted(state.installed_cells, key=lambda item: (item.socket_id, item.object_id))),
        collapsed_fractures=tuple(sorted(set(state.collapsed_fractures), key=lambda p: (p.y, p.x))),
        removed_object_ids=tuple(sorted(set(state.removed_object_ids))),
    )


def replace_object(state: PuzzleState, object_id: str, position: Coord) -> PuzzleState:
    return replace(
        state,
        objects=tuple(
            replace(item, position=position) if item.id == object_id else item
            for item in state.objects
        ),
    )


def without_object(state: PuzzleState, object_id: str, *, removed: bool) -> PuzzleState:
    ids = set(state.removed_object_ids)
    if removed:
        ids.add(object_id)
    return replace(
        state,
        objects=tuple(item for item in state.objects if item.id != object_id),
        removed_object_ids=tuple(sorted(ids)),
    )


def with_objects(state: PuzzleState, objects: Sequence[GameObject]) -> PuzzleState:
    return replace(state, objects=tuple(sorted(objects, key=lambda item: item.id)))
