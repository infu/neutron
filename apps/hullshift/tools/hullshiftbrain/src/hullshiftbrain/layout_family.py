"""Contracts for independently developed HullshiftBrain layout families.

Layout families own geometry and their causal contract.  The shared search
engine owns verified inverse execution and production certification.  Keeping
those responsibilities separate prevents a new family from smuggling another
copy of the old warehouse scaffold into the catalog.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
from random import Random
from typing import Any, Callable, TypeAlias

from .schema import Coord, Direction, Level, PuzzleState


@dataclass(frozen=True, slots=True)
class ReverseObjectRoute:
    """Undo one forward object route, whose coordinates include both ends."""

    object_id: str
    forward_path: tuple[Coord, ...]


@dataclass(frozen=True, slots=True)
class ReverseUndock:
    """Reconstruct a movable object from a permanently installed socket."""

    object_id: str
    forward_action: Direction


@dataclass(frozen=True, slots=True)
class ReversePlayerMove:
    """Undo an exact player move, including any relay toggle caused by entry."""

    predecessor_player: Coord


ReverseStep: TypeAlias = ReverseObjectRoute | ReverseUndock | ReversePlayerMove


@dataclass(frozen=True, slots=True)
class SolvedLayout:
    level: Level
    frontier: PuzzleState
    gate_action: Direction
    room_entry: Coord
    plates: tuple[Coord, ...]
    relay_id: str | None
    # Retained for the legacy family during migration; new families use the
    # id-addressed expected_start_positions contract below.
    causal_start_positions: tuple[Coord, ...] | None = None
    family_id: str = "legacy"
    persona: str = "legacy"
    topology: str = "legacy"
    reverse_steps: tuple[ReverseStep, ...] = ()
    expected_start_positions: tuple[tuple[str, Coord], ...] = ()
    milestone_specs: tuple[dict[str, Any], ...] = ()
    required_precedence: tuple[dict[str, str], ...] = ()


LayoutBuilder: TypeAlias = Callable[[Random], SolvedLayout]


@dataclass(frozen=True, slots=True)
class LayoutFamily:
    id: str
    persona: str
    target_difficulty: int
    topology: str
    mechanic_motif: str
    build: LayoutBuilder


def validate_family_layout(family: LayoutFamily, layout: SolvedLayout) -> None:
    """Fail early on malformed family metadata before inverse search begins."""

    if not 0 <= family.target_difficulty <= 8:
        raise ValueError(f"layout family {family.id} has invalid target difficulty")
    if layout.family_id != family.id:
        raise ValueError(f"layout family id {layout.family_id!r} does not match {family.id!r}")
    if layout.persona != family.persona:
        raise ValueError(f"layout persona does not match family {family.id}")
    if layout.topology != family.topology:
        raise ValueError(f"layout topology does not match family {family.id}")
    if not layout.reverse_steps:
        raise ValueError(f"layout family {family.id} has no verified reverse plan")
    playable_cells = sum(cell.terrain != "bulkhead" for cell in layout.level.cells)
    maximum_cells = (160, 160, 160, 30, 34, 38, 40, 42, 44)[family.target_difficulty]
    if playable_cells > maximum_cells:
        raise ValueError(
            f"layout family {family.id} uses {playable_cells} playable cells; "
            f"difficulty {family.target_difficulty} permits at most {maximum_cells}"
        )
    if len(layout.expected_start_positions) > 3:
        raise ValueError(f"layout family {family.id} uses more than three movable objects")
    if not 1 <= len(layout.milestone_specs) <= 16:
        raise ValueError(f"layout family {family.id} must declare 1..16 milestones")
    milestone_ids = [str(spec.get("id", "")) for spec in layout.milestone_specs]
    if any(not identifier for identifier in milestone_ids) or len(set(milestone_ids)) != len(milestone_ids):
        raise ValueError(f"layout family {family.id} has invalid or duplicate milestone ids")
    known = set(milestone_ids)
    if not layout.required_precedence:
        raise ValueError(f"layout family {family.id} has no required causal edges")
    for relation in layout.required_precedence:
        if set(relation) != {"before", "after"}:
            raise ValueError(f"layout family {family.id} has malformed precedence")
        if relation["before"] not in known or relation["after"] not in known:
            raise ValueError(f"layout family {family.id} precedence references an unknown milestone")
        if relation["before"] == relation["after"]:
            raise ValueError(f"layout family {family.id} precedence contains a self edge")
    declared_depth = _precedence_depth(milestone_ids, layout.required_precedence)
    minimum_depth = (1, 2, 3, 4, 4, 6, 7, 8, 8)[family.target_difficulty]
    if declared_depth < minimum_depth:
        raise ValueError(
            f"layout family {family.id} declares dependency depth {declared_depth}; "
            f"difficulty {family.target_difficulty} requires at least {minimum_depth}"
        )
    mechanic_families = {str(spec.get("family", "")) for spec in layout.milestone_specs}
    minimum_families = (1, 1, 1, 2, 2, 3, 3, 4, 4)[family.target_difficulty]
    if "" in mechanic_families or len(mechanic_families) < minimum_families:
        raise ValueError(
            f"layout family {family.id} declares {len(mechanic_families - {''})} mechanic families; "
            f"difficulty {family.target_difficulty} requires at least {minimum_families}"
        )
    expected_ids = [object_id for object_id, _ in layout.expected_start_positions]
    if len(expected_ids) != len(set(expected_ids)):
        raise ValueError(f"layout family {family.id} repeats an expected object id")
    expected_cells = [position for _, position in layout.expected_start_positions]
    if len(expected_cells) != len(set(expected_cells)):
        raise ValueError(f"layout family {family.id} overlaps expected object starts")
    milestone_text = json.dumps(layout.milestone_specs, sort_keys=True, separators=(",", ":"))
    referenced_elements = {
        *(object_id for object_id, _ in layout.expected_start_positions),
        *(
            cell.fixture.id
            for cell in layout.level.cells
            if cell.fixture is not None
        ),
    }
    for element_id in sorted(referenced_elements):
        if f'"{element_id}"' not in milestone_text:
            raise ValueError(
                f"layout family {family.id} leaves element {element_id!r} outside its milestone contract"
            )
    object_phase_ids: list[str] = []
    route_turns = 0
    planned_pushes = sum(
        len(step.forward_path) - 1
        if isinstance(step, ReverseObjectRoute)
        else 1 if isinstance(step, ReverseUndock) else 0
        for step in layout.reverse_steps
    )
    maximum_pushes = (32, 32, 32, 12, 20, 20, 24, 27, 30)[family.target_difficulty]
    if planned_pushes > maximum_pushes:
        raise ValueError(
            f"layout family {family.id} plans {planned_pushes} pushes; "
            f"difficulty {family.target_difficulty} permits at most {maximum_pushes}"
        )
    for step in layout.reverse_steps:
        if not isinstance(step, ReverseObjectRoute):
            continue
        object_phase_ids.append(step.object_id)
        if len(step.forward_path) < 2:
            raise ValueError(f"layout family {family.id} has a route shorter than one push")
        previous_direction: tuple[int, int] | None = None
        straight_run = 0
        for left, right in zip(step.forward_path, step.forward_path[1:]):
            if abs(left.x - right.x) + abs(left.y - right.y) != 1:
                raise ValueError(f"layout family {family.id} has a non-cardinal object route")
            direction = (right.x - left.x, right.y - left.y)
            if direction == previous_direction:
                straight_run += 1
            else:
                if previous_direction is not None:
                    route_turns += 1
                straight_run = 1
                previous_direction = direction
            if straight_run > 4:
                raise ValueError(
                    f"layout family {family.id} uses more than four consecutive straight pushes"
                )
    if family.target_difficulty >= 3:
        if len(set(object_phase_ids)) < 2:
            raise ValueError(f"layout family {family.id} needs at least two interacting objects")
        if not any(object_phase_ids.count(object_id) >= 2 for object_id in set(object_phase_ids)):
            raise ValueError(f"layout family {family.id} has no object reused across separated phases")
        if route_turns < 3:
            raise ValueError(f"layout family {family.id} has too few forced route turns")


def _precedence_depth(
    milestone_ids: list[str],
    relations: tuple[dict[str, str], ...],
) -> int:
    outgoing = {identifier: [] for identifier in milestone_ids}
    for relation in relations:
        outgoing[relation["before"]].append(relation["after"])
    visiting: set[str] = set()
    memo: dict[str, int] = {}

    def visit(identifier: str) -> int:
        if identifier in visiting:
            raise ValueError("layout precedence graph is cyclic")
        if identifier in memo:
            return memo[identifier]
        visiting.add(identifier)
        depth = 1 + max((visit(target) for target in outgoing[identifier]), default=0)
        visiting.remove(identifier)
        memo[identifier] = depth
        return depth

    return max(visit(identifier) for identifier in milestone_ids)
