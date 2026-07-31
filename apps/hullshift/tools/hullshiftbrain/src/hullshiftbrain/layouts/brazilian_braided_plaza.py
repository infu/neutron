"""Difficulty-seven Brazilian plaza built from two interlocked arcades.

The reactor is the shared civic resource.  It first rests on the west mosaic
to open B's arcade.  Seating B latches that arcade, letting the reactor leave
the mosaic and climb to the east one.  The same handoff then repeats for C.
Only C's latched circuit keeps the final arcade open after the reactor leaves
the east mosaic, so the permanent dock proves the full A -> B -> A -> C -> A
recurrence rather than merely checking two independent errands.

The footprint is a narrow, offset braid rather than an open warehouse.  Each
cargo changes direction at every few pushes, the reactor revisits the shared
plaza, and visible side arcades support recoverable regrips.  Difficulty comes
from preserving the two circuit handoffs, not from long straight hauling.
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


FAMILY_ID = "brazilian-braided-plaza"
PERSONA = "Brazilian UX designer"
TOPOLOGY = "braided-plaza-branch-join"

REACTOR = "plaza-cell"
EAST_CARGO = "plaza-cargo-b"
WEST_CARGO = "plaza-cargo-c"

WEST_MOSAIC = "plaza-west-plate"
EAST_MOSAIC = "plaza-east-plate"
EAST_CROSSING = "plaza-east-bridge"
WEST_CROSSING = "plaza-west-bridge"
EAST_ARCADE_SEAL = "plaza-east-seal"
EAST_OBLIGATION = "plaza-b-plate"
WEST_OBLIGATION = "plaza-c-plate"
EAST_RECOVERY = "plaza-c-return"
FINAL_SOCKET = "plaza-socket"
EXIT_GATE = "plaza-gate"

B_LINE = "b-line"
C_LINE = "c-line"
EXIT_CHANNEL = "exit"

REACTOR_START = Coord(6, 5)
WEST_MOSAIC_POSITION = Coord(5, 5)
EAST_MOSAIC_POSITION = Coord(8, 4)

EAST_CARGO_START = Coord(10, 5)
EAST_CARGO_ROUTE = (
    EAST_CARGO_START,
    Coord(11, 5),
    Coord(11, 4),
    Coord(11, 3),
)

WEST_CARGO_START = Coord(2, 5)
WEST_CARGO_ROUTE = (
    WEST_CARGO_START,
    Coord(1, 5),
    Coord(1, 4),
    Coord(1, 3),
    Coord(1, 2),
    Coord(1, 1),
)

FINAL_SOCKET_POSITION = Coord(6, 2)
FRONTIER_PLAYER = Coord(6, 3)


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
    if co_emits:
        spec["coEmitsWith"] = list(co_emits)
    if guard is not None:
        spec["guard"] = guard
    return spec


def _entity_guard(entity_id: str, position: Coord) -> dict[str, Any]:
    return {
        "afterState": {
            "entityAt": {
                "entityId": entity_id,
                "position": position.to_json(),
            }
        }
    }


def _milestones() -> tuple[dict[str, Any], ...]:
    west_activation = ("a-west-mosaic", "b-bridge-open")
    return (
        _event(
            "a-west-mosaic",
            "momentary-circuit",
            "source-changed",
            fixtureId=WEST_MOSAIC,
            active=True,
            guard={
                "all": [
                    _entity_guard(REACTOR, WEST_MOSAIC_POSITION),
                    {
                        "afterState": {
                            "consumerState": {
                                "fixtureId": EAST_CROSSING,
                                "powered": True,
                                "passable": True,
                            }
                        }
                    },
                ]
            },
            co_emits=("b-bridge-open",),
        ),
        _event(
            "b-bridge-open",
            "consumers",
            "consumer-changed",
            fixtureId=EAST_CROSSING,
            powered=True,
            passable=True,
            co_emits=("a-west-mosaic", "b-seat", "b-source"),
        ),
        _event(
            "b-seat",
            "pushing",
            "object-pushed",
            objectId=EAST_CARGO,
            to=Coord(11, 3).to_json(),
            co_emits=("b-source", "b-bridge-open"),
        ),
        _event(
            "b-source",
            "momentary-circuit",
            "source-changed",
            fixtureId=EAST_OBLIGATION,
            active=True,
            guard=_entity_guard(EAST_CARGO, Coord(11, 3)),
            co_emits=("b-seat", "b-bridge-open"),
        ),
        _event(
            "a-east-mosaic",
            "momentary-circuit",
            "source-changed",
            fixtureId=EAST_MOSAIC,
            active=True,
            guard={
                "all": [
                    _entity_guard(REACTOR, EAST_MOSAIC_POSITION),
                    {
                        "afterState": {
                            "consumerState": {
                                "fixtureId": WEST_CROSSING,
                                "powered": True,
                                "passable": True,
                            }
                        }
                    },
                    {
                        "afterState": {
                            "consumerState": {
                                "fixtureId": EAST_ARCADE_SEAL,
                                "powered": True,
                                "passable": True,
                            }
                        }
                    },
                ]
            },
        ),
        _event(
            "c-seat",
            "momentary-circuit",
            "source-changed",
            fixtureId=WEST_OBLIGATION,
            active=True,
            guard=_entity_guard(WEST_CARGO, Coord(1, 1)),
        ),
        _event(
            "c-recovery-open",
            "pushing",
            "object-pushed",
            objectId=REACTOR,
            **{"from": Coord(6, 4).to_json(), "to": FRONTIER_PLAYER.to_json()},
            guard={
                "all": [
                    _entity_guard(WEST_CARGO, Coord(1, 1)),
                    {
                        "afterState": {
                            "consumerState": {
                                "fixtureId": EAST_RECOVERY,
                                "powered": True,
                                "passable": True,
                            }
                        }
                    },
                ]
            },
            co_emits=("a-turn-north",),
        ),
        _event(
            "a-final-join",
            "pushing",
            "object-pushed",
            objectId=REACTOR,
            **{"from": Coord(7, 4).to_json(), "to": Coord(6, 4).to_json()},
            guard={"afterState": {"channelActive": C_LINE}},
        ),
        _event(
            "a-turn-north",
            "pushing",
            "object-pushed",
            objectId=REACTOR,
            **{"from": Coord(6, 4).to_json(), "to": FRONTIER_PLAYER.to_json()},
            co_emits=("c-recovery-open",),
        ),
        _event(
            "a-permanent-dock",
            "permanent-sources",
            "socket-docked",
            fixtureId=FINAL_SOCKET,
            objectId=REACTOR,
            position=FINAL_SOCKET_POSITION.to_json(),
        ),
        _event(
            "evacuate",
            "evacuation",
            "gate-entered",
            fixtureId=EXIT_GATE,
            channel=EXIT_CHANNEL,
            position=Coord(7, 3).to_json(),
        ),
    )


def _precedence() -> tuple[dict[str, str], ...]:
    pairs = (
        ("a-west-mosaic", "b-seat"),
        ("b-bridge-open", "b-seat"),
        ("b-seat", "a-east-mosaic"),
        ("b-source", "a-east-mosaic"),
        ("a-east-mosaic", "c-seat"),
        ("c-seat", "a-final-join"),
        ("a-final-join", "a-turn-north"),
        ("a-final-join", "c-recovery-open"),
        ("a-turn-north", "a-permanent-dock"),
        ("c-recovery-open", "a-permanent-dock"),
        ("a-permanent-dock", "evacuate"),
    )
    return tuple({"before": before, "after": after} for before, after in pairs)


def _build(_rng: Random) -> SolvedLayout:
    width, height = 13, 7
    cells = bulkhead_grid(width, height)

    # Thirty-one playable cells make two sealed cargo arcades around a narrow
    # shared spine.  B's arcade is a one-way elbow: once its cargo has crossed
    # the east door there is no stance cell from which it can be pushed back
    # onto A's route or C's mosaic.  The left arcade gives C the longer climb.
    # C's recovery door sits on A's final docking turn, beyond a neutral cell.
    floor_cells(
        cells,
        width,
        {
            Coord(1, 1),
            Coord(1, 2), Coord(6, 2),
            Coord(1, 3), Coord(6, 3), Coord(7, 3), Coord(11, 3),
            Coord(1, 4), Coord(4, 4), Coord(5, 4), Coord(6, 4), Coord(7, 4),
            Coord(8, 4), Coord(9, 4), Coord(11, 4),
            Coord(1, 5), Coord(2, 5), Coord(3, 5), Coord(4, 5), Coord(5, 5),
            Coord(6, 5), Coord(7, 5), Coord(8, 5), Coord(9, 5), Coord(10, 5),
            Coord(11, 5),
            Coord(1, 6), Coord(2, 6), Coord(7, 6), Coord(8, 6), Coord(10, 6),
            Coord(11, 6),
        },
    )

    # B-line is momentarily sourced by A's west mosaic and permanently held
    # by B's destination plate.  The same bridge serves B, then releases A.
    put(
        cells,
        width,
        WEST_MOSAIC_POSITION,
        Cell("floor", Fixture(WEST_MOSAIC, "plate", B_LINE)),
    )
    put(
        cells,
        width,
        Coord(8, 5),
        Cell("floor", Fixture(EAST_CROSSING, "door", B_LINE)),
    )
    put(
        cells,
        width,
        Coord(11, 3),
        Cell("floor", Fixture(EAST_OBLIGATION, "plate", B_LINE)),
    )

    # C-line mirrors the handoff on the west arcade.  Its recovery door is on
    # A's final route, one neutral cell after the east mosaic.
    put(
        cells,
        width,
        EAST_MOSAIC_POSITION,
        Cell("floor", Fixture(EAST_MOSAIC, "plate", C_LINE)),
    )
    put(
        cells,
        width,
        Coord(9, 4),
        Cell("floor", Fixture(EAST_ARCADE_SEAL, "door", B_LINE)),
    )
    put(
        cells,
        width,
        Coord(3, 5),
        Cell("floor", Fixture(WEST_CROSSING, "door", C_LINE)),
    )
    put(
        cells,
        width,
        Coord(1, 1),
        Cell("floor", Fixture(WEST_OBLIGATION, "plate", C_LINE)),
    )
    put(
        cells,
        width,
        Coord(6, 3),
        Cell("floor", Fixture(EAST_RECOVERY, "door", C_LINE)),
    )

    put(
        cells,
        width,
        FINAL_SOCKET_POSITION,
        Cell(
            "floor",
            Fixture(
                FINAL_SOCKET,
                "socket",
                EXIT_CHANNEL,
                initially_installed=True,
                initial_cell_id=REACTOR,
            ),
        ),
    )
    put(
        cells,
        width,
        Coord(7, 3),
        Cell("floor", Fixture(EXIT_GATE, "gate", EXIT_CHANNEL)),
    )

    level = Level(
        "g4",
        width,
        height,
        (
            Channel(B_LINE, "B"),
            Channel(C_LINE, "C"),
            Channel(EXIT_CHANNEL, "D"),
        ),
        tuple(cells),
        FRONTIER_PLAYER,
        (
            GameObject(EAST_CARGO, "cargo", Coord(11, 3)),
            GameObject(WEST_CARGO, "cargo", Coord(1, 1)),
        ),
    )
    frontier = solved_frontier(level, "E")
    layout = SolvedLayout(
        level=level,
        frontier=frontier,
        gate_action="E",
        room_entry=FRONTIER_PLAYER,
        plates=(
            WEST_MOSAIC_POSITION,
            EAST_MOSAIC_POSITION,
            Coord(11, 3),
            Coord(1, 1),
        ),
        relay_id=None,
        family_id=FAMILY_ID,
        persona=PERSONA,
        topology=TOPOLOGY,
        reverse_steps=(
            ReverseUndock(REACTOR, "N"),
            ReverseObjectRoute(
                REACTOR,
                (
                    EAST_MOSAIC_POSITION,
                    Coord(7, 4),
                    Coord(6, 4),
                    FRONTIER_PLAYER,
                ),
            ),
            ReverseObjectRoute(WEST_CARGO, WEST_CARGO_ROUTE),
            ReverseObjectRoute(
                REACTOR,
                (
                    WEST_MOSAIC_POSITION,
                    REACTOR_START,
                    Coord(7, 5),
                    Coord(8, 5),
                    EAST_MOSAIC_POSITION,
                ),
            ),
            ReverseObjectRoute(EAST_CARGO, EAST_CARGO_ROUTE),
            ReverseObjectRoute(REACTOR, (REACTOR_START, WEST_MOSAIC_POSITION)),
        ),
        expected_start_positions=(
            (REACTOR, REACTOR_START),
            (EAST_CARGO, EAST_CARGO_START),
            (WEST_CARGO, WEST_CARGO_START),
        ),
        milestone_specs=_milestones(),
        required_precedence=_precedence(),
    )
    validate_family_layout(FAMILY, layout)
    return layout


FAMILY = LayoutFamily(
    id=FAMILY_ID,
    persona=PERSONA,
    target_difficulty=7,
    topology=TOPOLOGY,
    mechanic_motif="A-to-B-to-A-to-C-to-A circuit latches through braided civic arcades",
    build=_build,
)
