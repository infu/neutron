import json
from pathlib import Path

import pytest

from hullshiftbrain.cli import _parser, parse_master_seed


def test_cli_rejects_noncanonical_seeds_and_unsafe_counts() -> None:
    assert parse_master_seed("0123456789abcdef") == "0123456789abcdef"
    for value in ("short", "0123456789abcdeF", "g123456789abcdef", "0" * 65):
        with pytest.raises(Exception):
            parse_master_seed(value)

    parser = _parser()
    with pytest.raises(SystemExit):
        parser.parse_args([
            "generate",
            "--master-seed", "0123456789abcdef",
            "--run-dir", "/tmp/run",
            "--workers", "65",
        ])
    with pytest.raises(SystemExit):
        parser.parse_args([
            "generate",
            "--master-seed", "0123456789abcdef",
            "--run-dir", "/tmp/run",
            "--candidates-per-band", "0",
        ])


def test_proposal_schemas_close_trust_envelopes() -> None:
    schema_dir = Path(__file__).resolve().parents[1] / "schemas"
    candidate = json.loads((schema_dir / "hullshiftbrain-candidate-v1.schema.json").read_text())
    catalog = json.loads((schema_dir / "hullshiftbrain-catalog-v1.schema.json").read_text())
    assert candidate["additionalProperties"] is False
    assert candidate["$defs"]["level"]["additionalProperties"] is False
    assert candidate["$defs"]["milestone"]["additionalProperties"] is False
    assert candidate["$defs"]["provenance"]["additionalProperties"] is False
    assert candidate["$defs"]["metrics"]["additionalProperties"] is False
    assert catalog["additionalProperties"] is False
    assert catalog["properties"]["entries"]["items"]["additionalProperties"] is False
