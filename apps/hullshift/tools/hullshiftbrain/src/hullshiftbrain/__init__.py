"""HullshiftBrain's deterministic offline generation API."""

from .canonical import canonical_level_hash, canonical_state_key
from .schema import Level, PuzzleState, level_from_json, level_to_json
from .search import Candidate, generate_candidate

__all__ = [
    "Candidate",
    "Level",
    "PuzzleState",
    "canonical_level_hash",
    "canonical_state_key",
    "generate_candidate",
    "level_from_json",
    "level_to_json",
]

__version__ = "0.1.0"

