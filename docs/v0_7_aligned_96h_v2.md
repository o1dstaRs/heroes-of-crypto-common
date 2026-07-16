# v0.7 Aligned 96-Hour v2 Policy and Evaluator

Status: implementation-only and research-only. Policy, evaluator, seed allocation, durable evidence, finite
orchestration, the exact runner, and supervisor primitives exist. The runner has not been sealed or launched. The
evaluator is callable only with an externally injected seed plan; its CLI is deliberately limited to an inert
preflight. Nothing in this implementation mutates source, bakes weights, or deploys.

## Objective

The aligned objective compares candidate `v0.7s` (a candidate-only alias of `v0.7`) with exact opponent `v0.6`.
It gives equal first-class treatment to both candidate seats in twelve cells:

- Ranked taxonomy: Mage, Melee Mage, Aura, Ranged.
- Fixed templates: two each for Mage, Melee Mage, Aura, Ranged.

This creates 24 cell-seat strata. The optimization objective is the minimum decisive win rate across those strata.
Pooled win rate is reported only as a diagnostic and cannot promote or qualify a candidate by itself. This is
necessary because the composed diagnostic measured about 94% from the green candidate seat and 81% from the red
candidate seat despite a much stronger pooled headline.

## Raw Evidence

`aggregateV07AlignedV2` accepts one raw observation per game. A row binds the cell, candidate seat, scenario id,
outcome, Armageddon reach, both engines' rejection counts, and candidate search audit. It rejects duplicate scenario
ids within a cell-seat stratum and malformed counters.

Every stratum reports:

- wins, losses, draws, decisive fraction, decisive win rate, and score rate;
- the union of draws and games that reached Armageddon;
- candidate/opponent rejections and missing rejection counts;
- missing audits, illegal incumbents, deadline fallbacks, circuit activity, search time, and game-time percentiles.

Operational eligibility is fail-closed per stratum: complete audits, at least one searched decision, zero rejection
or illegal-action evidence, deadline fallback rate at most 5%, zero circuit opens/skips, and mean search time at most
200 ms per searched decision.

## Confirmation Promotion

`assessV07AlignedV2Promotion` requires exactly 1,000 fresh paired observations in every cell-seat stratum. The runner
must use the same scenario id for challenger and incumbent, and the policy core rejects missing, duplicated, or
misjoined pairs.

For decisive-only win-rate differences, the core uses a paired ratio-estimator influence interval. Twenty-four
cell-seat noninferiority intervals plus one pooled gain interval form a 25-interval family using
`z = 3.090232306167813`.

The win lane requires all of the following:

- paired pooled gain lower bound above zero;
- every cell-seat lower bound at least -1 percentage point;
- max-min decisive win-rate improvement of at least 1.5 percentage points;
- no cell-seat draw-or-Armageddon increase above 1 percentage point;
- clean operational evidence for challenger and incumbent.

The integrity lane permits a ratchet out of a high-attrition incumbent. It requires at least a 5 percentage point
reduction in the worst draw-or-Armageddon stratum while retaining the paired and max-min -1 point noninferiority bars.

These are nominal large-sample delta-method intervals, not exact finite-sample coverage. Promotion policy overrides
may be stricter but the API rejects weaker values.

## Final Qualification

`assessV07AlignedV2Final` requires exactly 2,000 games per cell-seat stratum. Each of the 24 decisive win-rate claims
uses a two-sided Wilson interval with a Bonferroni familywise 95% value of `z = 3.0780880728421605`.

Every stratum must have:

- Wilson lower bound at least 90%;
- decisive fraction at least 90%;
- draw-or-Armageddon rate at most 10%;
- exact sample size and clean per-stratum operational evidence.

Global integrity must also be clean. The terminal artifact is always `research_only_no_bake`, with
`automaticBake: false` and `automaticDeploy: false`, regardless of PASS or FAIL.

## Inert Configuration

`defaultV07AlignedV2DryRunConfig` describes the intended Zinc envelope: 96 hours, 36 hours reserved for final
measurement, 40 workers on 48 logical CPUs, 10 concurrent trials with four workers each, and four explicitly
reserved CPUs. `validateV07AlignedV2DryRunConfig` validates untrusted JSON without launching anything.

The corresponding JSON Schema is
`src/simulation/manifests/v0_7_aligned_96h_v2_dry_run.schema.json`. Cross-field CPU constraints are enforced by the
TypeScript validator because JSON Schema does not express them directly.

## Evaluator Adapter

`v0_7_aligned_96h_v2_protocol.ts` defines the only accepted evaluator registry and injected seed-plan shape. It
requires both candidate seats for every scenario, exact v0.7s-versus-v0.6 version isolation, one setup proposal for
fixed templates, and all 128 outcome-blind setup proposals per ranked-taxonomy seat. Fixed-template seats share the
same physical setup and combat seed; taxonomy seats use independent first-hit streams conditioned on the candidate
side. The validator rejects internal or cross-cell seed collisions but never generates a seed.

`v0_7_aligned_96h_v2_game_adapter.ts` reconstructs the composed setup semantics from the exported primitives:

- ranked round-1 league draft with `CONDITIONAL_SETUP_V1=all` on both teams and persisted creature order;
- fixed templates with SetupPolicyV0 perk, conditional augments/synergies, and no T1/T2 artifacts;
- candidate `v0.7s` and opponent `v0.6`, swapping only which physical side the candidate controls.

The adapter exact-joins the candidate SearchDriver audit and emits the compact observation accepted by the policy
core. Missing, extra, malformed, or profile-mismatched audits fail closed.

`v0_7_aligned_96h_v2_worker.ts` scrubs all behavior environment before dynamically importing game code. One immutable
aligned genome is bound to each worker isolate with `SEARCH_VERSIONS=v0.7s`, a genome-bound decision deadline from
the preregistered 125/150/175/200 ms set, a fixed 275 ms circuit breaker, a unique audit file, and no `V06_WEIGHTS`.
The aligned-only controls also bind active-challenger filtering, shortlist 2/3/4 or none, the registered ranged
overlays, reveal-conditioned placement, dense-melee-magic isolation, and the aura caster mode. Every on and off value
is explicit in the behavior environment and hash. The parent evaluator supplies a sanitized `WorkerOptions.env` and
verifies worker attestations.

Checkpoint shards preserve two-seat scenario boundaries and bind the run, complete seed-plan fingerprint, panel id,
train/confirm/final purpose, denyset hash, scenario count, full task-set hash, genome, behavior environment, per-task
seed-material hashes, canonical task order, and compact observations. Before a worker can start, the evaluator validates
the shard and regenerates its exact deterministic partition from the complete injected seed plan. Exact-key task
identities prevent raw setup/combat seeds from leaking into checkpoints. The loader independently validates shard
self-hash, deterministic range, task hashes, audit presence, observation hash, and exact task joins.

The evaluator registry entries are frozen, candidate bindings are recomputed from the canonical genome before use,
and worker attestations bind the actual environment, worker index, audit path, and disabled transpiler cache. The
evaluator snapshots every validated caller input before its first asynchronous boundary, so a caller cannot swap a
genome, shard, seed plan, worker count, or environment while workers start. The public raw-record compactor also
rechecks the physical candidate seat and exact v0.7s-versus-v0.6 versions before it can erase matchup details into a
policy-core observation.

The only CLI mode is seedless and game-free:

```bash
bun src/simulation/optimizer/v0_7_aligned_96h_v2_evaluator.ts --dry-run
```

It uses two synthetic rows, reports `seedMaterialUsed: false` and `gamesExecuted: 0`, and exercises registry,
environment, aggregation, shard, and checkpoint replay. `--inject-two-game-rows <json>` substitutes exactly two
seedless rows; no full measurement mode is exposed.

## Durable Evidence and Resume

`v0_7_aligned_96h_v2_persistence.ts` persists a completed evaluator shard as one atomically published directory.
Raw battle records, exact worker audit bytes, worker attestations, candidate binding, audit index, and checkpoint are
individually hashed and row-counted. The commit manifest is written last inside the temporary directory; every file,
the temporary directory, and the parent directory are fsynced around rename. Abandoned temporary directories and
corrupt published shards are quarantined. An identical retry is idempotent, while different valid evidence at the
same immutable shard identity fails.

Artifact hashes are computed over the raw `Buffer` bytes. JSON and JSONL decoding uses fatal UTF-8 and requires
canonical re-encoding, so malformed byte sequences cannot be replaced by Unicode substitution characters before
hashing. Reopen also recomputes each worker's exact candidate environment from the bound genome and persisted source
audit path, then verifies the attested environment hash and complete canonical removed-key set. Observation summaries
are sorted by registered cell, scenario id, and candidate seat before aggregation and hashing, making parallel worker
completion order irrelevant to durable replay.

`v0_7_aligned_96h_v2_orchestrator_persistence.ts` uses an immutable `run.json`, contiguous canonical transition
files named `transitions/000000-<event-sha256>.json`, an atomic `CURRENT` pointer, and a chain-derived
`TERMINAL.json`. Transition files are authoritative. If a crash occurs after transition publication but before the
pointer replacement, exact replay validates the new event and repairs the stale pointer. A missing/ahead/forked
pointer, a transition gap or fork, noncanonical bytes, or evidence that no longer replays fails closed.

`v0_7_aligned_96h_v2_filesystem_resolvers.ts` supplies the concrete restart resolvers. Seed artifact references carry
both raw-file `bytesSha256` and allocator-envelope `artifactSha256`; both must match. Evidence references must be
safe paths below one sealed artifact root. Every shard is reopened through its manifest, raw/audit/checkpoint replay,
and exact candidate/seed-plan binding. A panel is accepted only when its artifact set contains one complete,
contiguous partition with no mixed shard geometry.

## Finite Orchestration

`v0_7_aligned_96h_v2_catalog.ts` owns the production catalog: exactly 48 ordered candidates, the exact committed-20d
incumbent, and 256 training scenarios per cell. Its identity hashes every normalized behavior field while excluding
diagnostic labels. The catalog combines committed, multicohort, historical b9ce, and deterministic midpoint leaves
with bounded h4/h8/h12 search envelopes, 125/150/175 ms challenger deadlines, policy-factorial controls, ranged
overlays, shortlist controls, two placement-off controls, two matched melee-ranged-target controls, and calibration
controls. The historical b9ce leaf is loaded from and fingerprinted against its committed outcome artifact.

The melee-ranged-target controls are deliberately limited to weight `2` on dimension 57 with rapid-charge dimension
56 fixed at `0`. They are matched to the b9ce h8/s2/d150 and h12/s3/d150 profiles and replace the redundant b9ce-h4
and midpoint-h8 placement-off arms. Reused-seed W16 diagnostics found `(0,2)` at +0.71pp on round-1 mixed rosters,
exact parity on the heuristic distribution, and exact parity in seven of eight fixed templates; mage-fireline was
+0.80pp with a wide interval. Positive rapid-charge weight regressed the melee distribution, and the rider-EV router
was neutral-to-negative even in its forced cohort, so neither enters the catalog. The worker binds the accepted probe
as `V06_MELEE_DIMS=0,2` and `V06_MELEE_DIMS_VERSIONS=v0.7s`; the v0.6 opponent remains at its pristine vector.

`v0_7_aligned_96h_v2_orchestrator.ts` accepts a flexible finite catalog only in synthetic mode. Formal creation and
persisted replay derive the code-owned production identity themselves and reject any candidate omission, addition,
reorder, incumbent substitution, candidate limit other than 48, or training census other than 256 scenarios per
cell. Training, confirmation, and final panels are separate commitments. Candidate selection is deterministic:
operational and integrity eligibility first, then max-min decisive win rate, pooled decisive rate,
draw/Armageddon rate, and genome hash as the final tie-break. The selected candidate receives a self-hashed freeze
artifact.

The final seed plan cannot be revealed before that freeze. The reveal transition binds the allocator commitment,
raw/semantic reveal hashes, frozen genome, freeze self-hash, and the cross-panel disjoint seed-set fingerprint.
Persisted replay reopens the allocator artifacts and recomputes all three panel bindings and disjointness. Deadlines
are immutable, commands are content-addressed and idempotent, and every terminal remains research-only with bake and
deploy disabled.

`runV07AlignedV2SyntheticOrchestrationDryRun` exercises train, freeze, final-plan reveal, and confirmation using only
caller-injected rows and plans. It starts zero workers, executes zero games, generates no seed material, performs no
outcome-driven allocation, and reaches the expected research-only HOLD terminal.

## Exact Runner And Bootstrap

`v0_7_aligned_96h_v2_runner.ts` is the single allowlisted optimizer entry. It re-ingests the exact local/Zinc scan
bytes and committed manifest census, reproduces the pre-bound allocation, immutably publishes the commitment before
orchestrator initialization or evaluation, reopens completed deterministic shards before scheduling missing work,
and gives every attempt a unique audit directory. Every ledger load and append uses the filesystem seed/evidence
resolvers. The finite lifecycle is train, deterministic freeze, final reveal, paired confirmation, optional final
qualification, and a strict research-only terminal.

The game-free bootstrap command reads one self-hashed runner config and one self-hashed definition input containing
the immutable schedule, raw composed-seal hash, and an exact copy of the code-owned catalog and incumbent. The formal
orchestrator recomputes and compares the catalog rather than trusting a declared count or fingerprint:

```bash
bun src/simulation/optimizer/v0_7_aligned_96h_v2_runner.ts \
  --prepare-definition \
  --config=/absolute/path/to/runner-config.json \
  --definition-input=/absolute/path/to/definition-input.json \
  --prepared-dir=/absolute/unique/prepared-bundle
```

It atomically publishes a staging directory containing `seed-allocation/commitment.json`, `definition.json`, and a
self-hashed `bundle.json`. The bundle reports zero games and workers and contains no final plan or final seed. The
supervisor requires `--prepared-bundle=.../bundle.json`, rejects any extra or missing staged entry, and requires the
staged definition, commitment, composed seal, config, rate attestation, and recomputed budget to match the bundle. After
supervisor initialization, the runner recomputes and compare-or-creates the same commitment bytes under the lifecycle
output root.

Throughput is not accepted as a bare configured rate. The config binds a canonical measurement attestation to the
measured commit, complete runtime source-tree hash, Bun executable/version/revision, dependency and lockfile hashes,
current host fingerprint, actual `availableParallelism()`, worker/shard geometry, exact
throughput/runner/evaluator/worker/game-adapter/persistence/protocol/allocator/catalog source bytes, sample size,
per-batch elapsed time, and derived per-worker rate. Formal mode accepts only the schema-2 replayable attestation;
schema-1 summary fixtures remain confined to the game-free synthetic preflight. The runner and supervisor resolve the
attested external evidence root below the config directory, verify the raw and semantic `evidence.json` hashes, and
reopen the complete root on every immutable-input validation. The supervisor also requires the provenance fields to
equal its immutable launch provenance. Budget validation reserves at least 36 hours for final evaluation and requires
the maximum deterministic shard to fit the configured timeout at the attested rate after utilization and safety
margins. Shard execution uses the earlier of that timeout and the immutable phase deadline.

The formal measurement consumes an externally allocated, already-spent diagnostic plan with exactly 256 scenarios in
each of the twelve cells and both candidate seats: 6,144 games total. It runs the frozen worst-cost catalog arm at the
exact production worker, concurrent-shard, shard-size, and timeout geometry. Eight sequential balanced batches each
contain 32 scenarios per cell. Every shard is persisted and reopened through the production evidence loader; the
attested rate is the minimum of the eight batch rates, not the pooled mean. The attestation content-addresses the
canonical diagnostic plan, its never-formal spent-seed receipt, and the complete replayed evidence manifest. These are
external run inputs and do not alter the frozen repository manifest census.

The only supported measurement entry point captures the same clean-pushed-main provenance as the supervisor, requires
fresh outputs outside the repository, runs real Bun workers, replays all eight batches, and writes the attestation only
after that replay succeeds. The evidence directory must be a child of the attestation/config directory. Every geometry
value must be copied exactly into the reviewed production runner config:

```bash
bun src/simulation/optimizer/v0_7_aligned_96h_v2_throughput.ts \
  --out=/absolute/external/aligned-v2-inputs/throughput-evidence \
  --attestation=/absolute/external/aligned-v2-inputs/throughput.json \
  --reserved-cpus="$RESERVED_CPUS" \
  --workers-per-shard="$WORKERS_PER_SHARD" \
  --concurrent-shards="$CONCURRENT_SHARDS" \
  --max-scenario-pairs-per-shard="$MAX_SCENARIO_PAIRS_PER_SHARD" \
  --shard-timeout-minutes="$SHARD_TIMEOUT_MINUTES"
```

The utility copies and re-expands the frozen
`src/simulation/manifests/v0_7_composed_ranked_ladder_20260716.json` bytes through
`expandV07AlignedV2CommittedManifest`. Its ascending 268,288-seed prefix is already part of the mandatory production
denyset census, so this diagnostic use cannot become formal evaluation material.

`runner.heartbeat.json` is runner-owned, canonical, self-hashed, and atomically replaced before/after every shard and
orchestration transition, at worker starts, and at most once per minute while a shard is running. Its completed
counters are absolute values derived from persisted shard manifests, so restart reuse does not double count progress.
The runner outcome exposes those durable totals as `persistedGames` and `persistedShards`. Newly executed games and
worker starts are invocation-local `invocationGamesExecuted` and `invocationWorkersStarted`; reused shards and the
synthetic preflight report zero for those invocation counters. A terminal outcome recomputes remaining capacity from
the strict terminal state, so every phase-game remainder is zero.

## Required Before Zinc

The implementation is not yet authorized to run. The following remain mandatory:

1. Exercise the now-bound bootstrap/config/attestation environment and runner-owned heartbeat through the complete
   supervisor process boundary in a game-free preflight, including restart and stale-progress rejection.
2. Run the direct measurement entry point on the exact Zinc host and produce the schema-2, 6,144-game, eight-batch
   replayable throughput attestation used by the production config. The tiny real-Worker adapter/audit/persistence
   smoke proves the path executes but cannot establish the formal mixed-cell rate or shard timeout.
3. Exercise the runner's late-production-launch rejection and dynamic remaining-capacity checks through the supervisor
   process boundary, including a restart with reused shards and a deliberately impossible remaining schedule.
4. Bind the optimizer entry, clean pushed-main revision, dependency/runtime/source hashes, candidate catalog,
   config/attestation, seed corpus/commitment, supervisor configuration, and output layout into one reviewed launch
   seal. Exercise bootstrap, supervisor launch protocol, runner heartbeat enforcement, and terminal replay without
   real seeds or games.
5. Preserve terminal-publication grace before the outer child-guard deadline and verify deadline cancellation leaves
   no worker process alive.
6. Ranked-wrapper reconciliation is complete and does not block this research-only offline run. After candidate
   selection, deployment remains blocked on a structured server profile, a match-scoped search-driver lifecycle,
   complete environment isolation, an exact common commit pin, and authoritative server replay with captured search
   seeds. An offline PASS does not itself establish live-server parity.
7. Only after the composed guard passes on clean pushed `main`: allocate real committed seeds once, launch the owned
   supervisor process group, and record the launch receipt. No real seed allocation or experiment launch has occurred.

No Zinc command should be produced or started until these pieces exist and the composed guard has emitted its final
sealed evidence.
