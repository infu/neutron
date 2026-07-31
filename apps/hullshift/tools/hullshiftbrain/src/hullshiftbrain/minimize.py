"""Fixed-point interactive ablation hooks.

Geometry deletion requires an exact acceptance callback.  The default predicate
only removes elements unused by the constructive witness and therefore never
pretends to prove shortcut resistance.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Callable

from .rules import replay
from .schema import Cell, Direction, Level, assert_valid_level

Acceptance = Callable[[Level, tuple[Direction, ...]], bool]


@dataclass(frozen=True, slots=True)
class MinimizeResult:
    level: Level
    removed: tuple[str, ...]
    passes: int


def witness_acceptance(level: Level, witness: tuple[Direction, ...]) -> bool:
    try:
        assert_valid_level(level)
        final, results = replay(level, witness)
    except (ValueError, RuntimeError):
        return False
    return final.outcome.kind == "victory" and len(results) == len(witness) and all(item.accepted for item in results)


def minimize_level(
    level: Level,
    witness: tuple[Direction, ...],
    *,
    accept: Acceptance = witness_acceptance,
    simplify_geometry: bool = False,
) -> MinimizeResult:
    final, transitions = replay(level, witness)
    used_objects = {
        str(event["objectId"])
        for result in transitions
        for event in result.events
        if event["type"] in ("object-pushed", "object-removed", "socket-docked")
    }
    used_fixtures = {
        str(event["fixtureId"])
        for result in transitions
        for event in result.events
        if "fixtureId" in event
    }
    current = level
    removed: list[str] = []
    passes = 0
    while True:
        passes += 1
        changed = False
        for item in tuple(current.objects):
            if item.id in used_objects:
                continue
            proposal = replace(current, objects=tuple(candidate for candidate in current.objects if candidate.id != item.id))
            if accept(proposal, witness):
                current = proposal
                removed.append(f"object:{item.id}")
                changed = True
                break
        if changed:
            continue
        for index, cell in enumerate(current.cells):
            fixture = cell.fixture
            if fixture is None or fixture.kind == "gate" or fixture.id in used_fixtures:
                continue
            cells = list(current.cells)
            cells[index] = Cell(cell.terrain)
            proposal = replace(current, cells=tuple(cells))
            if accept(proposal, witness):
                current = proposal
                removed.append(f"fixture:{fixture.id}")
                changed = True
                break
        if changed:
            continue
        if simplify_geometry:
            for index, cell in enumerate(current.cells):
                position = current.coord(index)
                if cell.terrain != "bulkhead" or position.x in (0, current.width - 1) or position.y in (0, current.height - 1):
                    continue
                cells = list(current.cells)
                cells[index] = Cell("floor")
                proposal = replace(current, cells=tuple(cells))
                if accept(proposal, witness):
                    current = proposal
                    removed.append(f"wall:{position.x},{position.y}")
                    changed = True
                    break
        if not changed:
            break
    return MinimizeResult(current, tuple(removed), passes)

