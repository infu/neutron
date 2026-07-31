"""Small construction helpers shared by layout-family modules."""

from __future__ import annotations

from collections.abc import Iterable

from ..rules import PLAYING, Snapshot, derive, initial_state, transition
from ..schema import Cell, Coord, Direction, Level, assert_valid_level


def bulkhead_grid(width: int, height: int) -> list[Cell]:
    return [Cell("bulkhead") for _ in range(width * height)]


def put(cells: list[Cell], width: int, position: Coord, cell: Cell) -> None:
    cells[position.y * width + position.x] = cell


def floor_cells(cells: list[Cell], width: int, positions: Iterable[Coord]) -> None:
    for position in positions:
        put(cells, width, position, Cell("floor"))


def solved_frontier(level: Level, gate_action: Direction):
    """Validate a static board and prove that its frontier wins in one move."""

    assert_valid_level(level)
    frontier = initial_state(level)
    final = transition(level, Snapshot(frontier, derive(level, frontier), PLAYING), gate_action)
    if not final.accepted or final.after.outcome.kind != "victory":
        raise AssertionError("layout frontier is not one accepted move from victory")
    return frontier

