"""Deterministic registry for independently owned layout families."""

from __future__ import annotations

import hashlib
from importlib import import_module
from random import Random
from typing import Any

from .canonical import canonical_shape_signature, topology_signature
from .layout_family import (
    LayoutFamily,
    ReverseObjectRoute,
    ReverseUndock,
    SolvedLayout,
    validate_family_layout,
)


FAMILY_MODULES = (
    "hullshiftbrain.layouts.french_enfilade",
    "hullshiftbrain.layouts.us_freight_exchange",
    "hullshiftbrain.layouts.italian_piazza",
    "hullshiftbrain.layouts.japanese_interchange",
    "hullshiftbrain.layouts.brazilian_braided_plaza",
    "hullshiftbrain.layouts.greek_siatista",
)
MANAGED_DIFFICULTIES = frozenset(range(3, 9))

# Exact topology digests of the retired single-scaffold d3..d8 pilot.  A new
# family matching any of them is rejected even if it uses a new id or seed.
RETIRED_TOPOLOGY_SIGNATURES = frozenset({
    "ce539a196c69982d13ec",
    "efac14288657362c1d57",
    "424afb47be77831b6217",
    "b8fa52e2dc0469f7db72",
    "3dd15314d6f017ddefa0",
    "385bd6d44161b6a34c58",
})


def registered_families() -> tuple[LayoutFamily, ...]:
    families: list[LayoutFamily] = []
    for module_name in FAMILY_MODULES:
        module = import_module(module_name)
        family = getattr(module, "FAMILY", None)
        if not isinstance(family, LayoutFamily):
            raise TypeError(f"{module_name} must export FAMILY: LayoutFamily")
        families.append(family)
    families.sort(key=lambda item: (item.target_difficulty, item.id))
    _validate_metadata(families)
    return tuple(families)


def family_for_candidate(difficulty: int, candidate_id: int) -> LayoutFamily | None:
    """Choose within a band without coupling identity to process scheduling."""

    matching = [
        family for family in registered_families()
        if family.target_difficulty == difficulty
    ]
    if not matching:
        return None
    digest = hashlib.sha256(f"layout-family-v1\0{difficulty}\0{candidate_id}".encode()).digest()
    return matching[int.from_bytes(digest, "big") % len(matching)]


def build_registered_layout(
    difficulty: int,
    candidate_id: int,
    rng: Random,
) -> SolvedLayout | None:
    family = family_for_candidate(difficulty, candidate_id)
    if family is None:
        return None
    layout = family.build(rng)
    validate_family_layout(family, layout)
    return layout


def validate_registry_builds(seed: int = 0) -> tuple[dict[str, Any], ...]:
    """Build every family and reject pairwise topology reuse before search."""

    reports: list[dict[str, Any]] = []
    signatures: dict[str, str] = {}
    shape_signatures: dict[str, str] = {}
    for index, family in enumerate(registered_families()):
        layout = family.build(Random(seed + index))
        validate_family_layout(family, layout)
        signature = topology_signature(layout.level)
        if signature in RETIRED_TOPOLOGY_SIGNATURES:
            raise ValueError(
                f"layout family {family.id} reproduces a retired pilot topology {signature}"
            )
        incumbent = signatures.get(signature)
        if incumbent is not None:
            raise ValueError(
                f"layout families {incumbent} and {family.id} share topology {signature}"
            )
        signatures[signature] = family.id
        shape_signature = canonical_shape_signature(layout.level)
        shape_incumbent = shape_signatures.get(shape_signature)
        if shape_incumbent is not None:
            raise ValueError(
                f"layout families {shape_incumbent} and {family.id} are "
                f"padding/rotation/reflection reskins {shape_signature}"
            )
        shape_signatures[shape_signature] = family.id
        reports.append({
            "id": family.id,
            "persona": family.persona,
            "difficulty": family.target_difficulty,
            "topology": family.topology,
            "mechanicMotif": family.mechanic_motif,
            "topologySignature": signature,
            "shapeSignature": shape_signature,
            "width": layout.level.width,
            "height": layout.level.height,
            "playableCells": sum(
                cell.terrain != "bulkhead" for cell in layout.level.cells
            ),
            "objects": len(layout.expected_start_positions),
            "plannedPushes": sum(
                len(step.forward_path) - 1
                if isinstance(step, ReverseObjectRoute)
                else 1 if isinstance(step, ReverseUndock) else 0
                for step in layout.reverse_steps
            ),
            "reversePhases": len(layout.reverse_steps),
            "milestones": len(layout.milestone_specs),
        })
    return tuple(reports)


def _validate_metadata(families: list[LayoutFamily]) -> None:
    for attribute in ("id", "persona", "topology", "mechanic_motif"):
        values = [getattr(family, attribute) for family in families]
        if len(values) != len(set(values)):
            raise ValueError(f"layout registry repeats {attribute}")
    for family in families:
        if not family.id or not family.persona or not family.topology or not family.mechanic_motif:
            raise ValueError("layout family metadata cannot be empty")
        if not 0 <= family.target_difficulty <= 8:
            raise ValueError(f"layout family {family.id} has invalid difficulty")
    managed = [family.target_difficulty for family in families]
    if len(managed) != len(set(managed)) or set(managed) != MANAGED_DIFFICULTIES:
        raise ValueError(
            "independent layout families must cover difficulties 3..8 exactly once"
        )
