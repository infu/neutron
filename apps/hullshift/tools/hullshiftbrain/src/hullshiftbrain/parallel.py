"""Schedule-independent process generation and checkpoint files."""

from __future__ import annotations

from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass
from itertools import batched
import json
import os
from pathlib import Path
from typing import Any, Iterable

from .archive import build_archive
from .search import BRAIN_VERSION, Candidate, generate_candidate


# Keep the number of uncheckpointed candidates and live futures bounded.  The
# value is deliberately independent of the worker count so resuming the same
# run partitions candidate ids identically on every machine.
GENERATION_BATCH_SIZE = 64


@dataclass(frozen=True, slots=True, order=True)
class GenerationTask:
    difficulty: int
    candidate_id: int
    master_seed: str


def _worker(task: GenerationTask) -> Candidate:
    os.environ.update({
        "OMP_NUM_THREADS": "1",
        "MKL_NUM_THREADS": "1",
        "OPENBLAS_NUM_THREADS": "1",
        "NUMEXPR_NUM_THREADS": "1",
    })
    return generate_candidate(task.difficulty, task.master_seed, task.candidate_id)


def generate_tasks(tasks: Iterable[GenerationTask], *, workers: int) -> list[Candidate]:
    ordered = sorted(tasks)
    if workers <= 1:
        result = [_worker(task) for task in ordered]
    else:
        result = []
        with ProcessPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(_worker, task): task for task in ordered}
            for future in as_completed(futures):
                result.append(future.result())
    return sorted(result, key=lambda item: (item.difficulty, item.candidate_id, item.id))


def _atomic_json(path: Path, value: Any) -> None:
    _atomic_bytes(
        path,
        (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode(),
    )


def _atomic_jsonl(path: Path, values: Iterable[dict[str, Any]]) -> None:
    _atomic_bytes(
        path,
        "".join(
            json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n"
            for value in values
        ).encode(),
    )


def _atomic_bytes(path: Path, value: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("wb") as handle:
        handle.write(value)
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def _record_key(record: dict[str, Any]) -> tuple[int, int, str]:
    return (
        int(record["difficulty"]),
        int(record["provenance"]["candidateId"]),
        str(record["id"]),
    )


def _checkpoint_generation(run_dir: Path, records: list[dict[str, Any]]) -> None:
    records.sort(key=_record_key)
    seen: set[tuple[int, int]] = set()
    for record in records:
        identity = _record_key(record)[:2]
        if identity in seen:
            raise ValueError(
                f"duplicate candidate result for difficulty={identity[0]} candidateId={identity[1]}"
            )
        seen.add(identity)

    _atomic_jsonl(run_dir / "candidates.jsonl", records)
    _atomic_json(run_dir / "archive.json", build_archive(records).summary())
    _atomic_json(run_dir / "checkpoint.json", {
        "schemaVersion": "hullshiftbrain-checkpoint-v1",
        "brainVersion": BRAIN_VERSION,
        "completed": [
            {
                "difficulty": item["difficulty"],
                "candidateId": item["provenance"]["candidateId"],
                "id": item["id"],
            }
            for item in records
        ],
    })


def run_generation(
    run_dir: Path,
    *,
    bands: tuple[int, ...],
    candidates_per_band: int,
    master_seed: str,
    workers: int,
    resume: bool = False,
) -> list[dict[str, Any]]:
    run_dir.mkdir(parents=True, exist_ok=True)
    config_path = run_dir / "run.json"
    config = {
        "schemaVersion": "hullshiftbrain-run-v1",
        "brainVersion": BRAIN_VERSION,
        "masterSeed": master_seed.lower(),
        "bands": list(bands),
        "candidatesPerBand": candidates_per_band,
    }
    if resume:
        if not config_path.exists():
            raise FileNotFoundError(f"missing run configuration: {config_path}")
        existing_config = json.loads(config_path.read_text())
        for key in ("brainVersion", "masterSeed", "bands", "candidatesPerBand"):
            if existing_config.get(key) != config.get(key):
                raise ValueError(f"resume configuration differs at {key}")
    else:
        _atomic_json(config_path, config)

    candidate_path = run_dir / "candidates.jsonl"
    records = load_jsonl(candidate_path)
    completed = {
        (int(item["difficulty"]), int(item.get("provenance", {}).get("candidateId", -1)))
        for item in records
    }
    tasks = (
        GenerationTask(band, candidate_id, master_seed.lower())
        for band in sorted(set(bands))
        for candidate_id in range(candidates_per_band)
        if (band, candidate_id) not in completed
    )
    wrote_checkpoint = False
    for task_batch in batched(tasks, GENERATION_BATCH_SIZE):
        generated = generate_tasks(task_batch, workers=workers)
        records.extend(candidate.to_record() for candidate in generated)
        _checkpoint_generation(run_dir, records)
        wrote_checkpoint = True
    if not wrote_checkpoint:
        # Refresh derived metadata after a clean resume and create an empty
        # checkpoint for a deliberately empty task set.
        _checkpoint_generation(run_dir, records)
    return records
