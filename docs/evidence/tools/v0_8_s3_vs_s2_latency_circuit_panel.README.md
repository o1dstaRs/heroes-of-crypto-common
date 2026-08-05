# v0.8+a13 shortlist-3 versus shortlist-2 latency/circuit panel

This external evidence runner measures the cost and timing safety of production a13 shortlist 3 against the
canonical shortlist-2 control without editing or importing simulation code from the shared working tree.
Every worker dynamically imports an explicit, sealed common source root.

The two arms differ in exactly one constructed-driver setting:

- S3 calls `runMatch` normally, so battle engine uses its untouched automatic production v0.8+a13 factory.
- S2 scopes the canonical a13 environment around the same call and changes only `SEARCH_SHORTLIST` from `3`
  to `2`. Explicit `V07_SEARCH=1` makes this use the ordinary generic SearchDriver rather than the automatic
  factory.

At the first real decision of every match, the runner asserts the live SearchDriver has the expected shortlist,
v0.8 version scope, horizon 12, two rollouts, 175 ms comparison deadline, `operation_bounded` wait policy, and
275 ms common circuit breaker. A mismatch aborts the panel.

## Frozen workload

- Seed `928203517`.
- All seven tracked non-mirrored meta cohorts.
- Three prepared matchups per cohort, exactly one on each live map: Normal, Lava Center, and Block Center.
- Candidate roster A fights fixed v0.7 roster B as green and red.
- Each arm/physical-side cell is repeated exactly twice on the same setup, map, and combat seed.
- ABBA/BAAB arm ordering alternates by cohort and pair.
- 21 clusters × 8 matches = 168 measured matches per concurrency condition.
- Conditions c1 and c6 contain the same 168 matches, for 336 measured matches total.
- Each worker first runs two discarded two-lap warmups, one per arm. The default two-condition invocation adds
  14 warmup matches, so the complete process executes 350 matches and remains a hundreds-scale panel.
- `maxLaps=60` for measured matches.

The panel records original, unrounded `performance.now()` differences for policy, SearchDriver arbitration,
end-to-end decision, post-decision execution, full turn, match, and match-per-accepted-action time. It emits
p50/p95/p99/max/mean/total, plus counts above 175, 275, and 300 ms. Every decision includes exact deltas for
SearchDriver decisions, searches, candidates, fully scored candidates, rollout turns, overrides, illegal
incumbents, single-candidate exits, deadline fallbacks, circuit-wait arbitrations, and circuit skips.

The 300 ms ranked state is a faithful timing projection of the server wrapper's `closed -> timing_open`
transition around `chooseDecision`; a thrown search projects `hard_open`. Common's actual 275 ms circuit state
and counters are captured directly. This runner does not claim to execute server-only metadata or scene-log
rollback code.

With action logging enabled, it stores action, outcome, placement, and compact result digests. Same-arm exact
repeats must match when neither repeat entered a deadline/circuit path. Cross-arm digest equality is reported but
is not a gate because shortlist 3 intentionally admits one more challenger.

## No-fight checks

Both commands below import and validate the exact source but execute zero fights. Preflight also creates one
worker in a special no-warmup mode and emits the source SHA required by the measured command.

```bash
runner=docs/evidence/tools/v0_8_s3_vs_s2_latency_circuit_panel.ts
archive=/tmp/hoc-common-s3-exact.puVp0M

bun "$runner" --self-test --source-root "$archive"
bun "$runner" --preflight --source-root "$archive"
```

The 2026-08-03 exact archive preflight returned source SHA
`abd270f0c8f4c4a370e64f789108e2880eee2d1084c4b879fbc18ec0f919ee74`, clean Git commit
`d04379392ad02f335c072a4d59fb2ffadaf5d3d1`, and zero fights executed.

## Measured invocation

Use a new output directory on an otherwise quiet host. Do not combine this with the strength harness or another
CPU-heavy process.

```bash
bun "$runner" \
  --source-root "$archive" \
  --expected-source-sha256 abd270f0c8f4c4a370e64f789108e2880eee2d1084c4b879fbc18ec0f919ee74 \
  --concurrency 1,6 \
  --output /tmp/hoc-s3-s2-latency-c1-c6
```

Expected runtime on the repository's M4 Max is roughly 6–15 minutes when the host is quiet. Timing fallback or
thermal contention can extend it. Run c1 and c6 separately with `--concurrency 1` or `--concurrency 6` if host
attestation or cool-down policy requires isolated conditions; never merge records from different source seals.

Each condition writes append-only JSONL while running and then canonicalizes it. Its directory contains a
condition summary; the output root contains the combined summary and full before/after source, runner,
environment, worker, runtime, and workload seals.

The strict safety verdict requires:

- a complete fixed corpus and unchanged source/runner;
- identical worker environment/profile contracts;
- zero positive S3-minus-S2 deadline-fallback, circuit, exception, or rejection events;
- zero absolute production-S3 fallback, circuit-open, exception, or rejected-action events; and
- exact same-arm action/state digest parity for every timing-clean repeat cell.

Latency ratios and cross-arm action/outcome differences remain measurements rather than arbitrary promotion
thresholds. The safety boundary is the real 175/275/300 ms deadline and circuit behavior.
