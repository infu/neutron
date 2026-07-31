from hullshiftbrain.schema import Cell, Channel, Coord, Fixture, GameObject, Level


def room_level(
    *,
    player: Coord,
    objects: tuple[GameObject, ...] = (),
    fixtures: dict[Coord, Fixture] | None = None,
    terrains: dict[Coord, str] | None = None,
) -> Level:
    width = height = 7
    fixtures = fixtures or {}
    terrains = terrains or {}
    cells = []
    for y in range(height):
        for x in range(width):
            position = Coord(x, y)
            terrain = terrains.get(position, "bulkhead" if x in (0, width - 1) or y in (0, height - 1) else "floor")
            cells.append(Cell(terrain, fixtures.get(position)))
    # Tests may replace this gate, but every level remains statically valid.
    if not any(cell.fixture is not None and cell.fixture.kind == "gate" for cell in cells):
        position = Coord(5, 1)
        cells[position.y * width + position.x] = Cell("floor", Fixture("gate", "gate", "a"))
    return Level("g4", width, height, (Channel("a", "A"),), tuple(cells), player, objects)

