# Ranked outer-300 ms paired replay harness

`ranked_outer_300_replay.ts` executes the unchanged ranked server `PlaySessionManager` and real
`createBotSearchDriver` against two immutable common source archives. It is an operational semantic/safety gate for
the production-bounded v0.8+a13 path; it is not a latency-qualification benchmark.

## Isolation and determinism

- The coordinator launches a fresh Bun worker for each variant, with `NODE_ENV=production`, `HOC_BOT_SEARCH=1`,
  and `HOC_JOURNAL_FULL=1`.
- A Bun resolver aliases every server `@heroesofcrypto/common` import to that worker's immutable archive. The
  archived server and both common archives are read-only inputs; no production source is patched.
- Before launching either worker, the coordinator recursively seals every file under both common `src` trees and
  the server's complete `src` tree. Frozen file-count/byte-count/manifest hashes and the exact two-file A/B delta
  are hard-coded for this qualification point; unknown/mismatched caller commit labels are rejected. It reseals
  the same trees, package manifests, and resolved locks after both workers finish and refuses to emit a result if
  anything changed.
- Each match resets a test-process-only deterministic `crypto.randomUUID`, `crypto.getRandomValues`, and common
  random source. This pairs setup, luck, combat, unit/summon IDs, and search rollouts without changing the archived
  implementations.
- The worker drains retained journal/events after creation, every accepted publication, and every manager tick, so
  the evidence stream is uncapped even if production's 512-entry retention limit is crossed.
- The common archives share a symlinked installed dependency tree. The common workspace lock, server archive/live
  lock, and package manifests are sealed, but every installed `node_modules` byte is not recursively sealed; this
  limitation is explicit in the result.

## Run

```bash
bun docs/evidence/tools/ranked_outer_300_replay.ts \
  --baseline-root /tmp/hoc-ranked-final-parent-baseline.XXXXXX \
  --candidate-root /tmp/hoc-ranked-final-parent-candidate.XXXXXX \
  --server-root /tmp/hoc-server-8519-ranked300.XXXXXX \
  --server-sha 8519fbded3c200a159b2062d00ad5f1f929fe47f \
  --common-base-sha 7950492f1e5ca81d5e071c377bb2956c8c01832a \
  --scenario-count 3 \
  --base-seed 930722001 \
  --side-swaps 1 \
  --full-states 0 \
  --max-ticks 8000 \
  --out /tmp/a13-ranked-outer-300-3map-6pair.json
```

Run the identical-source control by passing the baseline archive as both `--baseline-root` and `--candidate-root`.
Use `--full-states 1` only for focused debugging; it retains the full semantic state at every accepted fight action
and substantially increases output size. Even with `--full-states 0`, the worker captures full actions, GameEvent
payloads, server events, final snapshots, and per-action semantic hashes.

## Persisted evidence

The final six-pair raw result is retained losslessly as
`docs/evidence/a13_ranked_outer_300_replay_2026-07-22.raw.json.gz`. Its compressed and uncompressed byte counts
and SHA-256 hashes are recorded in the adjacent compact evidence JSON. Verify the artifact with:

```bash
gzip -t docs/evidence/a13_ranked_outer_300_replay_2026-07-22.raw.json.gz
gzip -cd docs/evidence/a13_ranked_outer_300_replay_2026-07-22.raw.json.gz | shasum -a 256
```

## Gate and timing interpretation

A pass requires every paired fight to finish with both production and uncapped replay completeness, exact action,
GameEvent, server-event, chosen-decision, semantic counter-delta, per-action state-trace, and final-state digests,
and no first decision/counter difference. Each match must construct exactly one driver; inner/outer/counter call
counts must agree; searched plus single-candidate decisions must equal total decision calls. Proposal rejections,
server errors, deadline fallbacks, circuit skips/openings/warnings, and failed search-state restores must all be
zero. `illegalIncumbent` is reported and must match across variants; it is not falsely classified as a zero-only
safety counter.

The threshold fields are observations, not labels: `300` is read from the imported server
`BOT_SEARCH_CIRCUIT_BREAKER_MS`, while `175` and `275` are read and asserted from every constructed common
`SearchDriver`.

Restore validation covers the semantic `snapshotBattle` state, damage statistics, active-unit identity, paired
common-RNG cursor, stable search state, and the unit metadata/scene log explicitly restored by the server wrapper.
It excludes intentionally-mutating search counters/circuit state, console output, the external crypto cursor, and
unrelated session fields that search does not touch. This is not presented as a byte-for-byte snapshot of the
entire private `PlaySession` object.

`wrapperElapsedPerformanceMs` surrounds the entire private `searchBotDecision` call, including server metadata
snapshot and final restoration. It is deliberately labelled wrapper elapsed: the authoritative production 300 ms
classification is the unchanged server method's circuit flag and its log evidence. A six-match panel can establish
that the path ran safely below the breaker on those scenarios, but it cannot qualify latency percentiles or prove a
population performance improvement.
