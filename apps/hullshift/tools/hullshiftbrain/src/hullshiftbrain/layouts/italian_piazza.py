"""Italian piazza family: a compact A -> B -> A courtyard conversation.

The board reads as a small, asymmetric piazza with two portico loops.  Its
openness is visual rather than causal: both objects visit the shared square,
but the two doors make their visits strictly ordered.  The reactor first
powers cargo's south-portico route, cargo then opens the east loggia, and only
then can the reactor leave its temporary source and reach its permanent home.
"""

from __future__ import annotations

from random import Random
from typing import Any

from ..layout_family import (
    LayoutFamily,
    ReverseObjectRoute,
    ReverseUndock,
    SolvedLayout,
)
from ..rules import PLAYING, Snapshot, derive, initial_state, transition
from ..schema import Cell, Channel, Coord, Fixture, GameObject, Level
from .common import bulkhead_grid, floor_cells, put


FAMILY_ID = "italian-piazza"
PERSONA = "Italian UX designer"
TOPOLOGY = "asymmetric-piazza-ring"

REACTOR_ID = "piazza-reactor"
CARGO_ID = "portico-cargo"

ALPHA_PLATE = Coord(4, 2)
BETA_PLATE = Coord(8, 6)
SOCKET = Coord(7, 3)

REACTOR_START = Coord(4, 3)
CARGO_START = Coord(3, 5)

# The reactor begins staged immediately below its temporary north-niche source.
REACTOR_HOLD_ROUTE = (
    REACTOR_START,
    ALPHA_PLATE,
)

# Cargo describes the larger courtyard ring.  It turns through the piazza,
# crosses the alpha door at (6, 5), then commits to beta's terminal niche.
# The player may try this route early, but can back cargo out of the shared
# square through the west regrip bay instead of having to restart.
CARGO_RING_ROUTE = (
    CARGO_START,
    Coord(3, 4),
    Coord(4, 4),
    Coord(5, 4),
    Coord(6, 4),
    Coord(6, 5),
    Coord(6, 6),
    Coord(7, 6),
    BETA_PLATE,
)

# Second visit: release the temporary source, cross the piazza again, then
# use beta's east-loggia door.  The route ends immediately before docking;
# ReverseUndock owns the final northward socket action.
REACTOR_DOCK_ROUTE = (
    ALPHA_PLATE,
    Coord(4, 3),
    Coord(4, 4),
    Coord(5, 4),
    Coord(6, 4),
    Coord(7, 4),
)


def _event(
    identifier: str,
    family: str,
    event: str,
    *,
    occurrence: int = 1,
    co_emits_with: tuple[str, ...] = (),
    guard: dict[str, Any] | None = None,
    **trigger_fields: Any,
) -> dict[str, Any]:
    spec: dict[str, Any] = {
        "schemaVersion": "milestone-dsl-v1",
        "id": identifier,
        "family": family,
        "trigger": {"event": event, **trigger_fields},
        "occurrence": occurrence,
    }
    if co_emits_with:
        spec["coEmitsWith"] = list(co_emits_with)
    if guard is not None:
        spec["guard"] = guard
    return spec


def _milestones() -> tuple[dict[str, Any], ...]:
    alpha_group = ("a-alpha-hold", "alpha-source", "alpha-door-open")
    beta_group = ("b-beta-anchor", "beta-source", "beta-door-open")
    return (
        _event(
            "a-alpha-hold",
            "pushing",
            "object-pushed",
            objectId=REACTOR_ID,
            to=ALPHA_PLATE.to_json(),
            co_emits_with=tuple(item for item in alpha_group if item != "a-alpha-hold"),
        ),
        _event(
            "alpha-source",
            "momentary-circuit",
            "source-changed",
            fixtureId="alpha-plate",
            active=True,
            co_emits_with=tuple(item for item in alpha_group if item != "alpha-source"),
            guard={
                "all": [
                    {
                        "afterState": {
                            "entityAt": {
                                "entityId": REACTOR_ID,
                                "position": ALPHA_PLATE.to_json(),
                            }
                        }
                    },
                    {
                        "afterState": {
                            "consumerState": {
                                "fixtureId": "alpha-door",
                                "powered": True,
                                "passable": True,
                            }
                        }
                    },
                ]
            },
        ),
        _event(
            "alpha-door-open",
            "consumers",
            "consumer-changed",
            fixtureId="alpha-door",
            powered=True,
            passable=True,
            co_emits_with=tuple(item for item in alpha_group if item != "alpha-door-open"),
        ),
        _event(
            "b-piazza",
            "pushing",
            "object-pushed",
            objectId=CARGO_ID,
            to=Coord(4, 4).to_json(),
        ),
        _event(
            "b-alpha-cross",
            "pushing",
            "object-pushed",
            objectId=CARGO_ID,
            to=Coord(6, 5).to_json(),
            guard={
                "afterState": {
                    "consumerState": {
                        "fixtureId": "alpha-door",
                        "powered": True,
                        "passable": True,
                    }
                }
            },
        ),
        _event(
            "b-east-arcade",
            "pushing",
            "object-pushed",
            objectId=CARGO_ID,
            to=Coord(6, 4).to_json(),
        ),
        _event(
            "b-south-turn",
            "pushing",
            "object-pushed",
            objectId=CARGO_ID,
            to=Coord(6, 6).to_json(),
        ),
        _event(
            "b-beta-anchor",
            "pushing",
            "object-pushed",
            objectId=CARGO_ID,
            to=BETA_PLATE.to_json(),
            co_emits_with=tuple(item for item in beta_group if item != "b-beta-anchor"),
        ),
        _event(
            "beta-source",
            "momentary-circuit",
            "source-changed",
            fixtureId="beta-plate",
            active=True,
            co_emits_with=tuple(item for item in beta_group if item != "beta-source"),
            guard={
                "all": [
                    {
                        "afterState": {
                            "entityAt": {
                                "entityId": CARGO_ID,
                                "position": BETA_PLATE.to_json(),
                            }
                        }
                    },
                    {
                        "afterState": {
                            "consumerState": {
                                "fixtureId": "beta-door",
                                "powered": True,
                                "passable": True,
                            }
                        }
                    },
                ]
            },
        ),
        _event(
            "beta-door-open",
            "consumers",
            "consumer-changed",
            fixtureId="beta-door",
            powered=True,
            passable=True,
            co_emits_with=tuple(item for item in beta_group if item != "beta-door-open"),
        ),
        _event(
            "a-alpha-release",
            "pushing",
            "object-pushed",
            objectId=REACTOR_ID,
            **{"from": ALPHA_PLATE.to_json()},
        ),
        _event(
            "a-permanent-dock",
            "permanent-sources",
            "socket-docked",
            fixtureId="final-socket",
            objectId=REACTOR_ID,
            position=SOCKET.to_json(),
            guard={"afterState": {"channelActive": "final"}},
        ),
        _event(
            "evacuate",
            "evacuation",
            "gate-entered",
            fixtureId="piazza-gate",
            channel="final",
            position=Coord(8, 4).to_json(),
        ),
    )


def _precedence() -> tuple[dict[str, str], ...]:
    pairs = (
        ("a-alpha-hold", "b-alpha-cross"),
        ("alpha-source", "b-alpha-cross"),
        ("alpha-door-open", "b-alpha-cross"),
        ("b-piazza", "b-east-arcade"),
        ("b-east-arcade", "b-alpha-cross"),
        ("b-alpha-cross", "b-south-turn"),
        ("b-south-turn", "b-beta-anchor"),
        ("b-beta-anchor", "evacuate"),
        ("beta-source", "evacuate"),
        ("beta-door-open", "evacuate"),
        ("a-alpha-release", "a-permanent-dock"),
        ("a-permanent-dock", "evacuate"),
    )
    return tuple({"before": before, "after": after} for before, after in pairs)


def build(rng: Random) -> SolvedLayout:
    """Build the solved frontier; the shared executor proves its inverse plan."""

    del rng  # This family is one authored layout, not a cosmetic seed reskin.
    width, height = 10, 9
    cells = bulkhead_grid(width, height)

    # Twenty-nine floor cells form two offset portico loops around the
    # bulkhead fountain at (5, 2).  The missing arch at (4, 5) kills cargo's
    # straight shortcut, while the closed alpha door doubles as the stance
    # blocker that forces the reactor through beta on its return.
    west_portico = {
        Coord(2, 4), Coord(2, 5), Coord(2, 6),
        Coord(3, 3), Coord(3, 4), Coord(3, 5), Coord(3, 6),
        Coord(4, 1), Coord(4, 2), Coord(4, 3), Coord(4, 4),
    }
    piazza = {
        Coord(5, 3), Coord(5, 4), Coord(5, 5), Coord(5, 6),
        Coord(6, 3), Coord(6, 4), Coord(6, 5), Coord(6, 6),
        Coord(7, 3), Coord(7, 4), Coord(7, 5), Coord(7, 6),
        Coord(8, 4), Coord(8, 6),
    }
    north_portico = {
        Coord(5, 1), Coord(6, 1), Coord(7, 1), Coord(7, 2),
    }
    floor_cells(cells, width, west_portico | piazza | north_portico)

    put(cells, width, ALPHA_PLATE, Cell(
        "floor", Fixture("alpha-plate", "plate", "alpha")
    ))
    put(cells, width, Coord(6, 5), Cell(
        "floor", Fixture("alpha-door", "door", "alpha")
    ))
    put(cells, width, BETA_PLATE, Cell(
        "floor", Fixture("beta-plate", "plate", "beta")
    ))
    put(cells, width, Coord(7, 4), Cell(
        "floor", Fixture("beta-door", "door", "beta")
    ))
    put(cells, width, SOCKET, Cell(
        "floor",
        Fixture(
            "final-socket",
            "socket",
            "final",
            initially_installed=True,
            initial_cell_id=REACTOR_ID,
        ),
    ))
    put(cells, width, Coord(8, 4), Cell(
        "floor", Fixture("piazza-gate", "gate", "final")
    ))

    level = Level(
        "g4",
        width,
        height,
        (
            Channel("alpha", "A"),
            Channel("beta", "B"),
            Channel("final", "C"),
        ),
        tuple(cells),
        Coord(7, 4),
        (GameObject(CARGO_ID, "cargo", BETA_PLATE),),
    )
    frontier = initial_state(level)
    final = transition(level, Snapshot(frontier, derive(level, frontier), PLAYING), "E")
    if not final.accepted or final.after.outcome.kind != "victory":
        raise AssertionError("Italian piazza frontier is not one move from victory")
    return SolvedLayout(
        level=level,
        frontier=frontier,
        gate_action="E",
        room_entry=Coord(7, 4),
        plates=(ALPHA_PLATE, BETA_PLATE),
        relay_id=None,
        family_id=FAMILY_ID,
        persona=PERSONA,
        topology=TOPOLOGY,
        reverse_steps=(
            ReverseUndock(REACTOR_ID, "N"),
            ReverseObjectRoute(REACTOR_ID, REACTOR_DOCK_ROUTE),
            ReverseObjectRoute(CARGO_ID, CARGO_RING_ROUTE),
            ReverseObjectRoute(REACTOR_ID, REACTOR_HOLD_ROUTE),
        ),
        expected_start_positions=(
            (REACTOR_ID, REACTOR_START),
            (CARGO_ID, CARGO_START),
        ),
        milestone_specs=_milestones(),
        required_precedence=_precedence(),
    )


FAMILY = LayoutFamily(
    id=FAMILY_ID,
    persona=PERSONA,
    target_difficulty=4,
    topology=TOPOLOGY,
    mechanic_motif="temporary-source courtyard cycle into permanent docking",
    build=build,
)
