from hullshiftbrain.canonical import canonical_state_key
from hullshiftbrain.inverse import dock_predecessors, loss_predecessors, walk_predecessors
from hullshiftbrain.rules import initial_snapshot, transition
from hullshiftbrain.schema import Coord, Fixture, GameObject

from helpers import room_level


def _assert_roundtrips(level, successor, edges) -> None:
    assert edges
    for edge in edges:
        result = transition(level, initial_snapshot(level).__class__(edge.predecessor, initial_snapshot(level).derived), edge.action)
        # transition recomputes derived input, so the simple snapshot shell is sufficient.
        assert result.accepted
        assert canonical_state_key(result.after.state) == canonical_state_key(successor)


def test_walk_and_fracture_inverse_roundtrip() -> None:
    level = room_level(player=Coord(2, 2), terrains={Coord(2, 2): "fracture"})
    forward = transition(level, initial_snapshot(level), "E")
    edges = walk_predecessors(level, forward.after.state)
    _assert_roundtrips(level, forward.after.state, edges)
    assert any(edge.predecessor.collapsed_fractures == () for edge in edges)


def test_dock_and_loss_inverse_roundtrip() -> None:
    dock_level = room_level(
        player=Coord(3, 4),
        objects=(GameObject("cell", "reactor-cell", Coord(3, 3)),),
        fixtures={Coord(3, 2): Fixture("socket", "socket", "a", initially_installed=False)},
    )
    dock = transition(dock_level, initial_snapshot(dock_level), "N")
    _assert_roundtrips(dock_level, dock.after.state, dock_predecessors(dock_level, dock.after.state))

    loss_level = room_level(
        player=Coord(2, 2),
        objects=(GameObject("cargo", "cargo", Coord(3, 2)),),
        terrains={Coord(4, 2): "vacuum"},
    )
    loss = transition(loss_level, initial_snapshot(loss_level), "E")
    _assert_roundtrips(loss_level, loss.after.state, loss_predecessors(loss_level, loss.after.state))

