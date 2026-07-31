"""Mission-guided verified backward beam search."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
import hashlib
from random import Random
from typing import Any

from .canonical import canonical_level_hash, canonical_state_key, semantic_signature, topology_signature
from .inverse import (
    InverseEdge,
    dock_predecessors,
    predecessor_with_player,
    pull_predecessor,
    walk_predecessors,
)
from .layout import build_solved_layout
from .layout_family import (
    ReverseObjectRoute,
    ReversePlayerMove,
    ReverseUndock,
    LayoutFamily,
    SolvedLayout,
    validate_family_layout,
)
from .metrics import witness_metrics
from .mission_graph import MissionGraph, synthesize_mission
from .rules import initial_state, replay
from .schema import Coord, Direction, Level, PuzzleState, assert_valid_level

BRAIN_VERSION = "hullshiftbrain-v1"
ALGORITHM_VERSION = "backward-beam-v1"


@dataclass(frozen=True, slots=True)
class BeamNode:
    state: PuzzleState
    edges: tuple[InverseEdge, ...]
    trails: tuple[tuple[Coord, ...], ...]
    pull_labels: tuple[str, ...]
    pull_directions: tuple[tuple[int, int], ...]
    walk_count: int


@dataclass(frozen=True, slots=True)
class Candidate:
    id: str
    difficulty: int
    level: Level
    witness: tuple[Direction, ...]
    mission: MissionGraph
    milestones: tuple[dict[str, Any], ...]
    metrics: dict[str, Any]
    master_seed: str
    candidate_id: int
    reverse_actions: tuple[Direction, ...]
    layout_family_id: str = "legacy"
    precedence: tuple[dict[str, str], ...] = ()

    def provenance(self) -> dict[str, Any]:
        return {
            "masterSeed": self.master_seed,
            "candidateId": str(self.candidate_id),
            "algorithmVersion": (
                ALGORITHM_VERSION
                if self.layout_family_id == "legacy"
                else f"{ALGORITHM_VERSION}.{self.layout_family_id}"
            ),
            "reverseDepth": len(self.reverse_actions),
            "brainVersion": BRAIN_VERSION,
            "requestedDifficulty": self.difficulty,
            "requiresTypeScriptCertification": True,
        }

    def required_precedence(self) -> list[dict[str, str]]:
        if self.precedence:
            return [dict(relation) for relation in self.precedence]
        milestone_ids = {str(item["id"]) for item in self.milestones}
        if "a-temp" in milestone_ids:
            b_steps = sorted(
                (item for item in milestone_ids if item.startswith("b-step-")),
                key=lambda item: int(item.rsplit("-", 1)[1]),
            )
            phases = ["a-temp", *b_steps, "b-source", "a-final", "evacuate"]
            edges = [{"before": left, "after": right} for left, right in zip(phases, phases[1:])]
            first_b = b_steps[0] if b_steps else "b-source"
            for source in ("temp-source", "bridge-0-open"):
                edges.append({"before": source, "after": first_b})
            edges.append({"before": "a-release", "after": "a-final"})
            if "relay-on" in milestone_ids:
                # Relay timing is intentionally flexible: it may be prepared
                # before A blocks the docking corridor or entered as the final
                # docking stance.  Only its necessity before evacuation is
                # claimed here.
                edges.append({"before": "relay-on", "after": "evacuate"})
            if "door-2-open" in milestone_ids:
                edges.append({"before": "door-2-open", "after": "evacuate"})
            return edges
        push_ids = [str(item["id"]) for item in self.milestones if str(item["id"]).startswith("push-")]
        edges = [
            {"before": left, "after": right}
            for left, right in zip(push_ids, push_ids[1:])
            if left.rsplit("-", 1)[0] == right.rsplit("-", 1)[0]
        ]
        for milestone in self.milestones:
            milestone_id = str(milestone["id"])
            if milestone_id != "evacuate" and (
                milestone_id.startswith("momentary-source")
                or milestone_id in ("relay-on", "channel-powered", "corridor-opened")
            ):
                edges.append({"before": milestone_id, "after": "evacuate"})
        return edges

    def to_record(self) -> dict[str, Any]:
        return {
            "schemaVersion": "hullshiftbrain-candidate-v1",
            "id": self.id,
            "difficulty": self.difficulty,
            "level": self.level.to_json(),
            "witness": list(self.witness),
            "milestones": list(self.milestones),
            "requiredPrecedence": self.required_precedence(),
            "causalGraph": self.mission.to_json(),
            "metrics": self.metrics,
            "provenance": self.provenance(),
            "canonicalLevelHash": canonical_level_hash(self.level),
            "topologySignature": topology_signature(self.level),
            "semanticSignature": semantic_signature(self.level),
        }

    def to_catalog_entry(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "difficulty": self.difficulty,
            "level": self.level.to_json(),
            "witness": list(self.witness),
            "milestones": list(self.milestones),
            "requiredPrecedence": self.required_precedence(),
            "provenance": self.provenance(),
            "metrics": self.metrics,
            "topologySignature": topology_signature(self.level),
            "semanticSignature": semantic_signature(self.level),
        }


def derive_seed(master_seed: str, difficulty: int, candidate_id: int, phase: str = "candidate") -> int:
    payload = f"{BRAIN_VERSION}\0{master_seed.lower()}\0{difficulty}\0{candidate_id}\0{phase}".encode()
    return int.from_bytes(hashlib.sha256(payload).digest()[:16], "big")


def _inverse_walk_path(
    level: Level,
    start: PuzzleState,
    target: Coord,
    *,
    max_states: int = 512,
) -> tuple[InverseEdge, ...] | None:
    if start.player == target:
        return ()
    # Generated layouts contain no walk-triggered state.  Find the neutral
    # coordinate route first, then verify only its retained edges.  This avoids
    # expanding hundreds of equivalent full PuzzleState records for every
    # prospective pull stance.
    if start.player is not None:
        queue_positions = deque([start.player])
        parent: dict[Coord, Coord | None] = {start.player: None}
        objects = {item.position for item in start.objects}
        while queue_positions and len(parent) <= max_states:
            current_position = queue_positions.popleft()
            if current_position == target:
                positions: list[Coord] = []
                cursor: Coord | None = target
                while cursor is not None:
                    positions.append(cursor)
                    cursor = parent[cursor]
                positions.reverse()
                state = start
                result: list[InverseEdge] = []
                for desired in positions[1:]:
                    edge = predecessor_with_player(level, state, desired)
                    if edge is None:
                        break
                    result.append(edge)
                    state = edge.predecessor
                else:
                    return tuple(result)
                break
            for dx, dy in ((0, -1), (1, 0), (0, 1), (-1, 0)):
                predecessor_position = current_position.plus(dx, dy)
                if predecessor_position in parent or predecessor_position in objects:
                    continue
                cell = level.cell(predecessor_position)
                if cell is None or cell.terrain in ("bulkhead", "vacuum"):
                    continue
                if cell.fixture is not None and cell.fixture.kind in ("gate", "disposal"):
                    continue
                parent[predecessor_position] = current_position
                queue_positions.append(predecessor_position)

    queue = deque([(start, tuple())])
    seen = {canonical_state_key(start)}
    while queue and len(seen) <= max_states:
        state, path = queue.popleft()
        for edge in walk_predecessors(level, state):
            key = canonical_state_key(edge.predecessor)
            if key in seen:
                continue
            next_path = (*path, edge)
            if edge.predecessor.player == target:
                return next_path
            seen.add(key)
            queue.append((edge.predecessor, next_path))
    return None


def _pull_options(layout: SolvedLayout, node: BeamNode) -> list[BeamNode]:
    level = layout.level
    occupied = {item.position for item in node.state.objects}
    result: list[BeamNode] = []
    moves = ((0, 1), (-1, 0), (1, 0), (0, -1))
    for object_index, item in enumerate(node.state.objects):
        trail = node.trails[object_index]
        for dx, dy in moves:
            destination = item.position.plus(dx, dy)
            tail = item.position.plus(2 * dx, 2 * dy)
            if destination.y < 3 or tail.y < 3:
                continue
            if not level.inside(destination) or not level.inside(tail):
                continue
            if destination in occupied or tail in occupied:
                continue
            destination_cell = level.cell(destination)
            tail_cell = level.cell(tail)
            if destination_cell is None or tail_cell is None:
                continue
            if destination_cell.terrain != "floor" or tail_cell.terrain != "floor":
                continue
            if destination_cell.fixture is not None or tail_cell.fixture is not None:
                continue
            if len(trail) >= 2 and destination == trail[-2]:
                continue  # immediate object cancellation
            walk = _inverse_walk_path(level, node.state, destination)
            if walk is None:
                continue
            at_stance = walk[-1].predecessor if walk else node.state
            pull = pull_predecessor(level, at_stance, item.id, dx, dy)
            if pull is None:
                continue
            trails = list(node.trails)
            trails[object_index] = (*trail, destination)
            result.append(BeamNode(
                state=pull.predecessor,
                edges=(*node.edges, *walk, pull),
                trails=tuple(trails),
                pull_labels=(*node.pull_labels, item.id),
                pull_directions=(*node.pull_directions, (dx, dy)),
                walk_count=node.walk_count + len(walk),
            ))
    return result


def _node_rank(node: BeamNode, layout: SolvedLayout, salt: int) -> tuple[Any, ...]:
    pull_counts = {item.id: node.pull_labels.count(item.id) for item in node.state.objects}
    coverage = sum(count > 0 for count in pull_counts.values())
    min_count = min(pull_counts.values(), default=0)
    alternations = sum(a != b for a, b in zip(node.pull_labels, node.pull_labels[1:]))
    turns = sum(
        label_a == label_b and direction_a != direction_b
        for label_a, label_b, direction_a, direction_b in zip(
            node.pull_labels,
            node.pull_labels[1:],
            node.pull_directions,
            node.pull_directions[1:],
        )
    )
    distance = sum(
        abs(item.position.x - plate.x) + abs(item.position.y - plate.y)
        for item, plate in zip(node.state.objects, layout.plates)
    )
    digest = hashlib.sha256(f"{salt}:{canonical_state_key(node.state)}".encode()).hexdigest()
    return (coverage, min_count, distance, alternations, turns, -node.walk_count, digest)


def _scramble(layout: SolvedLayout, difficulty: int, rng: Random, salt: int) -> BeamNode:
    route = _inverse_walk_path(layout.level, layout.frontier, layout.room_entry, max_states=2048)
    if route is None:
        raise RuntimeError("cannot walk backward from solved frontier into warehouse")
    state = route[-1].predecessor if route else layout.frontier
    trails = tuple((item.position,) for item in state.objects)
    if difficulty == 0:
        edges = list(route)
        labels: list[str] = []
        directions: list[tuple[int, int]] = []
        trail = list(trails[0])
        for _ in range(2):
            pull = pull_predecessor(layout.level, state, "cargo-0", 0, 1)
            if pull is None:
                raise RuntimeError("orientation reverse pull failed")
            state = pull.predecessor
            edges.append(pull)
            labels.append("cargo-0")
            directions.append((0, 1))
            trail.append(next(item.position for item in state.objects if item.id == "cargo-0"))
        return BeamNode(state, tuple(edges), (tuple(trail),), tuple(labels), tuple(directions), len(route))
    if layout.reverse_steps:
        return _scramble_family(layout, state, route)
    if layout.causal_start_positions is not None:
        return _scramble_causal(layout, state, route)
    beam = [BeamNode(state, route, trails, (), (), len(route))]
    target_pushes = (
        4
        if difficulty == 1
        else 4 + 2 * difficulty + int(difficulty ** 1.2)
    )
    beam_width = 8 if difficulty < 5 else 12
    globally_seen = {canonical_state_key(state)}
    for _ in range(target_pushes):
        expanded: list[BeamNode] = []
        for node in beam:
            expanded.extend(_pull_options(layout, node))
        if not expanded:
            break
        # Deduplicate by full dynamic state and retain the strongest lineage.
        by_state: dict[str, BeamNode] = {}
        for node in expanded:
            key = canonical_state_key(node.state)
            incumbent = by_state.get(key)
            if incumbent is None or _node_rank(node, layout, salt) > _node_rank(incumbent, layout, salt):
                by_state[key] = node
        ranked = sorted(by_state.values(), key=lambda node: _node_rank(node, layout, salt), reverse=True)
        beam = ranked[:beam_width]
        globally_seen.update(by_state)
    if not beam:
        raise RuntimeError("backward beam produced no encodable state")
    return max(beam, key=lambda node: _node_rank(node, layout, salt))


def _scramble_family(
    layout: SolvedLayout,
    state: PuzzleState,
    route: tuple[InverseEdge, ...],
) -> BeamNode:
    """Execute a family's declarative plan only through verified predecessors."""

    edges = list(route)
    labels: list[str] = []
    directions: list[tuple[int, int]] = []
    walk_count = len(route)
    trails: dict[str, list[Coord]] = {
        item.id: [item.position]
        for item in state.objects
    }
    socket_positions = {
        cell.fixture.id: layout.level.coord(index)
        for index, cell in enumerate(layout.level.cells)
        if cell.fixture is not None and cell.fixture.kind == "socket"
    }
    for installed in state.installed_cells:
        trails.setdefault(installed.object_id, [socket_positions[installed.socket_id]])

    for step in layout.reverse_steps:
        if isinstance(step, ReverseUndock):
            edge = next(
                (
                    candidate
                    for candidate in dock_predecessors(layout.level, state)
                    if candidate.object_id == step.object_id
                    and candidate.action == step.forward_action
                ),
                None,
            )
            if edge is None:
                raise RuntimeError(
                    f"{layout.family_id}: cannot reverse dock {step.object_id} via {step.forward_action}"
                )
            edges.append(edge)
            state = edge.predecessor
            restored = next(item for item in state.objects if item.id == step.object_id)
            trails.setdefault(step.object_id, []).append(restored.position)
            labels.append(step.object_id)
            action_delta = {
                "N": (0, 1),
                "E": (-1, 0),
                "S": (0, -1),
                "W": (1, 0),
            }[step.forward_action]
            directions.append(action_delta)
            continue

        if isinstance(step, ReversePlayerMove):
            edge = predecessor_with_player(layout.level, state, step.predecessor_player)
            if edge is None:
                raise RuntimeError(
                    f"{layout.family_id}: cannot reverse player move to {step.predecessor_player}"
                )
            edges.append(edge)
            state = edge.predecessor
            walk_count += 1
            continue

        if not isinstance(step, ReverseObjectRoute):
            raise TypeError(f"{layout.family_id}: unknown reverse-plan step {type(step).__name__}")
        moved = next((item for item in state.objects if item.id == step.object_id), None)
        if moved is None:
            raise RuntimeError(f"{layout.family_id}: route object {step.object_id} is absent")
        if moved.position != step.forward_path[-1]:
            raise RuntimeError(
                f"{layout.family_id}: {step.object_id} route ends at {step.forward_path[-1]}, "
                f"but solved object is at {moved.position}"
            )
        for predecessor_position in reversed(step.forward_path[:-1]):
            current_position = next(
                item.position for item in state.objects if item.id == step.object_id
            )
            dx = predecessor_position.x - current_position.x
            dy = predecessor_position.y - current_position.y
            walk = _inverse_walk_path(layout.level, state, predecessor_position, max_states=4096)
            if walk is None:
                raise RuntimeError(
                    f"{layout.family_id}: cannot reach reverse stance for "
                    f"{step.object_id} at {predecessor_position}"
                )
            if walk:
                edges.extend(walk)
                walk_count += len(walk)
                state = walk[-1].predecessor
            pull = pull_predecessor(layout.level, state, step.object_id, dx, dy)
            if pull is None:
                raise RuntimeError(
                    f"{layout.family_id}: verified reverse pull failed for {step.object_id}"
                )
            edges.append(pull)
            state = pull.predecessor
            labels.append(step.object_id)
            directions.append((dx, dy))
            trails.setdefault(step.object_id, []).append(predecessor_position)

    actual = {item.id: item.position for item in state.objects}
    expected = dict(layout.expected_start_positions)
    if actual != expected:
        raise AssertionError(
            f"{layout.family_id}: reverse endpoint {actual!r} does not match expected {expected!r}"
        )
    return BeamNode(
        state,
        tuple(edges),
        tuple(tuple(trails[item.id]) for item in state.objects),
        tuple(labels),
        tuple(directions),
        walk_count,
    )


def _scramble_causal(
    layout: SolvedLayout,
    state: PuzzleState,
    route: tuple[InverseEdge, ...],
) -> BeamNode:
    assert layout.causal_start_positions is not None
    temp = next(
        layout.level.coord(index)
        for index, cell in enumerate(layout.level.cells)
        if cell.fixture is not None and cell.fixture.id == "plate-0"
    )
    final_a, final_b = layout.plates
    start_a, start_b = layout.causal_start_positions
    full_b_path = [
        Coord(5, 6), Coord(6, 6), Coord(7, 6), Coord(8, 6),
        Coord(8, 5), Coord(8, 4),
        Coord(9, 4), Coord(10, 4), Coord(11, 4),
        Coord(11, 5), Coord(11, 6), Coord(12, 6), Coord(13, 6),
        Coord(13, 5), Coord(13, 4), Coord(13, 3),
    ]
    b_path = full_b_path[: full_b_path.index(final_b) + 1]
    a_first = [Coord(3, y) for y in range(start_a.y, temp.y - 1, -1)]
    a_second = [temp, final_a]

    edges = list(route)
    labels: list[str] = []
    directions: list[tuple[int, int]] = []
    trails: dict[str, list[Coord]] = {
        "cargo-0": [next(
            layout.level.coord(index)
            for index, cell in enumerate(layout.level.cells)
            if cell.fixture is not None and cell.fixture.id == "socket-0"
        )],
        "cargo-1": [final_b],
    }
    walk_count = len(route)

    def reverse_object_path(object_id: str, forward_path: list[Coord]) -> None:
        nonlocal state, walk_count
        for predecessor_position in reversed(forward_path[:-1]):
            current_position = next(item.position for item in state.objects if item.id == object_id)
            dx = predecessor_position.x - current_position.x
            dy = predecessor_position.y - current_position.y
            walk = _inverse_walk_path(layout.level, state, predecessor_position, max_states=2048)
            if walk is None:
                raise RuntimeError(f"cannot reach reverse stance for {object_id} at {predecessor_position}")
            if walk:
                edges.extend(walk)
                walk_count += len(walk)
                state = walk[-1].predecessor
            pull = pull_predecessor(layout.level, state, object_id, dx, dy)
            if pull is None:
                raise RuntimeError(f"causal reverse pull failed for {object_id}")
            edges.append(pull)
            state = pull.predecessor
            labels.append(object_id)
            directions.append((dx, dy))
            trails[object_id].append(predecessor_position)

    dock = next(
        (
            edge
            for edge in dock_predecessors(layout.level, state)
            if edge.object_id == "cargo-0" and edge.action == "W"
        ),
        None,
    )
    if dock is None:
        raise RuntimeError("causal reverse socket undock failed")
    edges.append(dock)
    state = dock.predecessor
    trails["cargo-0"].append(final_a)

    # On high bands the docking stance is a relay.  Undo the entry that powers
    # the final door, making the generated initial relay state OFF.
    if layout.relay_id is not None:
        relay_entry = predecessor_with_player(layout.level, state, Coord(4, 5))
        if relay_entry is None:
            raise RuntimeError("causal reverse relay entry failed")
        edges.append(relay_entry)
        state = relay_entry.predecessor
        walk_count += 1

    reverse_object_path("cargo-0", a_second)
    reverse_object_path("cargo-1", b_path)
    reverse_object_path("cargo-0", a_first)
    if tuple(item.position for item in state.objects) != layout.causal_start_positions:
        raise AssertionError("causal reverse endpoint missed its intended starts")
    return BeamNode(
        state,
        tuple(edges),
        tuple(tuple(trails[item.id]) for item in state.objects),
        tuple(labels),
        tuple(directions),
        walk_count,
    )


def generate_candidate(
    difficulty: int,
    master_seed: str,
    candidate_id: int = 0,
    *,
    layout_family: LayoutFamily | None = None,
) -> Candidate:
    if not 0 <= difficulty <= 8:
        raise ValueError("difficulty must be 0..8")
    seed = derive_seed(master_seed, difficulty, candidate_id)
    rng = Random(seed)
    mission = synthesize_mission(difficulty, rng)
    selected_family = layout_family
    if selected_family is None and difficulty >= 3:
        # Import locally so the registry can import family modules without
        # making search.py and layout_registry.py a module-import cycle.
        from .layout_registry import family_for_candidate

        selected_family = family_for_candidate(difficulty, candidate_id)
    if selected_family is None:
        layout = build_solved_layout(mission, rng)
    else:
        if selected_family.target_difficulty != difficulty:
            raise ValueError(
                f"layout family {selected_family.id} targets difficulty "
                f"{selected_family.target_difficulty}, not {difficulty}"
            )
        layout = selected_family.build(rng)
        validate_family_layout(selected_family, layout)
    scrambled = _scramble(layout, difficulty, rng, seed)
    level = layout.level.with_start(scrambled.state)
    assert_valid_level(level)
    if canonical_state_key(initial_state(level)) != canonical_state_key(scrambled.state):
        raise AssertionError("backward endpoint is not exactly encodable as LevelDefinition")

    reverse_actions = tuple(edge.action for edge in scrambled.edges)
    witness = (*reversed(reverse_actions), layout.gate_action)
    final, transitions = replay(level, witness)
    if final.outcome.kind != "victory" or len(transitions) != len(witness) or not all(item.accepted for item in transitions):
        raise AssertionError("constructive witness failed full Python replay")
    metrics = witness_metrics(level, witness)
    metrics.update({
        "requestedDifficulty": difficulty,
        "reversePushes": len(scrambled.pull_labels),
        "reverseWalks": scrambled.walk_count,
        "causalShape": mission.shape,
    })
    digest = canonical_level_hash(level)
    milestones = (
        layout.milestone_specs
        if layout.milestone_specs
        else _candidate_milestones(level, mission, layout.plates, layout.relay_id)
    )
    return Candidate(
        id=f"brain-d{difficulty}-{digest[:16]}",
        difficulty=difficulty,
        level=level,
        witness=tuple(witness),
        mission=mission,
        milestones=milestones,
        metrics=metrics,
        master_seed=master_seed.lower(),
        candidate_id=candidate_id,
        reverse_actions=reverse_actions,
        layout_family_id=layout.family_id,
        precedence=layout.required_precedence,
    )


def _candidate_milestones(
    level: Level,
    mission: MissionGraph,
    plates: tuple[Coord, ...],
    relay_id: str | None,
) -> tuple[dict[str, Any], ...]:
    """Emit only milestones with a structural lower-bound argument.

    There are exactly as many cargo objects as plates and all cargo starts off
    every plate.  Thus every object must be pushed at least its Manhattan
    distance to the nearest plate in any solution.  Occurrence milestones up
    to that bound cannot be witness padding.  The TypeScript analyzer still
    proves mandatory membership and precedence independently.
    """

    if any(cell.fixture is not None and cell.fixture.id == "socket-0" for cell in level.cells):
        return _causal_milestones(level, mission.difficulty)

    result: list[dict[str, Any]] = []
    # The bounded occurrence-history monitor supports at most 16 instances.
    door_ids = [
        cell.fixture.id
        for cell in level.cells
        if cell.fixture is not None and cell.fixture.kind == "door"
    ]
    # Orientation/cadet/technician boards use only pushing plus momentary
    # circuit families.  Door references live in true after-state guards, so
    # direct-element auditing does not inflate the rated family count.
    include_pushes = mission.difficulty >= 1
    reserved = len(plates) + 1
    budget = 16 - reserved
    target_depth = 2 + int(1.2 * mission.difficulty)
    object_bounds = sorted((
        (min(
            abs(item.position.x - plate.x) + abs(item.position.y - plate.y)
            for plate in plates
        ), item)
        for item in level.objects
    ), key=lambda value: (-value[0], value[1].id))
    for lower_bound, item in object_bounds if include_pushes else ():
        occurrence_limit = 1 if mission.difficulty == 1 else target_depth - 1
        for occurrence in range(1, min(lower_bound, occurrence_limit) + 1):
            if budget <= 0:
                break
            result.append({
                "schemaVersion": "milestone-dsl-v1",
                "id": f"push-{item.id}-{occurrence}",
                "family": "pushing",
                "trigger": {"event": "object-pushed", "objectId": item.id},
                "occurrence": occurrence,
            })
            budget -= 1
    source_ids: list[str] = []
    for index, plate in enumerate(plates):
        source_id = f"momentary-source-{index}"
        source_ids.append(source_id)
        predicates: list[dict[str, Any]] = [{
            "afterState": {"consumerState": {"fixtureId": f"door-{index}", "powered": True}},
        }]
        predicates.append({
            "any": [
                {"afterState": {"entityAt": {"entityId": item.id, "position": plate.to_json()}}}
                for item in level.objects
            ],
        })
        result.append({
            "schemaVersion": "milestone-dsl-v1",
            "id": source_id,
            "family": "momentary-circuit",
            "trigger": {"event": "source-changed", "fixtureId": f"plate-{index}", "active": True},
            "guard": {"all": predicates},
            "occurrence": 1,
        })
    result.append({
        "schemaVersion": "milestone-dsl-v1",
        "id": "evacuate",
        "family": "evacuation",
        "trigger": {"event": "gate-entered", "fixtureId": "gate-0"},
        "occurrence": 1,
    })
    circuit_ids = set(source_ids)
    push_ids = {str(item["id"]) for item in result if str(item["id"]).startswith("push-")}
    for item in result:
        item_id = str(item["id"])
        if item_id in circuit_ids:
            item["coEmitsWith"] = sorted((circuit_ids - {item_id}) | push_ids)
        elif item_id in push_ids:
            item["coEmitsWith"] = sorted(circuit_ids)
    return tuple(result)


def _causal_milestones(level: Level, difficulty: int) -> tuple[dict[str, Any], ...]:
    positions = {
        cell.fixture.id: level.coord(index)
        for index, cell in enumerate(level.cells)
        if cell.fixture is not None
    }
    temp = positions["plate-0"]
    b_final = positions["plate-1"]
    full_b_path = [
        Coord(5, 6), Coord(6, 6), Coord(7, 6), Coord(8, 6),
        Coord(8, 5), Coord(8, 4),
        Coord(9, 4), Coord(10, 4), Coord(11, 4),
        Coord(11, 5), Coord(11, 6), Coord(12, 6), Coord(13, 6),
        Coord(13, 5), Coord(13, 4), Coord(13, 3),
    ]
    b_path = full_b_path[: full_b_path.index(b_final) + 1]

    high = "relay-0" in positions
    extra_count = {3: 1, 4: 2, 5: 4, 6: 5, 7: 6, 8: 7}[difficulty]
    candidates = b_path[1:-1]
    if extra_count > 0:
        indexes = sorted({round(index * (len(candidates) - 1) / max(1, extra_count - 1)) for index in range(extra_count)})
        selected = [candidates[index] for index in indexes]
        while len(selected) < extra_count:
            selected.append(next(position for position in candidates if position not in selected))
    else:
        selected = []

    specs: list[dict[str, Any]] = []
    def event_spec(identifier: str, family: str, event: str, **fields: Any) -> dict[str, Any]:
        return {
            "schemaVersion": "milestone-dsl-v1",
            "id": identifier,
            "family": family,
            "trigger": {"event": event, **fields},
            "occurrence": 1,
        }
    specs.extend((
        event_spec("a-temp", "pushing", "object-pushed", objectId="cargo-0", to=temp.to_json()),
        event_spec("temp-source", "momentary-circuit", "source-changed", fixtureId="plate-0", active=True),
        event_spec("bridge-0-open", "consumers", "consumer-changed", fixtureId="bridge-0", powered=True),
    ))
    for index, position in enumerate(selected, 1):
        specs.append(event_spec(f"b-step-{index}", "pushing", "object-pushed", objectId="cargo-1", to=position.to_json()))
    b_source = event_spec("b-source", "momentary-circuit", "source-changed", fixtureId="plate-1", active=True)
    b_source["guard"] = {"all": [
        {"afterState": {"entityAt": {"entityId": "cargo-1", "position": b_final.to_json()}}},
        {"afterState": {"consumerState": {"fixtureId": "door-1", "powered": True}}},
    ]}
    specs.extend((
        b_source,
        event_spec("a-release", "pushing", "object-pushed", objectId="cargo-0", **{"from": temp.to_json()}),
        event_spec(
            "a-final",
            "permanent-sources",
            "socket-docked",
            fixtureId="socket-0",
            objectId="cargo-0",
            position=positions["socket-0"].to_json(),
        ),
    ))
    if high:
        relay = event_spec("relay-on", "permanent-sources", "relay-toggled", fixtureId="relay-0", active=True)
        relay["guard"] = {
            "afterState": {"consumerState": {"fixtureId": "door-2", "powered": True}},
        }
        specs.append(relay)
    specs.append(event_spec("evacuate", "evacuation", "gate-entered", fixtureId="gate-0"))
    if len(specs) > 16:
        raise AssertionError("causal milestone monitor budget exceeded")

    groups = [
        {"a-temp", "temp-source", "bridge-0-open"},
    ]
    by_id = {str(spec["id"]): spec for spec in specs}
    for group in groups:
        for identifier in group:
            by_id[identifier]["coEmitsWith"] = sorted(group - {identifier})
    return tuple(specs)
