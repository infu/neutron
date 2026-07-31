"""Compact catalog selection, export, and reproduction manifest."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any, Iterable

from .search import BRAIN_VERSION


def _atomic_write(path: Path, encoded: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("wb") as handle:
        handle.write(encoded)
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)


def _rank(record: dict[str, Any]) -> tuple[Any, ...]:
    metrics = record.get("metrics", {})
    return (
        int(metrics.get("balancedDecompositionProxy", 0)),
        int(metrics.get("counterintuitivePushProxy", 0)),
        int(metrics.get("objectAlternations", 0)),
        int(metrics.get("turningRegrips", 0)),
        float(metrics.get("logicDensityProxy", 0)),
        -int(metrics.get("longestConsequenceFreeRun", 0)),
        str(record.get("id", "")),
    )


def make_catalog(records: Iterable[dict[str, Any]], *, per_band: int | None = None) -> dict[str, Any]:
    by_band: dict[int, list[dict[str, Any]]] = {difficulty: [] for difficulty in range(9)}
    seen: set[str] = set()
    for record in records:
        signature = str(record.get("semanticSignature") or record.get("canonicalLevelHash") or record["id"])
        if signature in seen:
            continue
        seen.add(signature)
        by_band[int(record["difficulty"])].append(record)
    entries: list[dict[str, Any]] = []
    for difficulty in range(9):
        ranked = sorted(by_band[difficulty], key=_rank, reverse=True)
        if per_band is not None:
            ranked = ranked[:per_band]
        for record in ranked:
            entries.append({
                "id": record["id"],
                "difficulty": record["difficulty"],
                "level": record["level"],
                "witness": record["witness"],
                "milestones": record.get("milestones", []),
                "requiredPrecedence": record.get("requiredPrecedence", []),
                "provenance": record.get("provenance", {}),
                "topologySignature": record.get("topologySignature", ""),
                "semanticSignature": record.get("semanticSignature", ""),
                **({"metrics": record["metrics"]} if "metrics" in record else {}),
            })
    entries.sort(key=lambda item: (int(item["difficulty"]), str(item["id"])))
    return {
        "schemaVersion": "hullshiftbrain-catalog-v1",
        "generatorVersion": "g4",
        "brainVersion": BRAIN_VERSION,
        "entries": entries,
    }


def export_catalog(
    records: Iterable[dict[str, Any]],
    output: Path,
    *,
    per_band: int | None = None,
    manifest_output: Path | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    catalog = make_catalog(records, per_band=per_band)
    encoded = (json.dumps(catalog, sort_keys=True, separators=(",", ":")) + "\n").encode()
    _atomic_write(output, encoded)
    manifest = {
        "schemaVersion": "hullshiftbrain-manifest-v1",
        "brainVersion": BRAIN_VERSION,
        "generatorVersion": "g4",
        "catalogSha256": hashlib.sha256(encoded).hexdigest(),
        "entryCount": len(catalog["entries"]),
        "entries": [
            {
                "id": item["id"],
                "difficulty": item["difficulty"],
                "masterSeed": item.get("provenance", {}).get("masterSeed"),
                "candidateId": item.get("provenance", {}).get("candidateId"),
            }
            for item in catalog["entries"]
        ],
    }
    manifest_output = manifest_output or output.with_name(output.stem + ".manifest.json")
    _atomic_write(
        manifest_output,
        (json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n").encode(),
    )
    return catalog, manifest
