"""Siatista-inspired terraced courtyards with a three-way power handoff.

The board is intentionally read as a small hillside settlement rather than a
warehouse: three pocket courtyards meet at an irregular central landing, while
two powered crossings behave like the narrow cuts between terraces.  The same
central cells are used by B, then C, then A, so challenge comes from ordering
shared circulation rather than from long hauling distances.
"""

from __future__ import annotations

from dataclasses import replace
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


FAMILY_ID = "greek-siatista"
PERSONA = "Greek Siatista UX developer"
TOPOLOGY = "terraced-courtyard-switchbacks"

CELL_A = "siatista-cell-a"
CARGO_B = "siatista-cargo-b"
CARGO_C = "siatista-cargo-c"

PLATE_A_ID = "siatista-a-plate"
BRIDGE_A_ID = "siatista-a-bridge"
PLATE_B_ID = "siatista-b-plate"
BRIDGE_B_ID = "siatista-b-bridge"
PLATE_C_ID = "siatista-c-plate"
DOOR_C_ID = "siatista-c-door"
SOCKET_A_ID = "siatista-a-socket"
GATE_ID = "siatista-gate"

ALPHA = "siatista-alpha"
BETA = "siatista-beta"
GAMMA = "siatista-gamma"
DELTA = "siatista-delta"

TEMP_A = Coord(4, 7)
PLATE_B = Coord(9, 8)
PLATE_C = Coord(4, 3)
SOCKET_A = Coord(8, 3)
FRONTIER_PLAYER = Coord(8, 4)

# Short, turning routes are part of the family contract.  C first traverses
# the central landing westward; A later reuses it in the opposite direction.
A_HOLD_ROUTE = (
    Coord(4, 9),
    Coord(4, 8),
    TEMP_A,
)
B_ROUTE = (
    Coord(7, 10),
    Coord(7, 9),
    Coord(7, 8),
    Coord(8, 8),
    PLATE_B,
)
C_ROUTE = (
    Coord(6, 5),
    Coord(5, 5),
    Coord(4, 5),
    Coord(3, 5),
    Coord(2, 5),
    Coord(2, 4),
    Coord(2, 3),
    Coord(3, 3),
    PLATE_C,
)
A_RETURN_ROUTE = (
    TEMP_A,
    Coord(3, 7),
    Coord(3, 6),
    Coord(3, 5),
    Coord(4, 5),
    Coord(5, 5),
    Coord(6, 5),
    Coord(6, 4),
    Coord(7, 4),
    FRONTIER_PLAYER,
)


def _event(
    identifier: str,
    family: str,
    event: str,
    *,
    occurrence: int = 1,
    co_emits: tuple[str, ...] = (),
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
    if guard is not None:
        spec["guard"] = guard
    if co_emits:
        spec["coEmitsWith"] = list(co_emits)
    return spec


def _milestones() -> tuple[dict[str, Any], ...]:
    a_group = ("a-hold", "a-source", "bridge-a-open")
    b_group = ("b-seat", "b-source", "bridge-b-open")
    c_group = ("c-seat", "c-source")
    return (
        _event(
            "a-hold",
            "pushing",
            "object-pushed",
            objectId=CELL_A,
            to=TEMP_A.to_json(),
            co_emits=tuple(item for item in a_group if item != "a-hold"),
        ),
        _event(
            "a-source",
            "momentary-circuit",
            "source-changed",
            fixtureId=PLATE_A_ID,
            active=True,
            co_emits=tuple(item for item in a_group if item != "a-source"),
        ),
        _event(
            "bridge-a-open",
            "consumers",
            "consumer-changed",
            fixtureId=BRIDGE_A_ID,
            powered=True,
            passable=True,
            co_emits=tuple(item for item in a_group if item != "bridge-a-open"),
        ),
        _event(
            "b-cross",
            "pushing",
            "object-pushed",
            objectId=CARGO_B,
            to=Coord(7, 8).to_json(),
        ),
        _event(
            "b-turn",
            "pushing",
            "object-pushed",
            objectId=CARGO_B,
            to=Coord(8, 8).to_json(),
        ),
        _event(
            "terrace-collapse",
            "irreversible-terrain",
            "fracture-collapsed",
            position=Coord(7, 9).to_json(),
        ),
        _event(
            "b-seat",
            "pushing",
            "object-pushed",
            objectId=CARGO_B,
            to=PLATE_B.to_json(),
            co_emits=tuple(item for item in b_group if item != "b-seat"),
        ),
        _event(
            "b-source",
            "momentary-circuit",
            "source-changed",
            fixtureId=PLATE_B_ID,
            active=True,
            co_emits=tuple(item for item in b_group if item != "b-source"),
            guard={
                "afterState": {
                    "entityAt": {"entityId": CARGO_B, "position": PLATE_B.to_json()}
                }
            },
        ),
        _event(
            "bridge-b-open",
            "consumers",
            "consumer-changed",
            fixtureId=BRIDGE_B_ID,
            powered=True,
            passable=True,
            co_emits=tuple(item for item in b_group if item != "bridge-b-open"),
        ),
        _event(
            "c-cross",
            "pushing",
            "object-pushed",
            objectId=CARGO_C,
            to=Coord(4, 5).to_json(),
        ),
        _event(
            "c-seat",
            "pushing",
            "object-pushed",
            objectId=CARGO_C,
            to=PLATE_C.to_json(),
            co_emits=("c-source",),
        ),
        _event(
            "c-source",
            "momentary-circuit",
            "source-changed",
            fixtureId=PLATE_C_ID,
            active=True,
            co_emits=("c-seat",),
            guard={
                "all": [
                    {
                        "afterState": {
                            "entityAt": {
                                "entityId": CARGO_C,
                                "position": PLATE_C.to_json(),
                            }
                        }
                    },
                    {
                        "afterState": {
                            "consumerState": {"fixtureId": DOOR_C_ID, "powered": True}
                        }
                    },
                ]
            },
        ),
        _event(
            "a-release",
            "pushing",
            "object-pushed",
            objectId=CELL_A,
            **{"from": TEMP_A.to_json(), "to": Coord(3, 7).to_json()},
        ),
        _event(
            "a-return",
            "pushing",
            "object-pushed",
            objectId=CELL_A,
            to=Coord(6, 5).to_json(),
        ),
        _event(
            "a-dock",
            "permanent-sources",
            "socket-docked",
            fixtureId=SOCKET_A_ID,
            objectId=CELL_A,
            position=SOCKET_A.to_json(),
        ),
        _event(
            "evacuate",
            "evacuation",
            "gate-entered",
            fixtureId=GATE_ID,
            position=Coord(9, 4).to_json(),
        ),
    )


def _precedence() -> tuple[dict[str, str], ...]:
    relations = (
        ("a-hold", "b-cross"),
        ("a-source", "b-cross"),
        ("bridge-a-open", "b-cross"),
        ("b-cross", "terrace-collapse"),
        ("terrace-collapse", "b-turn"),
        ("b-turn", "b-seat"),
        ("b-seat", "c-cross"),
        ("b-source", "c-cross"),
        ("bridge-b-open", "c-cross"),
        ("c-cross", "c-seat"),
        ("c-seat", "a-release"),
        ("c-source", "a-release"),
        ("a-release", "a-return"),
        ("a-return", "a-dock"),
        ("a-dock", "evacuate"),
    )
    return tuple({"before": before, "after": after} for before, after in relations)


def _build(_rng: Random) -> SolvedLayout:
    width, height = 11, 12
    cells = bulkhead_grid(width, height)

    # Route cells plus the small side pockets needed to turn around cargo.
    # Bulkheads remain the default, so both bridges are genuine topological
    # cuts rather than decoration in a large open room.
    floor: set[Coord] = {
        *A_HOLD_ROUTE,
        *B_ROUTE,
        *C_ROUTE,
        *A_RETURN_ROUTE,
        # A's compact uphill hold and its later westward regrip.  The player
        # begins at (4, 10), directly below A, so no dead setup stair is spent
        # merely lengthening the opening push run.
        Coord(3, 8), Coord(4, 10),
        # B's landing turn makes the hillside fracture a mandatory, separate
        # commitment between crossing the bridge and seating B.
        Coord(5, 10), Coord(6, 10), Coord(6, 11), Coord(7, 11),
        Coord(6, 8), Coord(6, 9),
        # B/A courtyard regrips; these are east of C's bridge cut.
        Coord(1, 3), Coord(1, 4), Coord(2, 5), Coord(2, 6), Coord(3, 4),
        Coord(3, 6), Coord(3, 7), Coord(5, 4), Coord(5, 6), Coord(5, 7),
        Coord(6, 6), Coord(7, 5), Coord(8, 5), Coord(8, 6), Coord(8, 7),
        # C crosses west and turns twice before committing to its plate.  A
        # later reverses the shared landing through the now-powered bridge.
        Coord(8, 4),
    }
    floor_cells(cells, width, floor)

    put(cells, width, TEMP_A, Cell("floor", Fixture(PLATE_A_ID, "plate", ALPHA)))
    put(cells, width, Coord(7, 9), Cell("fracture"))
    put(cells, width, Coord(7, 8), Cell("vacuum", Fixture(BRIDGE_A_ID, "bridge", ALPHA)))
    put(cells, width, PLATE_B, Cell("floor", Fixture(PLATE_B_ID, "plate", BETA)))
    put(cells, width, Coord(4, 5), Cell("vacuum", Fixture(BRIDGE_B_ID, "bridge", BETA)))
    put(cells, width, PLATE_C, Cell("floor", Fixture(PLATE_C_ID, "plate", GAMMA)))
    put(cells, width, Coord(3, 7), Cell("floor", Fixture(DOOR_C_ID, "door", GAMMA)))
    put(
        cells,
        width,
        SOCKET_A,
        Cell(
            "floor",
            Fixture(
                SOCKET_A_ID,
                "socket",
                DELTA,
                initially_installed=True,
                initial_cell_id=CELL_A,
            ),
        ),
    )
    put(cells, width, Coord(9, 4), Cell("floor", Fixture(GATE_ID, "gate", DELTA)))

    level = Level(
        "g4",
        width,
        height,
        (
            Channel(ALPHA, "A"),
            Channel(BETA, "B"),
            Channel(GAMMA, "C"),
            Channel(DELTA, "D"),
        ),
        tuple(cells),
        FRONTIER_PLAYER,
        (
            GameObject(CARGO_B, "cargo", PLATE_B),
            GameObject(CARGO_C, "cargo", PLATE_C),
        ),
    )
    # B has already left this shared stair in the solved frontier.  Recording
    # the collapse here lets the verified reverse plan restore it exactly;
    # the exported initial state is still the ordinary uncollapsed terrain.
    frontier = replace(initial_state(level), collapsed_fractures=(Coord(7, 9),))
    final = transition(level, Snapshot(frontier, derive(level, frontier), PLAYING), "E")
    if not final.accepted or final.after.outcome.kind != "victory":
        raise AssertionError("Siatista frontier is not one accepted move from victory")
    return SolvedLayout(
        level=level,
        frontier=frontier,
        gate_action="E",
        room_entry=FRONTIER_PLAYER,
        plates=(TEMP_A, PLATE_B, PLATE_C),
        relay_id=None,
        family_id=FAMILY_ID,
        persona=PERSONA,
        topology=TOPOLOGY,
        reverse_steps=(
            ReverseUndock(CELL_A, "N"),
            ReverseObjectRoute(CELL_A, A_RETURN_ROUTE),
            ReverseObjectRoute(CARGO_C, C_ROUTE),
            ReverseObjectRoute(CARGO_B, B_ROUTE),
            ReverseObjectRoute(CELL_A, A_HOLD_ROUTE),
        ),
        expected_start_positions=(
            (CELL_A, A_HOLD_ROUTE[0]),
            (CARGO_B, B_ROUTE[0]),
            (CARGO_C, C_ROUTE[0]),
        ),
        milestone_specs=_milestones(),
        required_precedence=_precedence(),
    )


FAMILY = LayoutFamily(
    id=FAMILY_ID,
    persona=PERSONA,
    target_difficulty=8,
    topology=TOPOLOGY,
    mechanic_motif="A-to-B-to-C-to-A terraced power handoff through shared courtyards",
    build=_build,
)
