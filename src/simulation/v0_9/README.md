# v0.9 offline training and qualification

v0.9 is an isolated research pipeline. The RTX 5090 trains a small fixed-point candidate ranker, while
the shipped policy performs integer inference on the CPU. Nothing in this workflow changes the v0.8
artifact or promotes v0.9 automatically.

## Invariants

- Start from a committed, pushed, clean `heroes-of-crypto-common` checkout. Source, rules, roster, and
  v0.8 anchor fingerprints are frozen into the campaign.
- Use Bun `1.3.14` and install only from the tracked standalone `bun.lock`; dependency resolution is
  part of the frozen source identity.
- The only approved learner is
  `GPU-5126d018-ec86-be8b-1bf5-b5ac323d3350`. The host's CUDA order may expose the RTX 4090 first, so
  every learner launch pins the UUID rather than a numeric device index.
- The campaign uses its own Python 3.12 virtual environment with PyTorch `2.11.0+cu130` and NumPy
  `2.2.6`.
- Every initialization must name at least one reserved v0.8 output path with `--protect-v08-root`; repeat the
  option for every v0.8 root that must be protected. A v0.9 output may not equal, contain, or be contained
  by any protected root.
- Before campaign initialization, the otherwise-idle training host benchmarks exactly `20/22/23/24`
  physical actor lanes on a fixed, counterbalanced panel. The eligible sealed receipt freezes the selected
  worker count, topology, affinity-visible CPU IDs, source receipt, GPU UUID, and thermal evidence into the
  campaign. Teacher actors and training-host qualification then use those exact CPU IDs at nice level 10.
  Hosts with neither CPU temperature nor throttle telemetry require the explicit
  `--allow-missing-thermal-telemetry` benchmark override. It seals the absence of both signals and the user
  override into the receipt; it never fabricates thermal readings.
- Smoke IL is written only under `il-smoke/`. Full training reads only `il/`, so smoke shards cannot enter
  or satisfy a full-campaign corpus. Never copy, move, or symlink shards between those trees.
- Every orchestrator command holds the campaign's exclusive lease for its lifetime. Never run `smoke`,
  `launch`, `resume`, or individual stage commands concurrently against one campaign or qualification
  output.
- Qualification is split by exact preregistered ordinals: training host is shard `0/2`, production CPU
  is shard `1/2`. Shard `0/2` is included in an immutable, relocatable production handoff bundle; only its
  validated merge with shard `1/2` can qualify a model.
- The production server circuit breaker is 25 ms. The qualification gate is strict production-CPU turn
  p99 `<20 ms`; training-host latency is recorded but is not used as a production performance gate.

## Initialize once on the RTX host

`$CAMPAIGN` is the original training-host campaign path and is bound into its manifest. It does not need
to exist at the same path on the production host: the later production handoff is a separate relocatable
bundle.

```bash
cd /path/to/heroes-of-crypto-common

CAMPAIGN=/srv/hoc-ai/v0.9/campaign-001
SOURCE_RECEIPT=/srv/hoc-ai/v0.9/source-001.json
ACTOR_LANE_RUN=/srv/hoc-ai/v0.9/actor-lane-001
ACTOR_LANE_RECEIPT="$ACTOR_LANE_RUN/actor-lane-benchmark.json"
V08_OUTPUT=/srv/hoc-ai/v0.8

test "$(bun --version)" = "1.3.14"
bun install --frozen-lockfile --ignore-scripts
test -z "$(git status --porcelain=v1 --untracked-files=all --ignore-submodules=none)"

bun src/simulation/v0_9/source_identity.ts \
  --repository "$(pwd)" \
  --out "$SOURCE_RECEIPT"

# Run only on an otherwise-idle training host. This production audit serially
# measures 20/22/23/24 lanes and writes only to the fresh path above.
bun src/simulation/v0_9/actor_lane_benchmark.ts \
  --out "$ACTOR_LANE_RUN" \
  --repository "$(pwd)" \
  --source-receipt "$SOURCE_RECEIPT" \
  --gpu-uuid GPU-5126d018-ec86-be8b-1bf5-b5ac323d3350 \
  --protect-v08-root "$V08_OUTPUT"

# Only when the host exposes neither CPU temperature nor throttle telemetry:
# add --allow-missing-thermal-telemetry to the preceding benchmark command.

bun src/simulation/v0_9/supervisor.ts init \
  --out "$CAMPAIGN" \
  --repository "$(pwd)" \
  --source-receipt "$SOURCE_RECEIPT" \
  --actor-lane-receipt "$ACTOR_LANE_RECEIPT" \
  --gpu-uuid GPU-5126d018-ec86-be8b-1bf5-b5ac323d3350 \
  --protect-v08-root "$V08_OUTPUT"
```

Initialization fails if the checkout is dirty, the source receipt is stale, the GPU UUID differs, or
the output overlaps a protected v0.8 root. It also rejects a fixture/ineligible benchmark, changed source
or topology, or selected CPU IDs outside the current affinity. The accepted benchmark is copied into the
campaign as immutable evidence. `--protect-v08-root` is mandatory even when the intended campaign path
appears unrelated to v0.8.

## Fail-closed smoke

The smoke executes the real actor, CUDA learner, fixed-point sealer, Python/TypeScript parity check,
both DAgger stages, and one bounded development qualification pair:

```bash
bun src/simulation/v0_9/orchestrator.ts smoke \
  --campaign "$CAMPAIGN" \
  --repository "$(pwd)"
```

If interrupted, use the explicit resume mode:

```bash
bun src/simulation/v0_9/orchestrator.ts smoke \
  --campaign "$CAMPAIGN" \
  --repository "$(pwd)" \
  --resume
```

Do not start the full campaign unless this smoke succeeds. Smoke actor data remains under
`$CAMPAIGN/il-smoke`; the full run starts and validates its own `$CAMPAIGN/il` shards and cannot consume
the smoke IL.

## Unattended training-host run

```bash
nohup bun src/simulation/v0_9/orchestrator.ts launch \
  --campaign "$CAMPAIGN" \
  --repository "$(pwd)" \
  >"$CAMPAIGN/orchestrator.log" 2>&1 &
```

The chain is:

1. pinned environment bootstrap and exact RTX 5090 preflight;
2. wide v0.8+a13 shadow-teacher corpus;
3. `64x32`, `96x48`, and `128x64x32` fits on the identical corpus;
4. deterministic fixed-point validation selection;
5. DAgger round 1, refit, and parity;
6. DAgger round 2, QAT refit, sealing, and parity;
7. training-host qualification shard `0/2`;
8. an immutable, relocatable production-CPU handoff bundle containing the selected research artifact,
   frozen campaign/source/seed identities, and the complete shard `0/2` journal and receipt.

An interrupted run is resumed without replacing accepted shards or changing model bindings:

```bash
nohup bun src/simulation/v0_9/orchestrator.ts resume \
  --campaign "$CAMPAIGN" \
  --repository "$(pwd)" \
  >>"$CAMPAIGN/orchestrator.log" 2>&1 &
```

`launch`, `resume`, and full actor-stage commands reject any worker count other than the receipt's immutable
selection. Smoke always uses the policy's four-lane prefix. Omitting `--workers` from a training-host command
selects the immutable target automatically; supplying it is useful as an operator-visible cross-check.

GPU samples are persisted every two seconds. Because the deployable ranker is intentionally tiny and
JSONL-fed, the hardware gate expects short GPU bursts rather than pretending an RTX 5090 must hold 50%
median utilization. A full learner instead requires enough steady samples, observable mean/p95/peak
activity, CUDA memory use, and stable positive end-to-end examples per second. Receipts include the exact
policy thresholds, device/runtime identity, every utilization summary, memory, temperature, throughput,
and any gate failures.

The orchestrator's exclusive campaign lease rejects a second live owner. A dead local owner's lease is
preserved as a stale record; an unreadable lease or one owned by another host requires manual inspection
instead of being silently removed.

## Production-CPU shard, merge, and return

Do not copy the campaign and do not recreate its absolute path. Transfer only the immutable bundle
recorded in `$CAMPAIGN/receipts/training-host-complete.json`; it may be placed at any path on the
production host. The bundle has an exact hash-checked file set, rejects symlinks and extra files, and
already contains training-host shard `0/2`.

Use an isolated clean checkout at the exact source commit recorded by the bundle, and choose a fresh
output outside the bundle. Prefer a non-serving clone of the production machine with the same CPU SKU,
topology, OS, and runtime. Do not run qualification inside the server process.

```bash
cd "$PROD_REPOSITORY"

bun src/simulation/v0_9/orchestrator.ts qualification \
  --bundle "$BUNDLE" \
  --out "$PROD_OUT" \
  --repository "$PROD_REPOSITORY" \
  --node-role production_cpu \
  --workers 1
```

`--bundle`, `--out`, `--repository`, `--node-role production_cpu`, and the explicit `--workers 1` are
required. Production qualification rejects `--campaign`, `--artifact`, smoke mode, a non-Linux host, or
more than one worker.

Using a live 2-vCPU `hocw` is an exception, not the default. If no non-serving same-SKU clone is available,
the operator must enforce all of these conditions:

1. Complete the operational preflight before launch: verify the exact isolated clean checkout and
   bundle, confirm `lscpu` exposes at least two distinct physical cores, record a healthy serving
   load/SLO baseline, and confirm there are no active matches.
2. Drain new matches and keep an active-match guard running for the entire qualification. Do not start
   with an active match.
3. Launch only through the command above. The orchestrator pins the single worker to one physical core
   with `taskset` and runs it at nice level `>=10`, leaving the other physical core reserved for serving
   and the OS.
4. Continuously watch host load, the active-match guard, and serving latency/error SLOs. Abort
   qualification immediately if a match becomes active, the load guard trips, or any serving SLO
   changes from its accepted baseline. Evidence from such a run is not eligible for promotion.

The command runs production shard `1/2`, validates the bundled training-host shard `0/2`, merges both
immutable journals and receipts, and enforces every gameplay and production-latency gate. A successful
fresh output contains `production-return-manifest.json`, which binds the production shard journal and
receipt plus the merged summary, and a `qualified_offline_not_promoted` receipt. Return that manifest
and every file it names to the training host; transferring the complete fresh `$PROD_OUT` directory is
the simplest way to preserve their layout. Production qualification never installs the model.

## Reviewed promotion

Promotion happens only back on the training host, against the original `$CAMPAIGN` and its original
research artifact and shard `0/2`. Place the returned production output in a reviewed evidence directory,
keep `production-return-manifest.json` with it, and verify the manifest's file hashes before promotion.
Only after the returned merged summary passes with no failures:

```bash
bun src/simulation/v0_9/promote.ts \
  --research "$FINAL_RESEARCH_ARTIFACT" \
  --summary "$RETURNED_PROD/qualification/<model-prefix>-merged/qualification-summary.json" \
  --shard-dir "$CAMPAIGN/qualification/<model-prefix>-training-host-s0of2" \
  --shard-dir "$RETURNED_PROD/qualification/<model-prefix>-production-cpu-s1of2" \
  --campaign "$CAMPAIGN" \
  --repository "$(pwd)" \
  --out "$CAMPAIGN/models/v0.9-promoted-reviewed.json"
```

Promotion revalidates both immutable shard receipts, both raw journal hashes, the merged evidence,
source identity, 48k confirmation games, 48k qualification games, zero gate failures, and the strict
production-CPU p99. It also proves that adding the qualification receipt did not change the inference
function. Neither qualification nor promotion installs, activates, commits, restarts, or deploys the
model; deployment is always a separate reviewed operation.
