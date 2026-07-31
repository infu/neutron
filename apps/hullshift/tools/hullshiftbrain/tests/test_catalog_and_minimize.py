from dataclasses import replace

import json

from hullshiftbrain.catalog import export_catalog, make_catalog
from hullshiftbrain.minimize import minimize_level
from hullshiftbrain.rules import replay
from hullshiftbrain.schema import Cell, Fixture
from hullshiftbrain.search import generate_candidate


def test_catalog_envelope_and_entry_contract() -> None:
    candidate = generate_candidate(0, "catalog", 0)
    catalog = make_catalog([candidate.to_record()], per_band=1)
    assert catalog["schemaVersion"] == "hullshiftbrain-catalog-v1"
    assert catalog["generatorVersion"] == "g4"
    entry = catalog["entries"][0]
    assert entry["provenance"]["candidateId"] == "0"
    assert entry["requiredPrecedence"]
    assert entry["topologySignature"]


def test_catalog_and_manifest_are_complete_atomic_outputs(tmp_path) -> None:
    candidate = generate_candidate(0, "0123456789abcdef", 0)
    output = tmp_path / "nested" / "catalog.json"
    manifest_output = tmp_path / "manifest" / "catalog.manifest.json"
    catalog, manifest = export_catalog(
        [candidate.to_record()],
        output,
        per_band=1,
        manifest_output=manifest_output,
    )
    assert json.loads(output.read_text()) == catalog
    assert json.loads(manifest_output.read_text()) == manifest
    assert not output.with_suffix(".json.tmp").exists()
    assert not manifest_output.with_suffix(".json.tmp").exists()


def test_unused_fixture_is_ablated_at_fixed_point() -> None:
    candidate = generate_candidate(0, "minimize", 0)
    level = candidate.level
    final, transitions = replay(level, candidate.witness)
    visited = {
        result.after.state.player
        for result in transitions
        if result.after.state.player is not None
    }
    index = next(
        index
        for index, cell in enumerate(level.cells)
        if cell.terrain == "floor"
        and cell.fixture is None
        and level.coord(index) not in visited
        and all(item.position != level.coord(index) for item in level.objects)
    )
    cells = list(level.cells)
    cells[index] = Cell("floor", Fixture("unused-relay", "relay", "c0", initial_on=False))
    bloated = replace(level, cells=tuple(cells))
    result = minimize_level(bloated, candidate.witness)
    assert "fixture:unused-relay" in result.removed
    assert all(cell.fixture is None or cell.fixture.id != "unused-relay" for cell in result.level.cells)
