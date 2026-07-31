"""Typed causal mission graph synthesis.

The graph is a construction target rather than a second win condition.  Exact
catalog certification is expected to reject an intended edge when a cheaper
forward solution bypasses it.
"""

from __future__ import annotations

from dataclasses import dataclass
from random import Random
from typing import Any, Literal

Persistence = Literal["reversible", "persistent", "irreversible"]


@dataclass(frozen=True, slots=True)
class MissionNode:
    id: str
    family: str
    resource: str
    persistence: Persistence
    role: str
    occurrence: int = 1

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "family": self.family,
            "resource": self.resource,
            "persistence": self.persistence,
            "role": self.role,
            "occurrence": self.occurrence,
        }


@dataclass(frozen=True, slots=True)
class MissionEdge:
    before: str
    after: str

    def to_json(self) -> dict[str, str]:
        return {"before": self.before, "after": self.after}


@dataclass(frozen=True, slots=True)
class MissionGraph:
    difficulty: int
    shape: str
    object_count: int
    nodes: tuple[MissionNode, ...]
    edges: tuple[MissionEdge, ...]

    def to_json(self) -> dict[str, Any]:
        return {
            "difficulty": self.difficulty,
            "shape": self.shape,
            "objectCount": self.object_count,
            "nodes": [node.to_json() for node in self.nodes],
            "edges": [edge.to_json() for edge in self.edges],
        }


def _check_acyclic(nodes: tuple[MissionNode, ...], edges: tuple[MissionEdge, ...]) -> None:
    ids = {node.id for node in nodes}
    if len(ids) != len(nodes):
        raise ValueError("duplicate mission node")
    if any(edge.before not in ids or edge.after not in ids for edge in edges):
        raise ValueError("mission edge references an unknown node")
    incoming = {node_id: 0 for node_id in ids}
    outgoing: dict[str, list[str]] = {node_id: [] for node_id in ids}
    for edge in edges:
        outgoing[edge.before].append(edge.after)
        incoming[edge.after] += 1
    ready = sorted(node_id for node_id, count in incoming.items() if count == 0)
    seen = 0
    while ready:
        node_id = ready.pop(0)
        seen += 1
        for target in sorted(outgoing[node_id]):
            incoming[target] -= 1
            if incoming[target] == 0:
                ready.append(target)
                ready.sort()
    if seen != len(nodes):
        raise ValueError("mission graph is cyclic")


def synthesize_mission(difficulty: int, rng: Random) -> MissionGraph:
    if not 0 <= difficulty <= 8:
        raise ValueError("difficulty must be 0..8")
    # Two movable resources are enough for dense interactions.  Bands 6+
    # add a mandatory relay source in layout rather than another box.
    object_count = min(2, 1 + difficulty // 2)
    if difficulty <= 2:
        shape = "chain"
    elif difficulty <= 5:
        shape = "branch-join" if rng.randrange(2) else "shared-bottleneck"
    else:
        shape = "revisit-heavy" if rng.randrange(2) else "shared-bottleneck"

    nodes: list[MissionNode] = []
    for index in range(object_count):
        nodes.append(MissionNode(f"stage-{index}", "cargo", f"cargo-{index}", "reversible", "shared-staging"))
        if difficulty >= 4:
            nodes.append(MissionNode(f"regrip-{index}", "cargo", f"cargo-{index}", "reversible", "return", 2))
        nodes.append(MissionNode(f"power-{index}", "plate", f"plate-{index}", "persistent", "corridor-cut"))
    nodes.append(MissionNode("evacuate", "gate", "gate-0", "irreversible", "final-gate"))

    # The initial graph is deliberately conservative.  Search later rewrites
    # its plate ordering from the verified constructive witness.
    edges: list[MissionEdge] = []
    for index in range(object_count):
        edges.append(MissionEdge(f"stage-{index}", f"power-{index}"))
        if difficulty >= 4:
            edges.append(MissionEdge(f"stage-{index}", f"regrip-{index}"))
            edges.append(MissionEdge(f"regrip-{index}", f"power-{index}"))
        edges.append(MissionEdge(f"power-{index}", "evacuate"))
    if shape in ("shared-bottleneck", "revisit-heavy"):
        for index in range(object_count - 1):
            edges.append(MissionEdge(f"stage-{index}", f"stage-{index + 1}"))
    graph = MissionGraph(difficulty, shape, object_count, tuple(nodes), tuple(edges))
    _check_acyclic(graph.nodes, graph.edges)
    return graph


def milestones_for_graph(graph: MissionGraph) -> list[dict[str, Any]]:
    """Emit the event/delta-anchored milestone-dsl-v1 interchange form."""

    result: list[dict[str, Any]] = []
    for node in graph.nodes:
        if node.id.startswith("stage-") or node.id.startswith("regrip-"):
            index = node.resource.removeprefix("cargo-")
            result.append({
                "schemaVersion": "milestone-dsl-v1",
                "id": node.id,
                "family": "pushing",
                "trigger": {"event": "object-pushed", "objectId": f"cargo-{index}"},
                "occurrence": node.occurrence,
            })
        elif node.id.startswith("power-"):
            index = node.resource.removeprefix("plate-")
            result.append({
                "schemaVersion": "milestone-dsl-v1",
                "id": node.id,
                "family": "momentary-circuit",
                "trigger": {"event": "source-changed", "fixtureId": f"plate-{index}", "active": True},
                "occurrence": 1,
            })
        elif node.id == "evacuate":
            result.append({
                "schemaVersion": "milestone-dsl-v1",
                "id": node.id,
                "family": "evacuation",
                "trigger": {"event": "gate-entered", "fixtureId": "gate-0"},
                "occurrence": 1,
            })
    return result
