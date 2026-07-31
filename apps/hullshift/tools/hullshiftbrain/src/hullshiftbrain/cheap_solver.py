"""Small bounded forward oracle used only in the inexpensive funnel."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass

from .canonical import canonical_state_key
from .rules import initial_snapshot, transition
from .schema import DIRECTIONS, Direction, Level


@dataclass(frozen=True, slots=True)
class SolveResult:
    solved: bool
    actions: tuple[Direction, ...] | None
    states: int
    transitions: int
    exhausted: bool


def solve(level: Level, *, max_states: int = 25_000, max_depth: int = 160) -> SolveResult:
    start = initial_snapshot(level)
    key = canonical_state_key(start.state)
    queue = deque([(start, tuple())])
    seen = {key}
    transition_count = 0
    while queue:
        current, path = queue.popleft()
        if len(path) >= max_depth:
            continue
        for action in DIRECTIONS:
            result = transition(level, current, action)
            if not result.accepted:
                continue
            transition_count += 1
            if result.after.outcome.kind == "victory":
                return SolveResult(True, (*path, action), len(seen), transition_count, False)
            if result.after.outcome.kind != "playing":
                continue
            successor_key = canonical_state_key(result.after.state)
            if successor_key in seen:
                continue
            if len(seen) >= max_states:
                return SolveResult(False, None, len(seen), transition_count, True)
            seen.add(successor_key)
            queue.append((result.after, (*path, action)))
    return SolveResult(False, None, len(seen), transition_count, False)

