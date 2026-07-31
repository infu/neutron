from __future__ import annotations

from collections import deque
import shutil

import pytest

from hullshiftbrain.canonical import canonical_level_hash, canonical_state_key
from hullshiftbrain.parity import TypeScriptOracle
from hullshiftbrain.rules import Snapshot, TransitionResult, initial_snapshot, transition
from hullshiftbrain.schema import DIRECTIONS, Coord, Direction, Fixture, GameObject, Level
from hullshiftbrain.search import generate_candidate

from helpers import room_level


def _mechanic_levels() -> tuple[Level, ...]:
    return (
        room_level(
            player=Coord(2, 1),
            fixtures={Coord(1, 1): Fixture("relay", "relay", "a", initial_on=False)},
        ),
        room_level(
            player=Coord(3, 4),
            objects=(GameObject("cell", "reactor-cell", Coord(3, 3)),),
            fixtures={Coord(3, 2): Fixture("socket", "socket", "a", initially_installed=False)},
        ),
        room_level(player=Coord(2, 2), terrains={Coord(2, 2): "fracture"}),
        room_level(
            player=Coord(2, 2),
            objects=(GameObject("cargo", "cargo", Coord(3, 2)),),
            terrains={Coord(4, 2): "vacuum"},
        ),
    )


def _assert_transition_parity(
    oracle: TypeScriptOracle,
    level: Level,
    snapshot: Snapshot,
    action: Direction,
) -> TransitionResult:
    expected = oracle.transition(level, snapshot.state, action)
    actual = transition(level, snapshot, action)
    assert expected["accepted"] == actual.accepted
    assert expected["pushed"] == actual.pushed
    assert expected["afterStateKey"] == canonical_state_key(actual.after.state)
    assert expected["after"]["outcome"]["kind"] == actual.after.outcome.kind
    assert expected["events"] == list(actual.events)
    assert expected["internalPasses"] == actual.internal_passes
    if not actual.accepted:
        assert expected["blockedReason"] == actual.blocked_reason
    return actual


def test_generated_trace_matches_production_oracle() -> None:
    if shutil.which("bun") is None:
        pytest.skip("bun unavailable")
    candidate = generate_candidate(6, "parity-test", 0)
    current = initial_snapshot(candidate.level)
    transition_requests = 0
    with TypeScriptOracle() as oracle:
        assert oracle.level_hash(candidate.level) == canonical_level_hash(candidate.level)
        assert oracle.initial(candidate.level)["stateKey"] == canonical_state_key(current.state)
        for action in candidate.witness:
            selected: TransitionResult | None = None
            for probe in DIRECTIONS:
                actual = _assert_transition_parity(oracle, candidate.level, current, probe)
                transition_requests += 1
                if probe == action:
                    selected = actual
            assert selected is not None and selected.accepted
            current = selected.after

        # Exercise explicit relay, docking, fracture, and loss fixtures before
        # broadening their reachable state corpus.  One persistent oracle
        # process handles the whole deterministic differential run.
        queues: list[tuple[Level, deque[Snapshot], set[str]]] = []
        for level in _mechanic_levels():
            initial = initial_snapshot(level)
            queue: deque[Snapshot] = deque()
            seen = {canonical_state_key(initial.state)}
            for action in DIRECTIONS:
                result = _assert_transition_parity(oracle, level, initial, action)
                transition_requests += 1
                key = canonical_state_key(result.after.state)
                if result.accepted and result.after.outcome.kind == "playing" and key not in seen:
                    seen.add(key)
                    queue.append(result.after)
            queues.append((level, queue, seen))

        while transition_requests < 512 and any(queue for _, queue, _ in queues):
            for level, queue, seen in queues:
                if transition_requests >= 512 or not queue:
                    continue
                snapshot = queue.popleft()
                for action in DIRECTIONS:
                    result = _assert_transition_parity(oracle, level, snapshot, action)
                    transition_requests += 1
                    key = canonical_state_key(result.after.state)
                    if result.accepted and result.after.outcome.kind == "playing" and key not in seen:
                        seen.add(key)
                        queue.append(result.after)
        assert transition_requests >= 512
    assert current.outcome.kind == "victory"


def test_relay_dock_fracture_and_loss_rules() -> None:
    relay_level, dock_level, fracture_level, loss_level = _mechanic_levels()
    relay = transition(relay_level, initial_snapshot(relay_level), "W")
    assert relay.accepted
    assert relay.after.state.active_relay_ids == ("relay",)

    dock = transition(dock_level, initial_snapshot(dock_level), "N")
    assert dock.accepted and dock.after.state.objects == ()
    assert dock.after.state.installed_cells[0].object_id == "cell"

    fracture = transition(fracture_level, initial_snapshot(fracture_level), "E")
    assert fracture.after.state.collapsed_fractures == (Coord(2, 2),)

    loss = transition(loss_level, initial_snapshot(loss_level), "E")
    assert loss.accepted and loss.after.state.objects == ()
    assert loss.after.state.removed_object_ids == ("cargo",)
