"""Procedural graph-to-board embedding and solved-frontier construction."""

from __future__ import annotations

from random import Random

from .layout_family import SolvedLayout
from .rules import PLAYING, Snapshot, derive, initial_state, transition
from .schema import Cell, Channel, Coord, Direction, Fixture, GameObject, Level, PuzzleState, assert_valid_level
from .mission_graph import MissionGraph

def _set(cells: list[Cell], width: int, position: Coord, cell: Cell) -> None:
    cells[position.y * width + position.x] = cell


def build_solved_layout(graph: MissionGraph, rng: Random) -> SolvedLayout:
    """Embed the graph in a compact warehouse plus serial powered corridor.

    Every cargo begins on its own plate.  Those plates power distinct doors in
    the only route to the gate, so every source is required in the constructive
    solution.  Backward search then pulls the cargo into a shared workspace.
    """

    if graph.difficulty == 0:
        return _build_orientation_layout()
    if graph.difficulty >= 3:
        return _build_causal_layout(graph.difficulty)

    count = graph.object_count
    use_relay = graph.difficulty >= 6
    channel_count = count + int(use_relay)
    width = max(9, 2 * channel_count + 5)
    # Vertical room grows with the logical budget while object/fixture counts
    # remain low.  Even 13x16 with four channels stays below the 160-cell cap.
    height = (8, 8, 9, 10, 11, 14, 14, 15, 16)[graph.difficulty]
    cells = [Cell("bulkhead") for _ in range(width * height)]

    # Powered corridor at y=1, a one-cell throat at (1,2), shared warehouse
    # below it.  The divider prevents walking around a closed corridor door.
    for x in range(1, width - 1):
        _set(cells, width, Coord(x, 1), Cell("floor"))
    _set(cells, width, Coord(1, 2), Cell("floor"))
    # A five-cell-wide shared workspace keeps the exact state graph bounded;
    # challenge comes from reuse, not combinatorial empty floor.
    workspace_max_x = min(width - 2, 5)
    for y in range(3, height - 1):
        row_max_x = workspace_max_x if y <= 8 else min(workspace_max_x, 4)
        for x in range(1, row_max_x + 1):
            _set(cells, width, Coord(x, y), Cell("floor"))

    channels = tuple(Channel(f"c{index}", chr(ord("A") + index)) for index in range(channel_count))
    door_positions = tuple(Coord(3 + 2 * index, 1) for index in range(channel_count))
    plate_positions = tuple(Coord(2 + 2 * index, 3) for index in range(count))
    for index, position in enumerate(door_positions):
        _set(cells, width, position, Cell("floor", Fixture(f"door-{index}", "door", f"c{index}")))
    channel_offset = int(use_relay)
    for index, position in enumerate(plate_positions):
        _set(cells, width, position, Cell("floor", Fixture(f"plate-{index}", "plate", f"c{index + channel_offset}")))

    relay_id: str | None = None
    if use_relay:
        relay_id = "relay-0"
        _set(cells, width, Coord(1, 2), Cell("floor", Fixture(relay_id, "relay", "c0", initial_on=True)))

    gate_position = Coord(width - 2, 1)
    _set(cells, width, gate_position, Cell("floor", Fixture("gate-0", "gate", f"c{channel_count - 1}")))

    # Sparse alternating pillars produce turning/regrip choices without
    # inflating the footprint.  The first two warehouse rows stay clear so
    # every plate always has a verified initial pull.
    pillar_budget = max(0, graph.difficulty - 2) // 2
    possible = [
        Coord(x, y)
        for y in range(6, height - 1, 2)
        for x in range(3, width - 2, 3)
        if Coord(x, y) not in plate_positions
    ]
    rng.shuffle(possible)
    for position in possible[:pillar_budget]:
        _set(cells, width, position, Cell("bulkhead"))

    objects = tuple(GameObject(f"cargo-{index}", "cargo", position) for index, position in enumerate(plate_positions))
    frontier_player = Coord(gate_position.x - 1, gate_position.y)
    level = Level("g4", width, height, channels, tuple(cells), frontier_player, objects)
    assert_valid_level(level)
    frontier = initial_state(level)
    derived = derive(level, frontier)
    if not all(item.active for item in derived.channels):
        raise AssertionError("solved frontier did not power every corridor channel")
    final = transition(level, Snapshot(frontier, derived, PLAYING), "E")
    if not final.accepted or final.after.outcome.kind != "victory":
        raise AssertionError("solved frontier is not one move from victory")
    return SolvedLayout(level, frontier, "E", Coord(1, 3), plate_positions, relay_id)


def _build_orientation_layout() -> SolvedLayout:
    """Recovery-safe two-push lesson used only for difficulty zero."""

    width, height = 9, 8
    cells = [Cell("bulkhead") for _ in range(width * height)]
    for x in range(1, width - 1):
        _set(cells, width, Coord(x, 1), Cell("floor"))
    for position in (
        Coord(1, 2), Coord(1, 3), Coord(1, 4), Coord(1, 5), Coord(1, 6),
        Coord(2, 3), Coord(2, 4), Coord(2, 5), Coord(2, 6),
    ):
        _set(cells, width, position, Cell("floor"))
    plate = Coord(2, 3)
    _set(cells, width, plate, Cell("floor", Fixture("plate-0", "plate", "c0")))
    _set(cells, width, Coord(1, 4), Cell("floor", Fixture("door-0", "door", "c0")))
    gate = Coord(width - 2, 1)
    _set(cells, width, gate, Cell("floor", Fixture("gate-0", "gate", "c0")))
    frontier_player = Coord(gate.x - 1, gate.y)
    level = Level(
        "g4",
        width,
        height,
        (Channel("c0", "A"),),
        tuple(cells),
        frontier_player,
        (GameObject("cargo-0", "cargo", plate),),
    )
    assert_valid_level(level)
    frontier = initial_state(level)
    final = transition(level, Snapshot(frontier, derive(level, frontier), PLAYING), "E")
    if final.after.outcome.kind != "victory":
        raise AssertionError("orientation frontier is not solved")
    return SolvedLayout(level, frontier, "E", Coord(2, 4), (plate,), None)


def _build_causal_layout(difficulty: int) -> SolvedLayout:
    """Embed a mandatory A -> B -> A hold/cross/reclaim mission.

    Cargo A first holds a momentary source so cargo B can traverse a door.  B
    powers the return route, after which A must leave its temporary plate and
    dock in a permanent socket.  The final docking stance is trapped behind
    B's powered door once A occupies its pre-dock square, so the apparent
    A -> gate shortcut is physically impossible.  B's route is a compact
    five-run zig-zag rather than a long corridor push.
    """

    high = difficulty >= 6
    width = 16 if difficulty >= 5 else 10 + difficulty
    a_pushes = {3: 1, 4: 2, 5: 1, 6: 4, 7: 8, 8: 9}[difficulty]
    temp_plate = Coord(3, 5)
    a_initial = Coord(3, temp_plate.y + a_pushes)
    player_initial = Coord(3, a_initial.y + 1)
    height = max(9, player_initial.y + 1)

    # Prefixes of one hard-separated track scale the number of real turns.
    # The bulkhead defaults at (9,6), (8,3), (12,4), and (11,7) prevent the
    # old straight-row shortcut through the regrip pockets.
    full_b_path = [
        Coord(5, 6), Coord(6, 6), Coord(7, 6), Coord(8, 6),
        Coord(8, 5), Coord(8, 4),
        Coord(9, 4), Coord(10, 4), Coord(11, 4),
        Coord(11, 5), Coord(11, 6), Coord(12, 6), Coord(13, 6),
        Coord(13, 5), Coord(13, 4), Coord(13, 3),
    ]
    target_index = {3: 5, 4: 8, 5: 12, 6: 12, 7: 12, 8: 15}[difficulty]
    b_path = full_b_path[: target_index + 1]
    b_target = b_path[-1]

    cells = [Cell("bulkhead") for _ in range(width * height)]
    floor: set[Coord] = set(b_path)
    # A's hold/reclaim lane and the left side of B's powered cut.
    for y in range(4, player_initial.y + 1):
        floor.update((Coord(2, y), Coord(3, y)))
    floor.update((Coord(3, 3), Coord(4, 4), Coord(4, 5), Coord(4, 6)))
    if high:
        floor.add(Coord(3, 2))

    # Minimal regrip loops are added only for turns present in the prefix.
    if target_index >= 4:
        floor.update((Coord(7, 7), Coord(8, 7)))
    if target_index >= 6:
        floor.update((Coord(7, 5), Coord(7, 4)))
    if target_index >= 9:
        floor.update((Coord(10, 3), Coord(11, 3)))
    if target_index >= 11:
        floor.update((Coord(10, 5), Coord(10, 6)))
    if target_index >= 13:
        floor.update((Coord(12, 7), Coord(13, 7)))

    for position in floor:
        _set(cells, width, position, Cell("floor"))

    channels = [Channel("c0", "A"), Channel("c1", "B"), Channel("c2", "C")]
    if high:
        channels.append(Channel("c3", "D"))
    socket_position = Coord(2, 4)
    final_a = Coord(3, 4)
    _set(cells, width, temp_plate, Cell("floor", Fixture("plate-0", "plate", "c0")))
    _set(cells, width, b_target, Cell("floor", Fixture("plate-1", "plate", "c1")))
    _set(cells, width, socket_position, Cell(
        "floor",
        Fixture(
            "socket-0",
            "socket",
            "c2",
            initially_installed=True,
            initial_cell_id="cargo-0",
        ),
    ))
    _set(cells, width, Coord(6, 6), Cell("vacuum", Fixture("bridge-0", "bridge", "c0")))
    _set(cells, width, Coord(4, 5), Cell("floor", Fixture("door-1", "door", "c1")))

    if high:
        relay_id = "relay-0"
        # The relay doubles as the pre-dock stance.  In the solved frontier it
        # is on; backward construction may undo its entry before scrambling.
        _set(cells, width, Coord(4, 4), Cell("floor", Fixture(relay_id, "relay", "c3", initial_on=True)))
        _set(cells, width, Coord(3, 3), Cell("floor", Fixture("door-2", "door", "c3")))
        gate = Coord(3, 2)
        frontier_player = Coord(3, 3)
        gate_action: Direction = "N"
    else:
        relay_id = None
        gate = Coord(3, 3)
        frontier_player = Coord(3, 4)
        gate_action = "N"
    _set(cells, width, gate, Cell("floor", Fixture("gate-0", "gate", "c2")))

    level = Level(
        "g4",
        width,
        height,
        tuple(channels),
        tuple(cells),
        frontier_player,
        (
            GameObject("cargo-1", "cargo", b_target),
        ),
    )
    assert_valid_level(level)
    frontier = initial_state(level)
    final = transition(level, Snapshot(frontier, derive(level, frontier), PLAYING), gate_action)
    if final.after.outcome.kind != "victory":
        raise AssertionError("causal frontier is not solved")
    return SolvedLayout(
        level,
        frontier,
        gate_action,
        final_a,
        (final_a, b_target),
        relay_id,
        (a_initial, Coord(5, 6)),
    )
