"""Command-line entry points for search, layout audit, and catalog export."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys
import time
from typing import Any, Callable, Sequence

from .canonical import canonical_level_hash, semantic_signature, topology_signature
from .catalog import export_catalog
from .metrics import witness_metrics
from .minimize import minimize_level
from .parallel import load_jsonl, run_generation
from .schema import Level
from .search import BRAIN_VERSION, generate_candidate


MAX_WORKERS = 64
MAX_CANDIDATES_PER_BAND = 100_000
MAX_CANDIDATE_ID = 999_999
MAX_BENCHMARK_ATTEMPTS = 10_000
MAX_EXPORT_PER_BAND = 100_000
MASTER_SEED_PATTERN = re.compile(r"^[0-9a-f]{16,64}$")


def parse_master_seed(value: str) -> str:
    if MASTER_SEED_PATTERN.fullmatch(value) is None:
        raise argparse.ArgumentTypeError(
            "master seed must be 16..64 lowercase hexadecimal characters"
        )
    return value


def bounded_int(label: str, minimum: int, maximum: int) -> Callable[[str], int]:
    def parse(value: str) -> int:
        try:
            result = int(value)
        except ValueError as reason:
            raise argparse.ArgumentTypeError(f"{label} must be an integer") from reason
        if not minimum <= result <= maximum:
            raise argparse.ArgumentTypeError(
                f"{label} must be within {minimum}..{maximum}"
            )
        return result

    return parse


def parse_bands(value: str) -> tuple[int, ...]:
    result: set[int] = set()
    for part in value.split(","):
        part = part.strip()
        if not part:
            continue
        if ":" in part:
            start_text, end_text = part.split(":", 1)
            start, end = int(start_text), int(end_text)
            result.update(range(start, end + 1))
        else:
            result.add(int(part))
    if not result or min(result) < 0 or max(result) > 8:
        raise argparse.ArgumentTypeError("bands must be within 0..8")
    return tuple(sorted(result))


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="hullshiftbrain")
    parser.add_argument("--version", action="version", version=BRAIN_VERSION)
    commands = parser.add_subparsers(dest="command", required=True)

    generate = commands.add_parser("generate", help="generate deterministic candidate shards")
    generate.add_argument("--bands", type=parse_bands, default=parse_bands("0:8"))
    generate.add_argument("--workers", type=bounded_int("workers", 1, MAX_WORKERS), default=32)
    generate.add_argument("--master-seed", type=parse_master_seed, required=True)
    generate.add_argument("--run-dir", type=Path, required=True)
    generate.add_argument(
        "--candidates-per-band",
        type=bounded_int("candidates-per-band", 1, MAX_CANDIDATES_PER_BAND),
        default=1,
    )

    resume = commands.add_parser("resume", help="resume missing deterministic candidate ids")
    resume.add_argument("--run-dir", type=Path, required=True)
    resume.add_argument("--workers", type=bounded_int("workers", 1, MAX_WORKERS), default=32)

    minimize = commands.add_parser("minimize", help="perform safe witness-based interactive ablation")
    minimize.add_argument("--run-dir", type=Path, required=True)
    minimize.add_argument("--simplify-geometry", action="store_true", help="requires external exact review; witness-only shortcut checks are insufficient")

    export = commands.add_parser("export", help="export compact catalog and reproduction manifest")
    export.add_argument("--run-dir", type=Path, required=True)
    export.add_argument(
        "--per-band",
        type=bounded_int("per-band", 1, MAX_EXPORT_PER_BAND),
    )
    export.add_argument("--out", type=Path, required=True)
    export.add_argument("--manifest", type=Path)

    sample = commands.add_parser("sample", help="write one rich candidate JSON record to stdout")
    sample.add_argument("--difficulty", type=bounded_int("difficulty", 0, 8), required=True)
    sample.add_argument("--master-seed", type=parse_master_seed, required=True)
    sample.add_argument(
        "--candidate-id",
        type=bounded_int("candidate-id", 0, MAX_CANDIDATE_ID),
        default=0,
    )

    benchmark = commands.add_parser("benchmark", help="measure end-to-end proposal throughput")
    benchmark.add_argument("--difficulty", type=bounded_int("difficulty", 0, 8), default=4)
    benchmark.add_argument("--master-seed", type=parse_master_seed, default="0000000000000000")
    benchmark.add_argument(
        "--attempts",
        type=bounded_int("attempts", 1, MAX_BENCHMARK_ATTEMPTS),
        default=4,
    )

    layouts = commands.add_parser(
        "layouts",
        help="build and audit every registered independent layout family",
    )
    layouts.add_argument(
        "--seed",
        type=bounded_int("seed", 0, 2**31 - 1),
        default=0,
    )

    layout_sample = commands.add_parser(
        "layout-sample",
        help="generate one candidate from a named registered layout family",
    )
    layout_sample.add_argument("--family", required=True)
    layout_sample.add_argument("--master-seed", type=parse_master_seed, required=True)
    layout_sample.add_argument(
        "--candidate-id",
        type=bounded_int("candidate-id", 0, MAX_CANDIDATE_ID),
        default=0,
    )
    layout_sample.add_argument("--out", type=Path, required=True)

    return parser


def _minimize_run(run_dir: Path, simplify_geometry: bool) -> int:
    source = run_dir / "candidates.jsonl"
    records = load_jsonl(source)
    output: list[dict[str, Any]] = []
    for record in records:
        level = Level.from_json(record["level"])
        witness = tuple(record["witness"])
        result = minimize_level(level, witness, simplify_geometry=simplify_geometry)
        updated = dict(record)
        updated["level"] = result.level.to_json()
        updated["canonicalLevelHash"] = canonical_level_hash(result.level)
        updated["topologySignature"] = topology_signature(result.level)
        updated["semanticSignature"] = semantic_signature(result.level)
        updated["metrics"] = {
            **witness_metrics(result.level, witness),
            **{key: value for key, value in record.get("metrics", {}).items() if key in ("requestedDifficulty", "reversePushes", "reverseWalks", "causalShape")},
            "ablationRemoved": list(result.removed),
            "ablationPasses": result.passes,
            "exactRecertificationRequired": True,
        }
        output.append(updated)
    path = run_dir / "minimized.jsonl"
    path.write_text("".join(json.dumps(item, sort_keys=True, separators=(",", ":")) + "\n" for item in output))
    print(json.dumps({"records": len(output), "output": str(path)}))
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "sample":
        candidate = generate_candidate(args.difficulty, args.master_seed, args.candidate_id)
        json.dump(candidate.to_record(), sys.stdout, sort_keys=True, separators=(",", ":"))
        sys.stdout.write("\n")
        return 0
    if args.command == "generate":
        records = run_generation(
            args.run_dir,
            bands=args.bands,
            candidates_per_band=args.candidates_per_band,
            master_seed=args.master_seed,
            workers=args.workers,
        )
        print(json.dumps({"records": len(records), "runDir": str(args.run_dir)}))
        return 0
    if args.command == "resume":
        config = json.loads((args.run_dir / "run.json").read_text())
        try:
            master_seed = parse_master_seed(str(config["masterSeed"]))
            candidates_per_band = bounded_int(
                "candidates-per-band", 1, MAX_CANDIDATES_PER_BAND
            )(str(config["candidatesPerBand"]))
            bands = tuple(int(item) for item in config["bands"])
        except (KeyError, TypeError, ValueError, argparse.ArgumentTypeError) as reason:
            raise SystemExit(f"invalid run configuration: {reason}") from reason
        if not bands or tuple(sorted(set(bands))) != bands or min(bands) < 0 or max(bands) > 8:
            raise SystemExit("invalid run configuration: bands must be sorted unique values in 0..8")
        records = run_generation(
            args.run_dir,
            bands=bands,
            candidates_per_band=candidates_per_band,
            master_seed=master_seed,
            workers=args.workers,
            resume=True,
        )
        print(json.dumps({"records": len(records), "runDir": str(args.run_dir)}))
        return 0
    if args.command == "minimize":
        return _minimize_run(args.run_dir, args.simplify_geometry)
    if args.command == "export":
        source = args.run_dir / "minimized.jsonl"
        if not source.exists():
            source = args.run_dir / "candidates.jsonl"
        records = load_jsonl(source)
        catalog, manifest = export_catalog(records, args.out, per_band=args.per_band, manifest_output=args.manifest)
        print(json.dumps({"entries": len(catalog["entries"]), "catalog": str(args.out), "sha256": manifest["catalogSha256"]}))
        return 0
    if args.command == "benchmark":
        started = time.perf_counter()
        for candidate_id in range(args.attempts):
            generate_candidate(args.difficulty, args.master_seed, candidate_id)
        elapsed = time.perf_counter() - started
        print(json.dumps({
            "difficulty": args.difficulty,
            "attempts": args.attempts,
            "seconds": round(elapsed, 4),
            "candidatesPerSecond": round(args.attempts / elapsed, 4),
        }))
        return 0
    if args.command == "layouts":
        from .layout_registry import validate_registry_builds

        reports = validate_registry_builds(args.seed)
        print(json.dumps({"families": reports}, sort_keys=True, separators=(",", ":")))
        return 0
    if args.command == "layout-sample":
        from .layout_registry import registered_families

        family = next(
            (item for item in registered_families() if item.id == args.family),
            None,
        )
        if family is None:
            raise SystemExit(f"unknown layout family: {args.family}")
        candidate = generate_candidate(
            family.target_difficulty,
            args.master_seed,
            args.candidate_id,
            layout_family=family,
        )
        catalog, manifest = export_catalog(
            [candidate.to_record()],
            args.out,
            per_band=1,
        )
        print(json.dumps({
            "family": family.id,
            "difficulty": family.target_difficulty,
            "entries": len(catalog["entries"]),
            "catalog": str(args.out),
            "sha256": manifest["catalogSha256"],
        }))
        return 0
    raise AssertionError(args.command)


if __name__ == "__main__":
    raise SystemExit(main())
