"""Canonical keys and hashes compatible with ``src/simulation.ts``."""

from __future__ import annotations

import hashlib
import json
from typing import Any

from .schema import Fixture, Level, PuzzleState, canonical_state


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def canonical_state_value(state: PuzzleState) -> list[Any]:
    value = canonical_state(state)
    return [
        "hullshift-state",
        1,
        None if value.player is None else [value.player.x, value.player.y],
        [[item.id, item.kind, item.position.x, item.position.y] for item in value.objects],
        list(value.active_relay_ids),
        [[item.socket_id, item.object_id] for item in value.installed_cells],
        [[item.x, item.y] for item in value.collapsed_fractures],
        list(value.removed_object_ids),
    ]


def canonical_state_key(state: PuzzleState) -> str:
    return _json(canonical_state_value(state))


def canonical_state_hash(state: PuzzleState) -> str:
    return hashlib.sha256(canonical_state_key(state).encode("utf-8")).hexdigest()


def canonical_fixture_value(fixture: Fixture) -> list[Any]:
    if fixture.kind in ("plate", "door", "bridge", "gate"):
        return [fixture.kind, fixture.id, fixture.channel]
    if fixture.kind == "relay":
        return [fixture.kind, fixture.id, fixture.channel, 1 if fixture.initial_on else 0]
    if fixture.kind == "socket":
        return [
            fixture.kind,
            fixture.id,
            fixture.channel,
            1 if fixture.initially_installed else 0,
            fixture.initial_cell_id,
        ]
    return [fixture.kind, fixture.id]


def canonical_level_value(level: Level) -> list[Any]:
    channels = [[item.id, item.symbol] for item in sorted(level.channels, key=lambda item: item.id)]
    objects = [
        [item.id, item.kind, item.position.x, item.position.y]
        for item in sorted(level.objects, key=lambda item: item.id)
    ]
    cells = [
        [cell.terrain, None if cell.fixture is None else canonical_fixture_value(cell.fixture)]
        for cell in level.cells
    ]
    return [
        "hullshift-level",
        1,
        level.generator_version,
        level.width,
        level.height,
        channels,
        cells,
        [level.player_start.x, level.player_start.y],
        objects,
    ]


def canonical_level_key(level: Level) -> str:
    return _json(canonical_level_value(level))


def canonical_level_hash(level: Level) -> str:
    return hashlib.sha256(canonical_level_key(level).encode("utf-8")).hexdigest()


def topology_signature(level: Level) -> str:
    """ID-insensitive topology digest used for diversity niches."""

    fixture_kinds = [None if cell.fixture is None else cell.fixture.kind for cell in level.cells]
    value = [level.width, level.height, [cell.terrain for cell in level.cells], fixture_kinds]
    return hashlib.sha256(_json(value).encode()).hexdigest()[:20]


def canonical_shape_signature(level: Level) -> str:
    """Fingerprint playable geometry modulo padding and square symmetries.

    ``topology_signature`` deliberately preserves the authored orientation and
    canvas.  The layout registry needs a stricter anti-reskin check: translating
    a board inside a larger bulkhead frame, reflecting it, or rotating it must
    not manufacture a second family.  IDs and channel names remain irrelevant,
    while terrain and fixture *kinds* stay significant.
    """

    occupied: list[tuple[int, int, str, str | None]] = []
    for index, cell in enumerate(level.cells):
        if cell.terrain == "bulkhead" and cell.fixture is None:
            continue
        coord = level.coord(index)
        occupied.append((
            coord.x,
            coord.y,
            cell.terrain,
            None if cell.fixture is None else cell.fixture.kind,
        ))
    if not occupied:
        return hashlib.sha256(b"empty-layout-shape").hexdigest()[:20]

    # The eight transformations of the square (four rotations and their
    # reflections).  Normalizing minima afterwards also removes translation.
    transforms = (
        lambda x, y: (x, y),
        lambda x, y: (-y, x),
        lambda x, y: (-x, -y),
        lambda x, y: (y, -x),
        lambda x, y: (-x, y),
        lambda x, y: (y, x),
        lambda x, y: (x, -y),
        lambda x, y: (-y, -x),
    )
    encodings: list[str] = []
    for transform in transforms:
        transformed = [
            (*transform(x, y), terrain, fixture_kind)
            for x, y, terrain, fixture_kind in occupied
        ]
        minimum_x = min(item[0] for item in transformed)
        minimum_y = min(item[1] for item in transformed)
        normalized = sorted(
            (
                x - minimum_x,
                y - minimum_y,
                terrain,
                fixture_kind,
            )
            for x, y, terrain, fixture_kind in transformed
        )
        width = 1 + max(item[0] for item in normalized)
        height = 1 + max(item[1] for item in normalized)
        encodings.append(_json([width, height, normalized]))
    return hashlib.sha256(min(encodings).encode()).hexdigest()[:20]


def semantic_signature(level: Level) -> str:
    """Stable gameplay digest; release certification may add symmetry folding."""

    return canonical_level_hash(level)[:20]
