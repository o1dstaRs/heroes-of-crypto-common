# v0.8+a13 shortlist-3 versus shortlist-2 anchor A/B

This external evidence harness measures whether production shortlist 3 is stronger than shortlist 2 without
adding a production `SearchDriver` seam. The S3 arm uses `runMatch`'s untouched automatic v0.8+a13 factory. The
S2 arm supplies the canonical production a13 environment with only `SEARCH_SHORTLIST` changed from `3` to `2`.
Both fight the same fixed v0.7 anchor.

Every evidence cluster contains eight fights on one generated matchup, map, setup seed, and combat seed:

- S3 receives roster A and roster B, once as green and once as red (four fights).
- S2 receives those same rosters and physical seats against the same anchor rosters (four fights).

The primary estimand is the within-cluster difference between the two arms' draw-aware scores. This complete
four-game crossover per arm removes roster and physical-seat assignment from the shortlist comparison. Matchups
come from the tracked `ai_meta_cohorts_core` generator: ranked draft, uniform, ranged, melee, flyer, caster, and
cross-archetype cohorts over Normal, Lava Center, and Block Center. The harness does not import the rejected
ranked-replay experiment modules.

Run no-fight contract checks first:

```bash
bun docs/evidence/tools/v0_8_s3_vs_s2_anchor_ab.ts --self-test
bun docs/evidence/tools/v0_8_s3_vs_s2_anchor_ab.ts --preflight
```

Use `--source-root` to run the untracked external harness against an exact clean archive without copying or
editing that archive. Every worker dynamically imports its production modules from this root; the recursive
production seal hashes its `src`, package, and lock while the external runner is hashed separately:

```bash
archive=/tmp/hoc-common-s3-exact.puVp0M
bun docs/evidence/tools/v0_8_s3_vs_s2_anchor_ab.ts --preflight --source-root "$archive"
```

Run the fixed 36-cluster-per-cohort smoke on six workers:

```bash
bun docs/evidence/tools/v0_8_s3_vs_s2_anchor_ab.ts \
  --stage smoke \
  --concurrency 6 \
  --source-root /tmp/hoc-common-s3-exact.puVp0M \
  --output /tmp/hoc-s3-s2-smoke
```

`--concurrency` accepts only `6` or `12`; never combine results from different settings. Direction, development,
validation, and replication stages have fixed pair counts and seeds. The fresh direction confirmation uses seed
`1618033989`, 360 clusters per cohort, 2,520 complete clusters, and 20,160 fights. It is a one-shot held-out stage
and applies the same overall +1.0 point, clustered lower-bound +0.25 point, slice-safety, and quality gates as the
larger promotion stages. Direction, validation, and replication require all seven cohorts, 60 laps, and an exact
`--expected-source-sha256` copied from a preflight of the immutable source archive. Validation remains bound to
seed `386914648` and its embedded SHA-256 commitment.

The coordinator refuses to reuse an output directory, writes append-only raw JSONL while running, then
canonicalizes it after completion. It seals the recursive source tree, key implementation files, package/lock,
runner, Git commit/tree/status, canonical candidate/control environments, actual worker behavior environment,
host, Bun runtime, and concurrency. A source or runner change during the run fails the quality gate.

Measurable-strength gates are evaluated for the fixed direction/validation/replication stages; only validation
and replication are labelled promotion evidence:

- overall S3-minus-S2 lift at least +1.0 percentage point;
- fixed-stratified clustered 95% lower bound at least +0.25 point;
- no cohort, map, or cohort-by-map slice below -2 points or statistically clearly harmful;
- zero malformed/overlapping/rejected/stuck matches and unchanged source.

Do not inspect partial win rates. A development-stage pass is directional evidence only and cannot promote S3.
