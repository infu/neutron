"""US freight-exchange cloverleaf with a remembered crossover state.

The board reads as four short interchange lobes around one powered freight
crossover, not as a warehouse floor.  The reactor first holds the crossover
open for the freight pallet, the pallet follows a forced turning ramp onto its
dispatch plate, and the reactor is then reclaimed and irreversibly docked.

The empty socket is visible from the opening position and can be filled early,
but doing so permanently drops the crossover before freight has reached the
dispatch plate.  That deliberately tempting commitment is therefore absent
from every winning line: the compact puzzle is about door memory and order,
not walking distance.
"""

from __future__ import annotations

from random import Random
from typing import Any

from ..layout_family import (
    LayoutFamily,
    ReverseObjectRoute,
    ReverseUndock,
    SolvedLayout,
    validate_family_layout,
)
from ..schema import Cell, Channel, Coord, Fixture, GameObject, Level
from .common import bulkhead_grid, floor_cells, put, solved_frontier


FAMILY_ID = "us-freight-exchange"
PERSONA = "US UX designer"
TOPOLOGY = "freight-cloverleaf-door-memory"

CELL = "exchange-reactor"
FREIGHT = "exchange-freight"

PLATE_HOLD = "exchange-hold-plate"
BRIDGE_CROSSOVER = "exchange-crossover"
PLATE_DISPATCH = "exchange-dispatch-plate"
DOOR_MEMORY = "exchange-memory-door"
SOCKET_EXIT = "exchange-exit-socket"
GATE_EXIT = "exchange-exit-gate"

HOLD = "exchange-hold"
DISPATCH = "exchange-dispatch"
EXIT = "exchange-exit"

REACTOR_START = Coord(3, 4)
HOLD_PLATE = Coord(2, 4)
SOCKET = Coord(4, 4)

FREIGHT_START = Coord(4, 6)
CROSSOVER = Coord(5, 6)
FREIGHT_EAST = Coord(6, 6)
FREIGHT_NORTH = Coord(6, 5)
FREIGHT_TURN = Coord(5, 5)
DISPATCH_PLATE = Coord(5, 4)

FREIGHT_ROUTE = (
    FREIGHT_START,
    CROSSOVER,
    FREIGHT_EAST,
    FREIGHT_NORTH,
    FREIGHT_TURN,
    DISPATCH_PLATE,
)


def _event(
    identifier: str,
    family: str,
    event: str,
    *,
    co_emits: tuple[str, ...] = (),
    guard: dict[str, Any] | None = None,
    **trigger_fields: Any,
) -> dict[str, Any]:
    spec: dict[str, Any] = {
        "schemaVersion": "milestone-dsl-v1",
        "id": identifier,
        "family": family,
        "trigger": {"event": event, **trigger_fields},
        "occurrence": 1,
    }
    if guard is not None:
        spec["guard"] = guard
    if co_emits:
        spec["coEmitsWith"] = list(co_emits)
    return spec


def _milestones() -> tuple[dict[str, Any], ...]:
    hold_group = ("a-stage", "hold-source", "crossover-open")
    dispatch_group = ("b-seat", "dispatch-source", "memory-door-open")
    return (
        _event(
            "a-stage",
            "pushing",
            "object-pushed",
            objectId=CELL,
            to=HOLD_PLATE.to_json(),
            co_emits=tuple(item for item in hold_group if item != "a-stage"),
        ),
        _event(
            "hold-source",
            "momentary-circuit",
            "source-changed",
            fixtureId=PLATE_HOLD,
            active=True,
            guard={
                "afterState": {
                    "entityAt": {
                        "entityId": CELL,
                        "position": HOLD_PLATE.to_json(),
                    }
                }
            },
            co_emits=tuple(item for item in hold_group if item != "hold-source"),
        ),
        _event(
            "crossover-open",
            "consumers",
            "consumer-changed",
            fixtureId=BRIDGE_CROSSOVER,
            powered=True,
            passable=True,
            co_emits=tuple(item for item in hold_group if item != "crossover-open"),
        ),
        _event(
            "b-cross",
            "pushing",
            "object-pushed",
            objectId=FREIGHT,
            to=CROSSOVER.to_json(),
        ),
        _event(
            "b-seat",
            "pushing",
            "object-pushed",
            objectId=FREIGHT,
            to=DISPATCH_PLATE.to_json(),
            co_emits=tuple(item for item in dispatch_group if item != "b-seat"),
        ),
        _event(
            "dispatch-source",
            "momentary-circuit",
            "source-changed",
            fixtureId=PLATE_DISPATCH,
            active=True,
            guard={
                "all": [
                    {
                        "afterState": {
                            "entityAt": {
                                "entityId": FREIGHT,
                                "position": DISPATCH_PLATE.to_json(),
                            }
                        }
                    },
                    {
                        "afterState": {
                            "consumerState": {
                                "fixtureId": DOOR_MEMORY,
                                "powered": True,
                            }
                        }
                    },
                ]
            },
            co_emits=tuple(item for item in dispatch_group if item != "dispatch-source"),
        ),
        _event(
            "memory-door-open",
            "consumers",
            "consumer-changed",
            fixtureId=DOOR_MEMORY,
            powered=True,
            co_emits=tuple(item for item in dispatch_group if item != "memory-door-open"),
        ),
        _event(
            "a-dock",
            "permanent-sources",
            "socket-docked",
            fixtureId=SOCKET_EXIT,
            objectId=CELL,
            position=SOCKET.to_json(),
            co_emits=("exit-source",),
        ),
        _event(
            "exit-source",
            "permanent-sources",
            "source-changed",
            fixtureId=SOCKET_EXIT,
            active=True,
            co_emits=("a-dock",),
        ),
        _event(
            "evacuate",
            "evacuation",
            "gate-entered",
            fixtureId=GATE_EXIT,
        ),
    )


PRECEDENCE = (
    # The five-node spine is the interaction model shown to the certifier.
    {"before": "a-stage", "after": "b-cross"},
    {"before": "hold-source", "after": "b-cross"},
    {"before": "crossover-open", "after": "b-cross"},
    {"before": "b-cross", "after": "b-seat"},
    {"before": "b-seat", "after": "a-dock"},
    {"before": "dispatch-source", "after": "a-dock"},
    {"before": "memory-door-open", "after": "a-dock"},
    {"before": "a-dock", "after": "evacuate"},
)


def _build(_rng: Random) -> SolvedLayout:
    width, height = 11, 9
    cells = bulkhead_grid(width, height)

    # Four irregular lobes meet at the reactor/socket pair.  The single gap at
    # (6, 4) is intentional: freight must reverse through the north lobe before
    # it can approach the dispatch plate from below.
    floor_cells(
        cells,
        width,
        (
            # West release loop and gated exit spur.
            Coord(1, 3), Coord(2, 3), Coord(3, 3), Coord(4, 3), Coord(5, 3),
            Coord(1, 4), HOLD_PLATE, REACTOR_START, SOCKET,
            # Short connector into the freight lobe.
            Coord(3, 5), Coord(3, 6), FREIGHT_START,
            # Powered crossover and forced E/E/N/W/N freight ramp.
            CROSSOVER, FREIGHT_EAST, FREIGHT_NORTH,
            FREIGHT_TURN, DISPATCH_PLATE,
            # Three tiny regrip bays, never a general walking room.
            Coord(5, 7), Coord(6, 7), Coord(7, 6), Coord(7, 5),
        ),
    )

    put(
        cells,
        width,
        HOLD_PLATE,
        Cell("floor", Fixture(PLATE_HOLD, "plate", HOLD)),
    )
    put(
        cells,
        width,
        CROSSOVER,
        Cell("vacuum", Fixture(BRIDGE_CROSSOVER, "bridge", HOLD)),
    )
    put(
        cells,
        width,
        DISPATCH_PLATE,
        Cell("floor", Fixture(PLATE_DISPATCH, "plate", DISPATCH)),
    )
    put(
        cells,
        width,
        Coord(4, 3),
        Cell("floor", Fixture(DOOR_MEMORY, "door", DISPATCH)),
    )
    put(
        cells,
        width,
        SOCKET,
        Cell(
            "floor",
            Fixture(
                SOCKET_EXIT,
                "socket",
                EXIT,
                initially_installed=True,
                initial_cell_id=CELL,
            ),
        ),
    )
    put(
        cells,
        width,
        Coord(5, 3),
        Cell("floor", Fixture(GATE_EXIT, "gate", EXIT)),
    )

    level = Level(
        "g4",
        width,
        height,
        (
            Channel(HOLD, "A"),
            Channel(DISPATCH, "B"),
            Channel(EXIT, "C"),
        ),
        tuple(cells),
        Coord(4, 3),
        (GameObject(FREIGHT, "cargo", DISPATCH_PLATE),),
    )
    frontier = solved_frontier(level, "E")
    layout = SolvedLayout(
        level=level,
        frontier=frontier,
        gate_action="E",
        room_entry=REACTOR_START,
        plates=(HOLD_PLATE, DISPATCH_PLATE),
        relay_id=None,
        family_id=FAMILY_ID,
        persona=PERSONA,
        topology=TOPOLOGY,
        reverse_steps=(
            ReverseUndock(CELL, "E"),
            ReverseObjectRoute(CELL, (HOLD_PLATE, REACTOR_START)),
            ReverseObjectRoute(FREIGHT, FREIGHT_ROUTE),
            ReverseObjectRoute(CELL, (REACTOR_START, HOLD_PLATE)),
        ),
        expected_start_positions=(
            (CELL, REACTOR_START),
            (FREIGHT, FREIGHT_START),
        ),
        milestone_specs=_milestones(),
        required_precedence=PRECEDENCE,
    )
    validate_family_layout(FAMILY, layout)
    return layout


FAMILY = LayoutFamily(
    id=FAMILY_ID,
    persona=PERSONA,
    target_difficulty=3,
    topology=TOPOLOGY,
    mechanic_motif="freight crossover hold+dispatch memory+premature socket trap",
    build=_build,
)
