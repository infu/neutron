"""Compact Japanese figure-eight interchange for difficulty six.

The board is drawn like a small transfer diagram: two colored loops touch at
one central platform, with short sightlines to both destinations.  The reactor
uses the platform first to energize the freight bridge.  Once freight is clear
of that bridge, the reactor must leave the platform for an upper waiting bay;
freight can then take the same platform, turn into its terminal, and open the
upper interlock.  Only then can the reactor traverse the platform a second time
and make its permanent socket commitment.

This is an A -> B -> A/B -> B -> A branch/join handoff, not a haul: every
object route turns frequently, the board has fewer than thirty walkable cells,
and the two middle tasks (stage B, clear A) may be prepared in either order
before joining at the shared platform.
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


FAMILY_ID = "japanese-interchange"
PERSONA = "Japanese UX designer"
TOPOLOGY = "compact-figure-eight-interchange"

REACTOR = "interchange-reactor"
FREIGHT = "interchange-freight"

PLATFORM_PLATE = "central-platform"
TRANSFER_BRIDGE = "inbound-transfer-bridge"
TERMINAL_PLATE = "freight-terminal-platform"
NORTH_RETURN_DOOR = "north-return-door"
FINAL_APPROACH_DOOR = "final-approach-door"
FINAL_SOCKET = "reactor-terminal-socket"
EXIT_GATE = "interchange-exit-gate"

PLATFORM_CHANNEL = "platform-line"
CLEARANCE_CHANNEL = "clearance-line"
EXIT_CHANNEL = "exit-line"

SHARED_PLATFORM = Coord(4, 4)
REACTOR_START = Coord(7, 3)
FREIGHT_START = Coord(9, 4)
FREIGHT_STAGE = Coord(6, 4)
REACTOR_CLEAR = Coord(4, 2)
FREIGHT_FINAL = Coord(4, 5)
FINAL_SOCKET_POSITION = Coord(2, 3)

# First loop: A claims the central platform so B can enter the interchange.
REACTOR_PLATFORM_ROUTE = (
    REACTOR_START,
    Coord(6, 3),
    Coord(5, 3),
    Coord(5, 4),
    SHARED_PLATFORM,
)

# B crosses the powered inbound branch and waits in the visibly marked bay.
FREIGHT_STAGE_ROUTE = (
    FREIGHT_START,
    Coord(8, 4),
    Coord(7, 4),
    FREIGHT_STAGE,
)

# Clearing A is a commitment: the isolated north pocket cannot be approached
# from behind until B reaches its terminal and powers the return-side door.
REACTOR_CLEAR_ROUTE = (
    SHARED_PLATFORM,
    Coord(4, 3),
    REACTOR_CLEAR,
)

# B now owns the shared platform and clears it southward into a terminal pocket.
# Both exits beyond the terminal are bulkheads, so seating A there is fatal.
FREIGHT_PLATFORM_ROUTE = (
    FREIGHT_STAGE,
    Coord(5, 4),
    SHARED_PLATFORM,
    FREIGHT_FINAL,
)

# The powered upper loop lets the player get behind A and return it through the
# shared platform.  ReverseUndock owns the final northward socket push.
REACTOR_FINAL_ROUTE = (
    REACTOR_CLEAR,
    Coord(4, 3),
    SHARED_PLATFORM,
    Coord(3, 4),
    Coord(2, 4),
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
    if co_emits:
        spec["coEmitsWith"] = list(co_emits)
    if guard is not None:
        spec["guard"] = guard
    return spec


def _milestones() -> tuple[dict[str, Any], ...]:
    platform_group = ("a-platform", "platform-source", "transfer-open")
    terminal_group = (
        "b-clear-platform",
        "b-terminal",
        "terminal-source",
        "interlock-open",
    )
    return (
        _event(
            "a-platform",
            "pushing",
            "object-pushed",
            objectId=REACTOR,
            to=SHARED_PLATFORM.to_json(),
            co_emits=tuple(item for item in platform_group if item != "a-platform"),
        ),
        _event(
            "platform-source",
            "momentary-circuit",
            "source-changed",
            fixtureId=PLATFORM_PLATE,
            active=True,
            guard={
                "afterState": {
                    "entityAt": {
                        "entityId": REACTOR,
                        "position": SHARED_PLATFORM.to_json(),
                    }
                }
            },
            co_emits=tuple(item for item in platform_group if item != "platform-source"),
        ),
        _event(
            "transfer-open",
            "consumers",
            "consumer-changed",
            fixtureId=TRANSFER_BRIDGE,
            powered=True,
            passable=True,
            co_emits=tuple(item for item in platform_group if item != "transfer-open")
            + ("b-platform",),
        ),
        _event(
            "b-bridge-clear",
            "pushing",
            "object-pushed",
            objectId=FREIGHT,
            **{"from": Coord(7, 4).to_json(), "to": FREIGHT_STAGE.to_json()},
        ),
        _event(
            "b-bridge-enter",
            "pushing",
            "object-pushed",
            objectId=FREIGHT,
            to=Coord(8, 4).to_json(),
        ),
        _event(
            "a-clear",
            "pushing",
            "object-pushed",
            objectId=REACTOR,
            **{"from": Coord(4, 3).to_json(), "to": REACTOR_CLEAR.to_json()},
        ),
        _event(
            "b-platform",
            "pushing",
            "object-pushed",
            objectId=FREIGHT,
            to=SHARED_PLATFORM.to_json(),
            co_emits=("transfer-open",),
        ),
        _event(
            "b-clear-platform",
            "pushing",
            "object-pushed",
            objectId=FREIGHT,
            **{"from": SHARED_PLATFORM.to_json(), "to": FREIGHT_FINAL.to_json()},
            co_emits=tuple(item for item in terminal_group if item != "b-clear-platform"),
        ),
        _event(
            "b-terminal",
            "pushing",
            "object-pushed",
            objectId=FREIGHT,
            to=FREIGHT_FINAL.to_json(),
            co_emits=tuple(item for item in terminal_group if item != "b-terminal"),
        ),
        _event(
            "terminal-source",
            "momentary-circuit",
            "source-changed",
            fixtureId=TERMINAL_PLATE,
            active=True,
            guard={
                "afterState": {
                    "entityAt": {
                        "entityId": FREIGHT,
                        "position": FREIGHT_FINAL.to_json(),
                    }
                }
            },
            co_emits=tuple(item for item in terminal_group if item != "terminal-source"),
        ),
        _event(
            "interlock-open",
            "consumers",
            "consumer-changed",
            fixtureId=FINAL_APPROACH_DOOR,
            powered=True,
            passable=True,
            guard={
                "all": [
                    {
                        "afterState": {
                            "consumerState": {
                                "fixtureId": NORTH_RETURN_DOOR,
                                "powered": True,
                                "passable": True,
                            }
                        }
                    },
                    {
                        "afterState": {
                            "entityAt": {
                                "entityId": FREIGHT,
                                "position": FREIGHT_FINAL.to_json(),
                            }
                        }
                    },
                    {
                        "afterState": {
                            "consumerState": {
                                "fixtureId": FINAL_APPROACH_DOOR,
                                "powered": True,
                                "passable": True,
                            }
                        }
                    },
                ]
            },
            co_emits=tuple(item for item in terminal_group if item != "interlock-open"),
        ),
        _event(
            "a-return-platform",
            "pushing",
            "object-pushed",
            objectId=REACTOR,
            to=SHARED_PLATFORM.to_json(),
            guard={
                "all": [
                    {"afterState": {"channelActive": CLEARANCE_CHANNEL}},
                    {
                        "afterState": {
                            "entityAt": {
                                "entityId": FREIGHT,
                                "position": FREIGHT_FINAL.to_json(),
                            }
                        }
                    },
                ]
            },
        ),
        _event(
            "a-interlock-pass",
            "pushing",
            "object-pushed",
            objectId=REACTOR,
            to=Coord(2, 4).to_json(),
            guard={
                "afterState": {
                    "consumerState": {
                        "fixtureId": FINAL_APPROACH_DOOR,
                        "powered": True,
                        "passable": True,
                    }
                }
            },
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
            position=Coord(1, 4).to_json(),
        ),
    )


def _precedence() -> tuple[dict[str, str], ...]:
    # Two same-depth preparation branches join at b-platform.  The longest
    # declared path has nine nodes, matching the d6 dependency target without
    # pretending co-emitted source/consumer events occur in sequence.
    pairs = (
        ("a-platform", "b-bridge-enter"),
        ("platform-source", "b-bridge-enter"),
        ("transfer-open", "b-bridge-enter"),
        ("b-bridge-enter", "b-bridge-clear"),
        ("b-bridge-clear", "a-clear"),
        ("a-clear", "b-platform"),
        ("b-platform", "b-clear-platform"),
        ("b-platform", "b-terminal"),
        ("b-platform", "terminal-source"),
        ("b-platform", "interlock-open"),
        ("b-clear-platform", "a-return-platform"),
        ("b-terminal", "a-return-platform"),
        ("terminal-source", "a-return-platform"),
        ("interlock-open", "a-return-platform"),
        ("b-clear-platform", "a-interlock-pass"),
        ("b-terminal", "a-interlock-pass"),
        ("terminal-source", "a-interlock-pass"),
        ("interlock-open", "a-interlock-pass"),
        ("a-return-platform", "a-interlock-pass"),
        ("a-interlock-pass", "a-permanent-dock"),
        ("a-permanent-dock", "evacuate"),
    )
    return tuple({"before": before, "after": after} for before, after in pairs)


def _build(_rng: Random) -> SolvedLayout:
    width, height = 11, 9
    cells = bulkhead_grid(width, height)

    # Thirty-three non-bulkhead cells form two compact passenger loops around the
    # shared platform.  The marked terminal is a one-way object pocket, while the
    # lower loop supplies player regrips without opening an alternate object lane.
    floor_cells(
        cells,
        width,
        {
            Coord(4, 1), Coord(5, 1),
            Coord(4, 2), Coord(5, 2),
            Coord(2, 3), Coord(4, 3), Coord(5, 3), Coord(6, 3), Coord(7, 3),
            Coord(8, 3), Coord(9, 3), Coord(10, 3),
            Coord(1, 4), Coord(2, 4), Coord(3, 4), Coord(4, 4), Coord(5, 4),
            Coord(6, 4), Coord(7, 4), Coord(8, 4), Coord(9, 4), Coord(10, 4),
            Coord(2, 5), Coord(3, 5), Coord(4, 5), Coord(6, 5), Coord(7, 5),
            Coord(3, 6), Coord(5, 6), Coord(6, 6),
            Coord(3, 7), Coord(4, 7), Coord(5, 7),
        },
    )

    put(
        cells,
        width,
        SHARED_PLATFORM,
        Cell("floor", Fixture(PLATFORM_PLATE, "plate", PLATFORM_CHANNEL)),
    )
    put(
        cells,
        width,
        Coord(8, 4),
        Cell("vacuum", Fixture(TRANSFER_BRIDGE, "bridge", PLATFORM_CHANNEL)),
    )
    put(
        cells,
        width,
        FREIGHT_FINAL,
        Cell("floor", Fixture(TERMINAL_PLATE, "plate", CLEARANCE_CHANNEL)),
    )
    put(
        cells,
        width,
        Coord(4, 1),
        Cell("floor", Fixture(NORTH_RETURN_DOOR, "door", CLEARANCE_CHANNEL)),
    )
    put(
        cells,
        width,
        Coord(3, 4),
        Cell("floor", Fixture(FINAL_APPROACH_DOOR, "door", CLEARANCE_CHANNEL)),
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
        Coord(1, 4),
        Cell("floor", Fixture(EXIT_GATE, "gate", EXIT_CHANNEL)),
    )

    level = Level(
        "g4",
        width,
        height,
        (
            Channel(PLATFORM_CHANNEL, "A"),
            Channel(CLEARANCE_CHANNEL, "B"),
            Channel(EXIT_CHANNEL, "C"),
        ),
        tuple(cells),
        Coord(2, 4),
        (GameObject(FREIGHT, "cargo", FREIGHT_FINAL),),
    )
    frontier = solved_frontier(level, "W")
    layout = SolvedLayout(
        level=level,
        frontier=frontier,
        gate_action="W",
        room_entry=Coord(2, 4),
        plates=(SHARED_PLATFORM, FREIGHT_FINAL),
        relay_id=None,
        family_id=FAMILY_ID,
        persona=PERSONA,
        topology=TOPOLOGY,
        reverse_steps=(
            ReverseUndock(REACTOR, "N"),
            ReverseObjectRoute(REACTOR, REACTOR_FINAL_ROUTE),
            ReverseObjectRoute(FREIGHT, FREIGHT_PLATFORM_ROUTE),
            ReverseObjectRoute(REACTOR, REACTOR_CLEAR_ROUTE),
            ReverseObjectRoute(FREIGHT, FREIGHT_STAGE_ROUTE),
            ReverseObjectRoute(REACTOR, REACTOR_PLATFORM_ROUTE),
        ),
        expected_start_positions=(
            (REACTOR, REACTOR_START),
            (FREIGHT, FREIGHT_START),
        ),
        milestone_specs=_milestones(),
        required_precedence=_precedence(),
    )
    validate_family_layout(FAMILY, layout)
    return layout


FAMILY = LayoutFamily(
    id=FAMILY_ID,
    persona=PERSONA,
    target_difficulty=6,
    topology=TOPOLOGY,
    mechanic_motif="shared-platform branch/join handoff into delayed permanent docking",
    build=_build,
)
