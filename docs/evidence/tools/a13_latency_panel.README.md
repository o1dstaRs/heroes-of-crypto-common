# a13 Workstream-1 latency/tail panel

This evidence-only runner compares two explicit, immutable common source roots without editing either one. It
freezes all seven `AI_META_COHORTS` (`ranked-draft`, `uniform-mixed`, `ranged-heavy`, `ground-melee`,
`flyer-heavy`, `caster-support`, and `cross-archetype`), the three live maps, production v0.8, the production
175ms decision deadline / 275ms circuit breaker, setup-before-placement, and the contextual
artifact/augment/synergy setup returned by `prepareMetaPair`.

## Frozen workload

- Base seed: `85000717`.
- 30 pair identities per cohort, balanced 10/10/10 over NORMAL, LAVA_CENTER, and BLOCK_CENTER.
- Two physical side swaps per pair: 210 pair identities become 420 matches per source variant.
- A baseline/candidate comparison therefore has 420 matched physical observations and 840 match executions at
  each concurrency condition.
- Side swaps provide physical-side coverage; they are not treated as independent statistical samples. The
  bootstrap resamples the 210 pair identities as clusters, retaining both swaps and both source variants.
- `maxLaps=60`.
- Conditions: c1 serial attribution, then c4 and c12 saturation.
- Each worker runs one discarded, fixed ranged-heavy pair-0 warmup capped at two laps; the worker refuses to
  start measurement unless that warmup produced at least 20 complete decisions.
- Within a 20-match cohort/map block, task-to-worker sharding is deterministic. Even blocks run
  baseline→candidate (AB) and odd blocks candidate→baseline (BA). This is alternating AB/BA block order for
  gross order balance, not same-block ABBA replication.
- Two variant-isolated pools remain resident for each condition. Each pool contains `concurrency` workers, so
  c12 creates and warms 24 resident workers; only the selected 12-worker variant pool runs during a block phase.
- `activeWallMs` is the sum of each variant's measured `runBlock` wall durations after warmup. It includes parent
  scheduling, worker execution, result structured-clone serialization, worker-to-parent IPC, and promise
  aggregation. It excludes worker warmup and the time a variant waits while the opposite pool is active.
- Reported p50/p95/p99/p99.9/max values use nearest rank. Durations are emitted as the original
  `performance.now()` differences; they are never rounded in JSON evidence.
- The 10,000-replicate bootstrap uses seed `0xa13dd001`, resamples whole pair identities (both side swaps
  together) inside each of the 21 cohort×map strata. It reports paired total/search/wall-time reductions plus
  candidate/baseline p95 and p99 ratios; both ratio upper confidence bounds must be at most 1.05.
- Per-decision rows include unrounded total/search time and exact SearchDriver counter deltas for decisions,
  searches, candidates, fully-scored candidates, rollout turns, illegal incumbents, overrides, and
  single-candidate exits. These flow through match and variant summaries. Reports include
  `1000 * searchMs / rolloutTurnsTotal`. Circuit-skipped decisions are not inserted as zero-time
  searched-decision samples.
- Accepted actions and SearchDriver logical-work counters must match task by task. A mismatched task is allowed
  only when that same task has an explicitly counted bounded deadline-fallback, circuit-open, or circuit-skip
  divergence; the report lists attributed and unattributed task IDs. `illegalIncumbent` participates in this
  parity rule. A separate safety gate sums positive candidate-minus-baseline `illegalIncumbent` deltas per task
  and requires zero, so decreases on other tasks cannot conceal a candidate-only increase.
- The logical-work vector has exactly 10 fields: accepted actions (`totalActions`) plus nine decision/search
  counters (`decisionCount`, `searchDecisions`, `searched`, `candidatesTotal`, `scoredCandidatesTotal`,
  `rolloutTurnsTotal`, `illegalIncumbent`, `overrides`, and `singleCandidate`). Reports persist both this ordered
  field list and its count.
- A qualifying invocation rejects any baseline or candidate whose full `src`-tree manifest differs from the
  frozen identity. It also requires the pairwise diff to be exactly modified `attack_handler.ts` plus
  candidate-added `ray_traversal.ts`, with both candidate file hashes frozen.
- Before and after every concurrency condition, and again across the complete panel invocation, the runner seals
  both full source trees and its own current bytes and fails if any changes. Plan and profile operations have the
  same before/after invariant. Per-condition equality is persisted in `cN/integrity-final.json` and its condition
  summary. `node_modules` is identified by resolved path but its contents are not hashed, and dependency-lock
  contents are not part of the seal; reports mark that limitation explicitly.

The acceptance contract is: at c1, the 95% bootstrap lower bounds for both total-decision and search-time
reduction must be greater than 0%. At c4 and c12, candidate active-phase wall time must be no more than 1.05×
baseline. At every condition, the upper 95% bootstrap bounds for all-decision p95 and p99 ratios must be no more
than 1.05. Every condition must contain the complete matched task set, candidate `engineRejectedActions` must be
zero in absolute terms, candidate-only safety regressions must be zero, and no unattributed logical-work
divergence is allowed. Candidate-only safety regressions include any positive per-task `illegalIncumbent`
increase; the absolute candidate rejection gate is independent of the candidate-minus-baseline rejection gate.

The bounded 175ms profile is intentionally timing-sensitive. Result/action/outcome/placement digests are always
recorded and compared, but a digest difference is diagnostic here: one variant may cross the deadline and take a
different engine-valid fallback. Exact semantic equality is qualified by the separate unbounded event/state
differential run.

The runner's own load/free-memory snapshots are descriptive. They cannot prove continuous AC power, nominal
thermal state, normal memory pressure, or absence of competing processes, so `hostQualified` is deliberately
hard-false. Join the separate one-second continuous host attestation before treating a completed workload as
qualifying; invalid host evidence requires rerunning the complete block, never deleting selected samples.
Accordingly, full runner invocations are labeled `full-evidence`, not `qualifying`, until that attestation is
joined and independently validated.

## Panel invocation

Use fresh output directories. For the cleanest thermal/load record, run one condition at a time after the host
returns idle; the runner also accepts `--concurrency 1,4,12` for an unattended sequence.

```bash
RUNNER=docs/evidence/tools/a13_latency_panel.ts
BASELINE=/absolute/path/to/immutable-baseline-common
CANDIDATE=/absolute/path/to/immutable-candidate-common

bun "$RUNNER" plan --root "$CANDIDATE" --out /tmp/a13-plan.json

bun "$RUNNER" run \
  --baseline-root "$BASELINE" \
  --candidate-root "$CANDIDATE" \
  --out /tmp/a13-latency-c1 \
  --concurrency 1

bun "$RUNNER" run \
  --baseline-root "$BASELINE" \
  --candidate-root "$CANDIDATE" \
  --out /tmp/a13-latency-c4 \
  --concurrency 4

bun "$RUNNER" run \
  --baseline-root "$BASELINE" \
  --candidate-root "$CANDIDATE" \
  --out /tmp/a13-latency-c12 \
  --concurrency 12
```

Raw matches and exact per-decision timings are split into deterministic worker JSONL files. Each condition also
gets a `summary.json`; the run root contains the source seals, complete frozen plan, protocol, and aggregate
summary. `--smoke` selects only the first pair's two side swaps at c1 and is always marked non-qualifying.
Smoke runs enforce the same frozen full-tree identities and exact two-file source isolation as full runs;
same-root smoke inputs are rejected.
`--skip-warmup` is accepted only together with `--smoke`; a full-evidence invocation cannot bypass warmup.

## Fixed-work CPU profiles

Each invocation executes the frozen seed-9001/max-laps-2 warmup, then nine exact repeats of the six-match
v0.8-mirror corpus at seeds `[1, 42, 43, 44, 45, 46]`, `maxLaps=4`. Every repeat is required to produce 361
accepted actions, zero rejections, and digest
`96f75ff536594f358450392b8f74ccdf9f500cc5e45f7a522016bebbeff488d7`; each capture therefore has exactly
3,249 accepted actions. Run three captures per variant, serially, without another benchmark active.

```bash
for VARIANT in baseline candidate; do
  ROOT="$BASELINE"
  if [ "$VARIANT" = candidate ]; then ROOT="$CANDIDATE"; fi
  mkdir -p "/tmp/a13-profiles/$VARIANT"
  for CAPTURE in 1 2 3; do
    bun --cpu-prof --cpu-prof-interval=500 \
      --cpu-prof-dir="/tmp/a13-profiles/$VARIANT" \
      --cpu-prof-name="a13-ray-$VARIANT-$CAPTURE.cpuprofile" \
      docs/evidence/tools/a13_latency_panel.ts profile-variant \
      --root "$ROOT" --variant "$VARIANT" --capture "$CAPTURE" \
      --out "/tmp/a13-profiles/$VARIANT/result-$CAPTURE.json"
  done
done
```

All six `workloadDigest` values must match before attributing profile-stack changes to the traversal code. The
`--variant` label is not descriptive metadata: the runner enforces the corresponding frozen full-tree identity,
so a baseline root cannot be labeled candidate or vice versa.
