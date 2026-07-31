# HullshiftBrain

HullshiftBrain is Hullshift's deterministic offline **proposal** pipeline. It
constructs a stable state immediately before evacuation, walks backward through
verified predecessors, materializes the resulting initial state, and replays the
reversed actions as a constructive solution. Production TypeScript mechanics
and the exact analyzer remain the catalog authority.

The current vertical slice provides:

- immutable `LevelDefinition`/`PuzzleState` records and production-compatible
  canonical keys and SHA-256 level hashes;
- a complete forward mechanics mirror, including relays, docking, fractures,
  disposal/vacuum loss, door jamming, bridge cascades, and gate victory;
- verified inverse walk, push, dock, direct-loss, relay, and fracture proposals;
- typed mission synthesis, procedural graph embedding, novelty-guided backward
  beam search, and an explicit registry for independently designed layout
  families;
- cheap interaction/decomposition/counterintuitive-action metrics, bounded
  solving, Pareto niches, safe ablation hooks, deterministic process shards,
  checkpoint/resume, catalog export, and a reproduction manifest;
- a persistent client for `scripts/differential_brain_rules.ts` parity checks.

## Independent layout families

Higher-band geometry is managed as independent modules under
`src/hullshiftbrain/layouts/`. Each module exports one `LayoutFamily` with its
own persona, topology, mechanic motif, solved frontier, verified reverse plan,
milestones, and required precedence. The registry selects families
deterministically from `(difficulty, candidateId)`; worker scheduling never
changes that choice.

The shared contract requires exactly one managed family for every difficulty
from 3 through 8. It rejects a family before generation when it reproduces a
retired topology; is a translated, padded, rotated, or reflected reskin of
another family; exceeds its playable-cell, object, or push budget; lacks the
requested dependency depth or mechanic-family count; does not reuse an object
across separated phases; has too few forced turns; contains more than four
consecutive straight pushes; or leaves an object/fixture outside its milestone
contract. These are early structural checks. Production TypeScript exact
certification still has the final word on shortcuts, mandatory milestones,
difficulty, and quality.

Audit every registered family:

```bash
python -m hullshiftbrain layouts --seed 0
```

Generate an isolated candidate catalog for one family:

```bash
python -m hullshiftbrain layout-sample \
  --family greek-siatista \
  --master-seed 0123456789abcdef0123456789abcdef \
  --out /tmp/greek-siatista.catalog.json
```

It deliberately does **not** claim that a Python score certifies human
difficulty. Every exported entry says `requiresTypeScriptCertification: true`.
The TypeScript catalog certifier must prove solvability, milestones,
precedence, difficulty, shortcut resistance, and release minimality.

## Install and test

```bash
python -m pip install -e 'apps/hullshift/tools/hullshiftbrain[test]'
python -m pytest apps/hullshift/tools/hullshiftbrain/tests
```

The tests use Bun, when available, to compare at least 512 deterministic
transitions—including a generated trace and relay, docking, fracture, and loss
fixtures—with one persistent production TypeScript oracle process. The parity
suite uses only local source and generated data; it does not access the network.

## Generate one candidate for every band

```bash
python -m hullshiftbrain generate \
  --bands 0:8 \
  --workers 32 \
  --master-seed 0123456789abcdef0123456789abcdef \
  --candidates-per-band 1 \
  --run-dir /tmp/hullshiftbrain-run
```

Scheduling never selects random streams. A candidate is derived only from
`(brainVersion, masterSeed, difficulty, candidateId, phase)`, so worker count
does not change bytes. Master seeds are canonical lowercase hexadecimal strings
of 16–64 characters. Generation checkpoints each deterministic 64-candidate
batch atomically; interruption can discard at most the active batch, and resume
recreates byte-identical sorted output without submitting completed work.

Resume and export:

```bash
python -m hullshiftbrain resume --run-dir /tmp/hullshiftbrain-run --workers 32
python -m hullshiftbrain minimize --run-dir /tmp/hullshiftbrain-run
python -m hullshiftbrain export \
  --run-dir /tmp/hullshiftbrain-run \
  --per-band 1 \
  --out /tmp/hullshiftbrain.g4.catalog.json
```

The catalog has the frozen envelope:

```json
{
  "schemaVersion": "hullshiftbrain-catalog-v1",
  "generatorVersion": "g4",
  "brainVersion": "hullshiftbrain-v1",
  "entries": []
}
```

For diagnostics, emit one rich record without a run directory:

```bash
python -m hullshiftbrain sample --difficulty 8 --master-seed 0123456789abcdef
```

## Scaling notes

Start with 30–32 workers on this 32-core/64-thread host, then benchmark 46 and
60. Worker processes force BLAS/OpenMP thread counts to one. `gpu.py` is an
explicit disabled experiment boundary: no GPU result participates in a hard
gate until a fixed-shape batch implementation demonstrates at least 2x
end-to-end throughput and exact CPU parity.
