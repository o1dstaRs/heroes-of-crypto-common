# v0.8 Aligned 96-Hour v1 Campaign

Status: research-only implementation. This campaign must not bake or deploy a policy automatically. A formal run is
authorized only from clean, pushed `main` after its exact Zinc throughput measurement, fresh seed-corpus scans,
immutable definition preparation, and supervisor preflight pass.

## Objective

Repeat the aligned-v2 training logic on the current engine while keeping the shipped AI unchanged:

- candidate: `v0.8s`, a candidate-only search alias of clean-default `v0.8`;
- candidate base: `v0.8`, initially behavior-identical to shipped `v0.7`;
- opponent: exact shipped `v0.7`;
- shipped default during research: `v0.7`.

The campaign evaluates both candidate seats in twelve cells: four ranked taxonomy cohorts (Mage, Melee Mage, Aura,
and Ranged) and eight fixed templates (two per cohort). These 24 cell-seat strata have equal weight. Candidate
selection maximizes the worst decisive win rate before considering pooled diagnostics.

## Search Space And Budget

The reviewed finite catalog contains 48 v0.8-specific behavior arms derived from the aligned-v2 coverage anchors and
rebound to `v0.8s` on the current source tree. Every candidate includes plain movement in search, capped to the
nearest single destination by `SEARCH_MAX_MOVES=1`. The frozen v0.7 incumbent does not enable movement search.

Unlike v0.7, v0.8 search applies a version-scoped productive-action priority after engine scoring. Whenever at least
one scored legal attack, spell, or move exists, search may not choose an hourglass wait, Luck Shield, or mountain
attack; those actions remain available only as true fallbacks when no productive candidate is legal. This priority
also survives shortlist selection, so a high immediate score cannot crowd the only productive challenger out of a
two-candidate shortlist. Before a configured deadline search, v0.8 deterministically probes the first productive
fallback through the real action engine with full snapshot/restore. A deadline or open search circuit returns that
known-valid fallback instead of a passive incumbent; only a position with no engine-valid attack, spell, or move may
fall back to wait, Luck Shield, or a mountain attack. The v0.7 opponent, observe-only searches, and every pre-v0.8
search version retain their historical selection rules.

The catalog deliberately mixes rollout depth with decision headroom: 14 arms use one rollout, 19 use two, and 15
use three. The deadline census is 10 arms at 125ms, 20 at 150ms, and 18 at 175ms. Deep h12 candidates use at most
two rollouts, while the three-rollout arms use h4 or h8; every deadline remains at least 100ms below the fixed 275ms
circuit breaker. Coverage includes the committed, multicohort, b9ce, and midpoint leaf anchors; ranged terminal
overlays; melee-mage isolation and targeting; aura routing; reveal-conditioned placement; shortlist and challenger
controls; horizon; gate; and decision deadline.

The exact production budget is 390,912 games:

| Phase   |                                                   Calculation |   Games |
| ------- | ------------------------------------------------------------: | ------: |
| Train   |            48 candidates x 256 scenarios x 12 cells x 2 seats | 294,912 |
| Confirm | challenger + incumbent x 1,000 scenarios x 12 cells x 2 seats |  48,000 |
| Final   |                              2,000 games x 12 cells x 2 seats |  48,000 |

The Zinc envelope remains 40 workers on a 48-logical-CPU host with four CPUs explicitly reserved. The immutable
schedule reserves at least the final 36 hours for confirmation and final measurement.

This campaign does not retrain the ranked draft, synergy, augment, artifact, or general setup-policy weights. Those
policies are part of the fixed current-engine evaluation distribution. Candidate-only placement controls in the
catalog are optimized; the rest of the non-fight policy remains fixed. A later campaign is required to search a new
non-fight parameter space.

## Isolation And Evidence

Every candidate behavior environment is scoped to `v0.8s`. Search, placement reveal, dense melee-magic isolation,
aura routing, and the melee targeting overlay must not reach the `v0.7` opponent. Both physical seats are measured,
and each persisted shard binds the immutable definition fingerprint, seed panel, candidate genome, behavior
environment, raw battle records, search audits, and worker attestations.

Omitting the version profile from the shared aligned machinery preserves the historical v0.7 aligned-v2 bytes. A
v0.8 definition carries the exact `v0.8s`/`v0.8` versus `v0.7` profile and rejects v0.7 candidate bindings or
cross-profile replay.

The final qualification retains the aligned-v2 policy. Every one of the 24 strata needs a Bonferroni-adjusted
two-sided Wilson lower bound of at least 90% decisive win rate, at least 90% decisive games, at most 10% draws or
Armageddon, and clean operational evidence. Candidate turns are paired with their legal candidate set; any wait,
Luck Shield, or mountain attack taken while an attack, spell, or move was legal fails candidate execution integrity,
as do strategy no-ops, recovery turns, and rejected actions. A PASS is still research-only and does not change
`DEFAULT_AI_VERSION`.

## Zinc Replacement Procedure

The previous v0.7 aligned-v2 job must be audited before replacement. Preserve its heartbeat, supervisor state,
terminal/refusal markers, evidence inventory, and cron entry. Then terminate its owned process group through the
supervisor lifecycle, verify the host and output locks are released, and remove only its exact keepalive cron entry.
Never start the v0.8 job beside it.

For the v0.8 run:

1. Pin a clean pushed `main` commit and reproduce its complete source/runtime provenance on Zinc.
2. Run the exact 6,144-game, eight-batch throughput measurement as `v0.8s` versus `v0.7`; persist and replay every
   shard before accepting the conservative per-worker rate.
3. Scan all committed, local, and Zinc experiment artifacts twice; require byte-identical replay and allocate fresh
   train, confirm, and hidden final seeds outside the complete used-seed union.
4. Build the immutable 96-hour definition with the v0.8 version profile, production catalog, current composed seal,
   throughput attestation, and fresh seed commitment.
5. Run the game-free supervisor preflight and restart/replay gates.
6. Launch one owned supervisor/keepalive process group, install one exact stop-bounded cron entry, and capture a
   launch receipt only after persisted-game progress and both host/output locks are observed.

The exact-host throughput command is the shared aligned-v2 entry point with the mandatory v0.8 selector:

```bash
bun src/simulation/optimizer/v0_7_aligned_96h_v2_throughput.ts \
  --version-profile=v0.8s-vs-v0.7 \
  --out=/absolute/external/v0-8-aligned-v1-inputs/throughput-evidence \
  --attestation=/absolute/external/v0-8-aligned-v1-inputs/throughput.json \
  --reserved-cpus="$RESERVED_CPUS" \
  --workers-per-shard="$WORKERS_PER_SHARD" \
  --concurrent-shards="$CONCURRENT_SHARDS" \
  --max-scenario-pairs-per-shard="$MAX_SCENARIO_PAIRS_PER_SHARD" \
  --shard-timeout-minutes="$SHARD_TIMEOUT_MINUTES"
```

Both the self-hashed runner config and definition bootstrap request must include the exact
`V08_ALIGNED_96H_V1_VERSION_PROFILE` value. The shared preparation command then rejects any config/request mismatch
and emits a `v0_8_aligned_96h_v1_orchestrator_definition`; omitting the profile intentionally selects the historical
v0.7 aligned-v2 campaign instead.

Transient SSH failure is not authorization to launch elsewhere or to assume the previous job stopped. The launch
receipt must report observed process identities, immutable deadline, run fingerprint, source commit, seed census,
throughput evidence, and first durable progress samples.
