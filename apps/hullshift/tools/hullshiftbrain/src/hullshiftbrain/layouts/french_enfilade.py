"""Difficulty-five enfilade with a courtyard hold and service return.

The plan is intentionally small: two pieces, three circuits, and seven
fixtures.  The main east-west sightline is readable at once, while the return
route sits one room above it and only becomes useful after the east room has
been composed.  This gives the layout an architectural memory without turning
the puzzle into a long corridor or a walking exercise.
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


FAMILY_ID = "french-enfilade"
PERSONA = "French UX designer"
TOPOLOGY = "enfilade-with-service-return"

CELL = "cell-courtyard"
CARGO = "cargo-service"

COURTYARD_PLATE = Coord(2, 4)
CELL_START = Coord(3, 4)
SERVICE_START = Coord(8, 6)
SERVICE_EAST = Coord(9, 6)
SERVICE_NORTH = Coord(9, 5)
SERVICE_PLATE = Coord(8, 5)
CELL_TURN = Coord(3, 5)
CELL_SOCKET = Coord(3, 6)


def _event(
    identifier: str,
    family: str,
    event: str,
    **fields: Any,
) -> dict[str, Any]:
    return {
        "schemaVersion": "milestone-dsl-v1",
        "id": identifier,
        "family": family,
        "trigger": {"event": event, **fields},
        "occurrence": 1,
    }


def _milestones() -> tuple[dict[str, Any], ...]:
    hold_group = ("a-hold", "courtyard-source", "gallery-bridge-open")
    return_group = (
        "b-return",
        "service-source",
        "return-door-open",
        "stance-door-open",
    )

    a_hold = _event(
        "a-hold",
        "pushing",
        "object-pushed",
        objectId=CELL,
        to=COURTYARD_PLATE.to_json(),
    )
    a_hold["coEmitsWith"] = sorted(set(hold_group) - {"a-hold"})

    courtyard_source = _event(
        "courtyard-source",
        "momentary-circuit",
        "source-changed",
        fixtureId="plate-courtyard",
        active=True,
    )
    courtyard_source["guard"] = {
        "afterState": {
            "entityAt": {
                "entityId": CELL,
                "position": COURTYARD_PLATE.to_json(),
            }
        }
    }
    courtyard_source["coEmitsWith"] = sorted(
        set(hold_group) - {"courtyard-source"}
    )

    bridge_open = _event(
        "gallery-bridge-open",
        "consumers",
        "consumer-changed",
        fixtureId="bridge-gallery",
        powered=True,
    )
    bridge_open["coEmitsWith"] = sorted(
        set(hold_group) - {"gallery-bridge-open"}
    )

    b_return = _event(
        "b-return",
        "pushing",
        "object-pushed",
        objectId=CARGO,
        to=SERVICE_PLATE.to_json(),
    )
    b_return["coEmitsWith"] = sorted(set(return_group) - {"b-return"})

    service_source = _event(
        "service-source",
        "momentary-circuit",
        "source-changed",
        fixtureId="plate-service",
        active=True,
    )
    service_source["guard"] = {
        "all": [
            {
                "afterState": {
                    "entityAt": {
                        "entityId": CARGO,
                        "position": SERVICE_PLATE.to_json(),
                    }
                }
            },
            {
                "afterState": {
                    "consumerState": {
                        "fixtureId": "door-return",
                        "powered": True,
                    }
                }
            },
            {
                "afterState": {
                    "consumerState": {
                        "fixtureId": "door-stance",
                        "powered": True,
                    }
                }
            },
        ]
    }
    service_source["coEmitsWith"] = sorted(
        set(return_group) - {"service-source"}
    )

    return_door = _event(
        "return-door-open",
        "consumers",
        "consumer-changed",
        fixtureId="door-return",
        powered=True,
    )
    return_door["coEmitsWith"] = sorted(
        set(return_group) - {"return-door-open"}
    )

    stance_door = _event(
        "stance-door-open",
        "consumers",
        "consumer-changed",
        fixtureId="door-stance",
        powered=True,
    )
    stance_door["coEmitsWith"] = sorted(
        set(return_group) - {"stance-door-open"}
    )

    return (
        a_hold,
        courtyard_source,
        bridge_open,
        _event(
            "b-east",
            "pushing",
            "object-pushed",
            objectId=CARGO,
            to=SERVICE_EAST.to_json(),
        ),
        _event(
            "b-north",
            "pushing",
            "object-pushed",
            objectId=CARGO,
            to=SERVICE_NORTH.to_json(),
        ),
        b_return,
        service_source,
        return_door,
        stance_door,
        _event(
            "a-release",
            "pushing",
            "object-pushed",
            objectId=CELL,
            **{
                "from": COURTYARD_PLATE.to_json(),
                "to": CELL_START.to_json(),
            },
        ),
        _event(
            "a-turn-south",
            "pushing",
            "object-pushed",
            objectId=CELL,
            to=CELL_TURN.to_json(),
        ),
        _event(
            "a-final",
            "permanent-sources",
            "socket-docked",
            fixtureId="socket-escape",
            objectId=CELL,
            position=CELL_SOCKET.to_json(),
        ),
        _event(
            "evacuate",
            "evacuation",
            "gate-entered",
            fixtureId="gate-escape",
        ),
    )


PRECEDENCE = (
    {"before": "a-hold", "after": "b-east"},
    {"before": "courtyard-source", "after": "b-east"},
    {"before": "gallery-bridge-open", "after": "b-east"},
    {"before": "b-east", "after": "b-north"},
    {"before": "b-north", "after": "b-return"},
    {"before": "b-return", "after": "a-release"},
    {"before": "service-source", "after": "a-release"},
    {"before": "return-door-open", "after": "a-release"},
    {"before": "stance-door-open", "after": "a-release"},
    {"before": "a-release", "after": "a-turn-south"},
    {"before": "a-turn-south", "after": "a-final"},
    {"before": "a-final", "after": "evacuate"},
)


def _build(_rng: Random) -> SolvedLayout:
    width, height = 12, 9
    cells = bulkhead_grid(width, height)

    # Three aligned rooms at y=4, an upper service return, a compact eastern
    # regrip court, and only the two cells needed to approach the final gate.
    floor_cells(
        cells,
        width,
        (
            *(Coord(x, 4) for x in range(1, 8)),
            *(Coord(x, 2) for x in range(1, 8)),
            Coord(1, 3),
            Coord(3, 3),
            Coord(7, 3),
            Coord(7, 5),
            Coord(7, 6),
            Coord(8, 5),
            Coord(8, 6),
            Coord(9, 5),
            Coord(9, 6),
            Coord(9, 7),
            Coord(10, 5),
            Coord(10, 6),
            Coord(10, 7),
            Coord(3, 5),
            Coord(3, 6),
            Coord(4, 5),
            Coord(4, 6),
            Coord(5, 6),
        ),
    )

    put(
        cells,
        width,
        COURTYARD_PLATE,
        Cell("floor", Fixture("plate-courtyard", "plate", "court")),
    )
    put(
        cells,
        width,
        Coord(6, 4),
        Cell("vacuum", Fixture("bridge-gallery", "bridge", "court")),
    )
    put(
        cells,
        width,
        SERVICE_PLATE,
        Cell("floor", Fixture("plate-service", "plate", "service")),
    )
    put(
        cells,
        width,
        Coord(4, 2),
        Cell("floor", Fixture("door-return", "door", "service")),
    )
    put(
        cells,
        width,
        Coord(3, 3),
        Cell("floor", Fixture("door-stance", "door", "service")),
    )
    put(
        cells,
        width,
        CELL_SOCKET,
        Cell(
            "floor",
            Fixture(
                "socket-escape",
                "socket",
                "escape",
                initially_installed=True,
                initial_cell_id=CELL,
            ),
        ),
    )
    put(
        cells,
        width,
        Coord(5, 6),
        Cell("floor", Fixture("gate-escape", "gate", "escape")),
    )

    level = Level(
        "g4",
        width,
        height,
        (
            Channel("court", "A"),
            Channel("service", "B"),
            Channel("escape", "C"),
        ),
        tuple(cells),
        Coord(4, 6),
        (GameObject(CARGO, "cargo", SERVICE_PLATE),),
    )
    frontier = solved_frontier(level, "E")
    layout = SolvedLayout(
        level=level,
        frontier=frontier,
        gate_action="E",
        room_entry=Coord(3, 5),
        plates=(COURTYARD_PLATE, SERVICE_PLATE),
        relay_id=None,
        family_id=FAMILY_ID,
        persona=PERSONA,
        topology=TOPOLOGY,
        reverse_steps=(
            ReverseUndock(CELL, "S"),
            ReverseObjectRoute(
                CELL,
                (COURTYARD_PLATE, CELL_START, CELL_TURN),
            ),
            ReverseObjectRoute(
                CARGO,
                (SERVICE_START, SERVICE_EAST, SERVICE_NORTH, SERVICE_PLATE),
            ),
            ReverseObjectRoute(CELL, (CELL_START, COURTYARD_PLATE)),
        ),
        expected_start_positions=(
            (CELL, CELL_START),
            (CARGO, SERVICE_START),
        ),
        milestone_specs=_milestones(),
        required_precedence=PRECEDENCE,
    )
    validate_family_layout(FAMILY, layout)
    return layout


FAMILY = LayoutFamily(
    id=FAMILY_ID,
    persona=PERSONA,
    target_difficulty=5,
    topology=TOPOLOGY,
    mechanic_motif="courtyard-hold+prepared-service-return+socket-turn",
    build=_build,
)
