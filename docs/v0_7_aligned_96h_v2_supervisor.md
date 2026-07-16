# v0.7 Aligned 96-Hour v2 Supervisor

Status: implementation-only. Research-only. This lifecycle must not be launched until the aligned optimizer entry,
orchestrator definition, source commit, and composed predecessor seal have been reviewed as one immutable launch set.
It never bakes weights or deploys a candidate.

## Two Independent Authorities

The composed predecessor `sealed-run.json` is an immutable evidence handoff. The supervisor requires the exact raw
SHA-256 committed by the aligned orchestrator definition and validates its guard ledger, guard timing, fixed
artifacts, cell evidence, manifest identity, final report, `guardPassed: true`, and exact recorded `PASS` or `FAIL`
qualification verdict. Either verdict remains evidence and is persisted verbatim in the aligned supervisor run
record.

That predecessor seal does **not** authorize source created after it was written. In particular, the seal is not
required or expected to contain the aligned optimizer entry hash.

Aligned launch authority is established separately at process start and rechecked before every optimizer attempt and
terminal acceptance. It requires:

- branch `main`, with `HEAD == origin/main ==` the live `ls-remote` result;
- the expected `heroes-of-crypto-common` origin and a clean status including untracked files;
- hashes of the complete tracked runtime source tree, the exact tracked aligned optimizer entry, and the lockfile;
- the exact Bun executable, version, revision, and installed dependency-package manifest;
- unchanged orchestrator-definition and composed-seal bytes.

This split prevents an older seal from granting authority over newer aligned code while retaining an exact,
tamper-evident predecessor handoff.

## Lifecycle Boundary

The shell entry acquires one host-wide nonblocking lock and one output-directory lock. The TypeScript supervisor then
performs host-idle and process-contention preflight, writes a self-hashed run record, and starts the optimizer under a
new `setsid` process group at the requested nice level. The child guard has three independent stop paths: supervisor
pipe closure, stale supervisor heartbeat, and the immutable 96-hour deadline.

The supervisor also rechecks host contention and provenance during execution. It owns the complete child process
group and sends TERM followed by bounded KILL cleanup. The setsid guard remains inert until the supervisor has durably
recorded the guard's process birth identity and sends an exact owner-token activation. This closes the crash window in
which an optimizer group could otherwise exist without a durable ownership record. A transient nonzero optimizer exit
can use bounded exponential restart. A zero exit without a replay-valid terminal, host/provenance failure, watchdog
exit, invalid evidence, or deadline creates a permanent refusal state and cannot restart.

`SIGINT`, `SIGTERM`, and `SIGHUP` perform controlled group cleanup without inventing a terminal or permanent refusal
marker. A subsequent invocation must still pass every immutable-input and host check.

## Supervisor Crash Recovery

The shell locks are reacquired by an external service wrapper or cron invocation after an abrupt supervisor or host
failure. A post-start invocation is accepted only when the existing canonical `supervisor-run.json` exactly matches
the requested immutable launch. The original pinned provenance remains authoritative even if the remote `main` branch
later advances.
The tracked `scripts/v0_7_aligned_96h_v2_keepalive.sh` is the cron entry. Before first launch it validates the prepared definition and stops once the immutable launch window closes. After initialization it delegates terminal and permanent-state validation to the supervisor, normalizes validated permanent outcomes, and retries exit 75.

Automatic stale-owner recovery is Linux-only and fail-closed. Armed and optimizer ownership records are canonical,
self-hashed, cross-bound by owner token, attempt, timestamp, run fingerprint, PID/PGID, and Linux birth identity. The
identity includes boot ID, PID namespace, start-time ticks, process group, and session. On the same boot, recovery
requires the recorded supervisor PID to be absent and the complete optimizer process group to return `ESRCH` after a
bounded guard-cleanup wait. A different boot ID proves the old processes no longer exist. `EPERM`, unreadable process
metadata, PID reuse, namespace ambiguity, malformed records, or cross-record mismatch never authorize deletion or a
signal to the recorded numeric PID/PGID.

Spawn durability has explicit `pre_activation` and `activated` armed states. The supervisor first records the inert
guard identity, then the matching PID record, then the `activated` state, and only then sends the activation token. A
missing PID record is recoverable only from a valid `pre_activation` record; the same absence under `activated` is a
permanent mismatch. This makes crashes after either pre-activation write distinguishable without weakening malformed
or rehashed-record rejection.

An exact live owner or a still-cleaning exact child group returns retryable exit 75 without mutating ownership.
Conclusive recovery first writes an immutable self-hashed audit under `supervisor-recoveries/`, then removes the stale
PID and armed records and restores the durable attempt number. A crash during that cleanup reuses the same audit and
cannot reset the restart limit. Non-Linux recovery requires manual review; it does not silently discard ownership.

## Output Contract

The lifecycle container is the requested output directory. Strict orchestration evidence lives only in its
`orchestrator/` child, whose terminal inventory is exactly:

```text
CURRENT
TERMINAL.json
quarantine/
run.json
transitions/
```

Lifecycle files such as `supervisor-run.json`, self-hashed heartbeats, recovery audits, the optimizer log, locks, and permanent
`SUPERVISOR_INVALID.json`, `SUPERVISOR_QUARANTINED.json`, or `SUPERVISOR_DEADLINE.json` markers remain siblings of
`orchestrator/`. Seed and shard evidence also remain outside the strict orchestration root and are admitted only by
their content-addressed resolver contracts.

Terminal success requires replay of every canonical transition from the immutable definition. `TERMINAL.json` and
`CURRENT` must exactly bind the replayed event head, sequence, terminal hash, and research-only status. A terminal
never authorizes automatic bake or deploy.

## Launch Shape

First, produce the exact-host throughput input outside the clean lifecycle output directory:

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

This command is valid only from clean pushed `main`. It consumes the frozen never-formal diagnostic seed source,
executes 6,144 real games as eight sequential balanced batches, persists and reopens every shard, and writes
`throughput.json` only after strict replay. The runner config must use the same geometry and bind the attestation's raw
and semantic hashes. Formal mode rejects the smaller schema-1 synthetic fixture.

Then prepare the definition without touching the lifecycle output directory:

```bash
bun src/simulation/optimizer/v0_7_aligned_96h_v2_runner.ts \
  --prepare-definition \
  --config=/absolute/path/to/runner-config.json \
  --definition-input=/absolute/path/to/definition-input.json \
  --prepared-dir=/absolute/unique/prepared-bundle
```

`prepared-bundle/bundle.json` binds raw and semantic runner-config hashes, the exact-code/host throughput attestation,
the composed-seal bytes, the commitment, and the definition. It reports zero games and workers and does not contain
the final plan. The lifecycle output directory remains unused until supervisor initialization.

After that bundle and the launch set have been sealed and reviewed, the invocation shape is:

```bash
scripts/run_v0_7_aligned_96h_v2.sh \
  --out=/absolute/unique/aligned-v2-run \
  --prepared-bundle=/absolute/path/to/prepared-bundle/bundle.json \
  --definition=/absolute/path/to/prepared-bundle/definition.json \
  --composed-seal=/absolute/path/to/composed-predecessor/sealed-run.json \
  --runner-config=/absolute/path/to/runner-config.json \
  --minimum-idle-cpus=4 \
  --optimizer-entry=src/simulation/optimizer/v0_7_aligned_96h_v2_runner.ts \
  -- --run --config=/absolute/path/to/runner-config.json
```

The supervisor requires the exact three-entry prepared directory inventory, replays the self-hashed `bundle.json`, and
requires its definition, commitment, composed seal, runner config, throughput attestation, and recomputed budget to
match the launch snapshots byte-for-byte and semantically. The path after `--runner-config=` and the path in the child
`--config=` argument must be the same absolute real path; the only accepted child mode is exactly one of `--run` or
`--preflight`. Fresh monotone `runner.heartbeat.json` advancement is optimizer progress; the default progress watchdog
is five minutes, covering five missed one-minute runner pulses, and remains configurable inside the fail-closed bounds.
For a production config, initial and repeated immutable-input validation also verifies the attested raw and semantic
`evidence.json` hashes and reopens the source receipt, exact 268,288-seed plan, eight batch plans/manifests, and every
persisted shard. The configured rate must equal the slowest complete batch at the exact launch geometry.
Do not allocate production seeds or start the 96-hour lifecycle before the representative throughput attestation,
terminal grace, and final aligned launch set are committed and pushed on clean `main`.
