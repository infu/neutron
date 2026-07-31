"""Small deterministic constrained quality-diversity archive."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable

from .metrics import quality_vector


def dominates(left: tuple[float, ...], right: tuple[float, ...]) -> bool:
    return all(a >= b for a, b in zip(left, right)) and any(a > b for a, b in zip(left, right))


def niche_for(record: dict[str, Any]) -> tuple[str, str, str]:
    metrics = record.get("metrics", {})
    shape = str(metrics.get("causalShape", "unknown"))
    mechanics = "+".join(sorted({str(item.get("family", "unknown")) for item in record.get("milestones", [])}))
    z = int(metrics.get("balancedDecompositionProxy", 0))
    z_band = "z0" if z == 0 else "z1-3" if z <= 3 else "z4+"
    return shape, mechanics, z_band


@dataclass(slots=True)
class ParetoArchive:
    per_niche: int = 4
    _records: dict[tuple[str, str, str], list[dict[str, Any]]] = field(default_factory=dict)

    def add(self, record: dict[str, Any]) -> bool:
        niche = niche_for(record)
        candidates = self._records.setdefault(niche, [])
        vector = quality_vector(record.get("metrics", {}))
        if any(dominates(quality_vector(item.get("metrics", {})), vector) for item in candidates):
            return False
        candidates[:] = [
            item for item in candidates
            if not dominates(vector, quality_vector(item.get("metrics", {})))
            and item.get("id") != record.get("id")
        ]
        candidates.append(record)
        # Deterministic lexicographic Pareto tie-break, never a permanent scalar.
        candidates.sort(
            key=lambda item: (quality_vector(item.get("metrics", {})), str(item.get("id", ""))),
            reverse=True,
        )
        del candidates[self.per_niche :]
        return any(item.get("id") == record.get("id") for item in candidates)

    def records(self) -> list[dict[str, Any]]:
        return sorted(
            (item for values in self._records.values() for item in values),
            key=lambda item: (int(item.get("difficulty", -1)), str(item.get("id", ""))),
        )

    def summary(self) -> dict[str, Any]:
        niches = []
        for key in sorted(self._records):
            niches.append({"key": list(key), "entryIds": [item["id"] for item in self._records[key]]})
        return {"schemaVersion": "hullshiftbrain-archive-v1", "perNiche": self.per_niche, "niches": niches}


def build_archive(records: Iterable[dict[str, Any]], *, per_niche: int = 4) -> ParetoArchive:
    archive = ParetoArchive(per_niche)
    for record in sorted(records, key=lambda item: (int(item["difficulty"]), str(item["id"]))):
        archive.add(record)
    return archive

