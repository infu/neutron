from __future__ import annotations

from hullshiftbrain.canonical import canonical_shape_signature, topology_signature
from hullshiftbrain.layout_registry import (
    MANAGED_DIFFICULTIES,
    RETIRED_TOPOLOGY_SIGNATURES,
    registered_families,
    validate_registry_builds,
)
from hullshiftbrain.rules import replay
from hullshiftbrain.search import generate_candidate


EXPECTED_FAMILIES = {
    3: ("us-freight-exchange", "US UX designer"),
    4: ("italian-piazza", "Italian UX designer"),
    5: ("french-enfilade", "French UX designer"),
    6: ("japanese-interchange", "Japanese UX designer"),
    7: ("brazilian-braided-plaza", "Brazilian UX designer"),
    8: ("greek-siatista", "Greek Siatista UX developer"),
}


def test_registry_has_one_independent_family_per_managed_band() -> None:
    families = registered_families()
    assert {family.target_difficulty for family in families} == MANAGED_DIFFICULTIES
    assert {
        family.target_difficulty: (family.id, family.persona)
        for family in families
    } == EXPECTED_FAMILIES

    reports = validate_registry_builds(seed=0)
    assert len(reports) == 6
    assert len({report["topology"] for report in reports}) == 6
    assert len({report["topologySignature"] for report in reports}) == 6
    assert len({report["shapeSignature"] for report in reports}) == 6
    assert all(
        report["topologySignature"] not in RETIRED_TOPOLOGY_SIGNATURES
        for report in reports
    )


def test_every_family_reverse_plan_produces_a_playable_solution() -> None:
    for family in registered_families():
        candidate = generate_candidate(
            family.target_difficulty,
            "layout-registry",
            0,
            layout_family=family,
        )
        final, transitions = replay(candidate.level, candidate.witness)
        assert final.outcome.kind == "victory", family.id
        assert transitions and all(item.accepted for item in transitions), family.id
        assert candidate.layout_family_id == family.id
        assert candidate.provenance()["algorithmVersion"].endswith(f".{family.id}")
        assert topology_signature(candidate.level) not in RETIRED_TOPOLOGY_SIGNATURES
        assert canonical_shape_signature(candidate.level)


def test_default_generation_routes_managed_bands_through_registry() -> None:
    for difficulty, (family_id, _) in EXPECTED_FAMILIES.items():
        candidate = generate_candidate(difficulty, "registered-default", 0)
        assert candidate.layout_family_id == family_id

    assert generate_candidate(2, "registered-default", 0).layout_family_id == "legacy"
