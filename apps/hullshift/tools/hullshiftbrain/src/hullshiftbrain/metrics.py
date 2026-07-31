"""Cheap, versioned proposal metrics.

These are funnel signals, not claims about human difficulty.  Catalog release
uses the production exact analyzer and calibrated gates.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from itertools import combinations
from math import comb
from typing import Any, Iterable

from .rules import replay
from .schema import Direction, Level


def _switches(values: Iterable[str]) -> int:
    result = 0
    previous: str | None = None
    for value in values:
        if previous is not None and value != previous:
            result += 1
        previous = value
    return result


def balanced_decomposition_cost(labels: tuple[str, ...]) -> int:
    """Witness proxy for the exact balanced two-group ``Z`` measure."""

    counts = Counter(labels)
    recurring = tuple(sorted(label for label, count in counts.items() if count >= 2))
    if len(recurring) < 2:
        return 0
    left_size = len(recurring) // 2
    # Complementary partitions are equivalent; pin the first label left.
    partitions = (
        (recurring[0], *rest)
        for rest in combinations(recurring[1:], max(0, left_size - 1))
    )
    best: int | None = None
    recurring_set = set(recurring)
    for left_values in partitions:
        left = set(left_values)
        grouped = tuple("L" if label in left else "R" for label in labels if label in recurring_set)
        cost = _switches(grouped)
        best = cost if best is None else min(best, cost)
    return best or 0


def witness_metrics(level: Level, witness: tuple[Direction, ...]) -> dict[str, Any]:
    final, transitions = replay(level, witness)
    accepted = [item for item in transitions if item.accepted]
    push_events = [
        event
        for item in accepted
        for event in item.events
        if event["type"] == "object-pushed"
    ]
    labels = tuple(str(event["objectId"]) for event in push_events)
    directions = tuple(item.action for item in accepted if item.pushed)
    positions = {item.id: item.position for item in final.state.objects}
    non_progress = 0
    per_object_directions: dict[str, list[Direction]] = defaultdict(list)
    for transition_result in accepted:
        event = next((event for event in transition_result.events if event["type"] == "object-pushed"), None)
        if event is None:
            continue
        object_id = str(event["objectId"])
        per_object_directions[object_id].append(transition_result.action)
        target = positions.get(object_id)
        if target is None:
            continue
        before = event["from"]
        after = event["to"]
        old_distance = abs(int(before["x"]) - target.x) + abs(int(before["y"]) - target.y)
        new_distance = abs(int(after["x"]) - target.x) + abs(int(after["y"]) - target.y)
        if new_distance >= old_distance:
            non_progress += 1

    regrips = sum(_switches(value) for value in per_object_directions.values())
    direction_changes = _switches(tuple(item.action for item in accepted))
    consequence_flags = []
    for item in accepted:
        consequence_flags.append(any(
            event["type"] in (
                "object-pushed",
                "relay-toggled",
                "socket-docked",
                "fracture-collapsed",
                "object-removed",
                "gate-entered",
            )
            for event in item.events
        ))
    longest_neutral = current = 0
    for meaningful in consequence_flags:
        current = 0 if meaningful else current + 1
        longest_neutral = max(longest_neutral, current)
    interactive = len(level.objects) + sum(cell.fixture is not None for cell in level.cells) - 1
    commitments = len(push_events) + sum(
        event["type"] in ("relay-toggled", "socket-docked", "fracture-collapsed", "object-removed")
        for item in accepted
        for event in item.events
    )
    return {
        "scorerVersion": "brain-cheap-v1",
        "solvableByWitness": final.outcome.kind == "victory",
        "acceptedActions": len(accepted),
        "pushes": len(push_events),
        "commitments": commitments,
        "objectAlternations": _switches(labels),
        "balancedDecompositionProxy": balanced_decomposition_cost(labels),
        "counterintuitivePushProxy": non_progress,
        "turningRegrips": regrips,
        "directionChanges": direction_changes,
        "pushedObjects": len(set(labels)),
        "pushDirections": len(set(directions)),
        "longestConsequenceFreeRun": longest_neutral,
        "consequenceFreePermille": round(1000 * consequence_flags.count(False) / max(1, len(consequence_flags))),
        "interactiveElements": interactive,
        "logicDensityProxy": round(commitments / max(1, interactive), 4),
    }


def quality_vector(metrics: dict[str, Any]) -> tuple[float, ...]:
    """Pareto dimensions, all oriented so greater is better."""

    return (
        float(metrics.get("commitments", 0)),
        float(metrics.get("objectAlternations", 0)),
        float(metrics.get("balancedDecompositionProxy", 0)),
        float(metrics.get("counterintuitivePushProxy", 0)),
        float(metrics.get("turningRegrips", 0)),
        float(metrics.get("logicDensityProxy", 0)),
        -float(metrics.get("longestConsequenceFreeRun", 0)),
        -float(metrics.get("interactiveElements", 0)),
    )

