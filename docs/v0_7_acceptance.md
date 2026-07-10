# v0.7 acceptance harness

`src/simulation/v0_7_acceptance.ts` implements the ratified evidence gate without making a release decision.
A complete run is:

- nine preregistered LiveTwin/melee cells of 3,000 paired games against each of v0.6 and v0.4 (54,000
  headline games), and
- separate, disjoint 3,000-game melee, mixed-50, and random non-regression cells against both opponents
  (18,000 games with one seed per cohort).

This acceptance preregistration intentionally interprets the robustness cohorts as `melee/mixed/random`.
`mixed` sets `FIGHT_MELEE_ROSTERS=0.5`, choosing melee-drafted versus random rosters deterministically once per
side-swap pair. It is not the older LiveTwin battery's `range` specialist (`ROSTER_RANGED_MIN=3`) cohort; the
report records `rangeSpecialistCohortIncluded: false` so the two protocols cannot be conflated.

The report uses side-swap pairs as uncertainty clusters, verifies seat balance and callback completeness, and
records draws, Armageddon decisions, engine rejections, the exact revision/config, and the seed-manifest digest.
`PASS` means only that the powered simulation evidence passed. Owner sign-off, journal-replay divergence, and
the bake decision always remain `NOT_EVALUATED`.

The CLI fails closed when any `V04_*`, `V05_*`, `V06_*`, `V07_*`, `SEARCH_*`, `Q2_*`, or `CEM_*` behavior flag is
present, then launches workers with the committed defaults plus only the explicit LiveTwin/cohort controls.

## Seed manifest

Create the manifest before evaluating the candidate. All twelve base seeds must be newly selected and mutually
disjoint; do not reuse the example smoke seeds below. A powered manifest has this shape:

```json
{
    "schemaVersion": 1,
    "manifestId": "v0.7-final-YYYY-MM-DD",
    "createdAt": "YYYY-MM-DDTHH:mm:ssZ",
    "candidate": "v0.7",
    "opponents": ["v0.6", "v0.4"],
    "headline": {
        "seeds": ["nine preregistered uint32 values"],
        "gamesPerSeed": 3000
    },
    "cohorts": {
        "gamesPerSeed": 3000,
        "seeds": {
            "melee": ["one or more fresh uint32 values"],
            "mixed": ["one or more fresh uint32 values"],
            "random": ["one or more fresh uint32 values"]
        }
    },
    "freshSeedsDeclared": true,
    "declaration": "Preregistered before candidate outcomes were observed; not used by training or earlier gates."
}
```

The quoted array descriptions are placeholders, not runnable seed values. Replace them with JSON numbers. The
harness rejects direct and derived pair-seed overlap.

## Powered command

```bash
bun src/simulation/v0_7_acceptance.ts v0.7 \
  --manifest=sim-out/v0_7_acceptance/manifests/v0.7-final.json \
  --concurrency=12 \
  --checkpoint-dir=sim-out/v0_7_acceptance/v0.7-final.cells \
  --output=sim-out/v0_7_acceptance/v0.7-final.acceptance.json
```

Re-run the same command to resume. Each completed cell is checksummed and bound to the exact run configuration
and Git revision; incompatible checkpoints are ignored. The full report is written to `--output`, and the compact
machine-readable gate artifact is written alongside it as `<output>.gates.json`.

## Smoke command

This exercises every path with 16 headline/cohort games total and must remain `INCONCLUSIVE` because it has no
preregistered manifest and is underpowered:

```bash
bun src/simulation/v0_7_acceptance.ts v0.7 \
  --headline-seeds=41001 \
  --melee-seeds=42001 \
  --mixed-seeds=43001 \
  --random-seeds=44001 \
  --games=2 \
  --cohort-games=2 \
  --concurrency=2 \
  --output=sim-out/v0_7_acceptance/v0.7-smoke.acceptance.json
```
