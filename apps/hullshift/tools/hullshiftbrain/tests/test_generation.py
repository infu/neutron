import json

from hullshiftbrain.canonical import canonical_state_key
import hullshiftbrain.parallel as parallel
from hullshiftbrain.parallel import GenerationTask, generate_tasks
from hullshiftbrain.rules import initial_state, replay
from hullshiftbrain.search import generate_candidate


def test_candidate_is_deterministic_encodable_and_solvable() -> None:
    left = generate_candidate(4, "determinism", 7)
    right = generate_candidate(4, "determinism", 7)
    assert left.to_record() == right.to_record()
    assert canonical_state_key(initial_state(left.level)) == canonical_state_key(initial_state(right.level))
    final, results = replay(left.level, left.witness)
    assert final.outcome.kind == "victory"
    assert len(results) == len(left.witness)
    assert all(result.accepted for result in results)


def test_worker_count_does_not_change_candidate_bytes() -> None:
    tasks = [GenerationTask(0, 0, "workers"), GenerationTask(0, 1, "workers")]
    serial = [item.to_record() for item in generate_tasks(tasks, workers=1)]
    parallel = [item.to_record() for item in generate_tasks(tasks, workers=2)]
    assert serial == parallel


def test_structural_budget_rises_without_piece_inflation() -> None:
    low = generate_candidate(0, "bands", 0)
    high = generate_candidate(8, "bands", 0)
    assert high.metrics["pushes"] > low.metrics["pushes"]
    assert high.metrics["objectAlternations"] > low.metrics["objectAlternations"]
    assert len(high.level.objects) <= 3
    assert len(high.milestones) <= 16


def test_generation_checkpoints_fixed_batches_and_resumes_byte_identically(
    tmp_path, monkeypatch
) -> None:
    class FakeCandidate:
        def __init__(self, task: GenerationTask) -> None:
            self.task = task

        def to_record(self):
            return {
                "id": f"fake-{self.task.difficulty}-{self.task.candidate_id}",
                "difficulty": self.task.difficulty,
                "provenance": {"candidateId": str(self.task.candidate_id)},
                "metrics": {},
                "milestones": [],
            }

    calls = 0

    def interrupted(tasks, *, workers):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("simulated interruption")
        return [FakeCandidate(task) for task in tasks]

    monkeypatch.setattr(parallel, "GENERATION_BATCH_SIZE", 2)
    monkeypatch.setattr(parallel, "generate_tasks", interrupted)
    run_dir = tmp_path / "interrupted"
    try:
        parallel.run_generation(
            run_dir,
            bands=(0,),
            candidates_per_band=5,
            master_seed="0123456789abcdef",
            workers=64,
        )
    except RuntimeError as reason:
        assert str(reason) == "simulated interruption"
    else:
        raise AssertionError("interruption was not raised")
    assert len(parallel.load_jsonl(run_dir / "candidates.jsonl")) == 2
    assert len(json.loads((run_dir / "checkpoint.json").read_text())["completed"]) == 2

    def complete(tasks, *, workers):
        return [FakeCandidate(task) for task in tasks]

    monkeypatch.setattr(parallel, "generate_tasks", complete)
    resumed = parallel.run_generation(
        run_dir,
        bands=(0,),
        candidates_per_band=5,
        master_seed="0123456789abcdef",
        workers=1,
        resume=True,
    )
    clean_dir = tmp_path / "clean"
    parallel.run_generation(
        clean_dir,
        bands=(0,),
        candidates_per_band=5,
        master_seed="0123456789abcdef",
        workers=3,
    )
    assert len(resumed) == 5
    assert (run_dir / "candidates.jsonl").read_bytes() == (
        clean_dir / "candidates.jsonl"
    ).read_bytes()
