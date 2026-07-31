from hullshiftbrain.canonical import canonical_shape_signature, topology_signature
from hullshiftbrain.schema import Cell, Channel, Coord, Fixture, Level


def _shape_level(
    width: int,
    height: int,
    entries: tuple[tuple[Coord, str, str | None], ...],
) -> Level:
    cells = [Cell("bulkhead") for _ in range(width * height)]
    for index, (position, terrain, fixture_kind) in enumerate(entries):
        fixture = None
        if fixture_kind is not None:
            fixture = Fixture(
                f"fixture-{index}",
                fixture_kind,  # type: ignore[arg-type]
                "power",
            )
        cells[position.y * width + position.x] = Cell(terrain, fixture)  # type: ignore[arg-type]
    return Level(
        "g4",
        width,
        height,
        (Channel("power", "A"),),
        tuple(cells),
        entries[0][0],
        (),
    )


def test_shape_signature_folds_padding_translation_rotation_and_reflection() -> None:
    original_entries = (
        (Coord(1, 1), "floor", "plate"),
        (Coord(2, 1), "floor", None),
        (Coord(2, 2), "vacuum", "bridge"),
        (Coord(3, 2), "floor", "gate"),
        (Coord(3, 3), "fracture", None),
    )
    original = _shape_level(7, 7, original_entries)
    # Reflect, rotate clockwise, then shift into a differently sized frame.
    transformed_entries = tuple(
        (Coord(2 + position.y, 6 - position.x), terrain, fixture_kind)
        for position, terrain, fixture_kind in original_entries
    )
    transformed = _shape_level(10, 9, transformed_entries)

    assert topology_signature(original) != topology_signature(transformed)
    assert canonical_shape_signature(original) == canonical_shape_signature(transformed)


def test_shape_signature_preserves_gameplay_cell_kinds() -> None:
    entries = (
        (Coord(1, 1), "floor", "plate"),
        (Coord(2, 1), "floor", None),
        (Coord(2, 2), "vacuum", "bridge"),
        (Coord(3, 2), "floor", "gate"),
    )
    bridge = _shape_level(7, 7, entries)
    door = _shape_level(
        7,
        7,
        tuple(
            (position, terrain, "door" if fixture_kind == "bridge" else fixture_kind)
            for position, terrain, fixture_kind in entries
        ),
    )

    assert canonical_shape_signature(bridge) != canonical_shape_signature(door)
