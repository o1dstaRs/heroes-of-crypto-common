# v0.7 overnight active/circuit follow-up

This is a bounded, research-only follow-up to the `d68490a` 96-hour run. It starts from that run's late
`b9ce98a735b1` genome and tests whether a smaller search budget, an active-challenger filter, and an opt-in
immediate-leaf shortlist can retain the melee-magic gain while reducing fire/ranged Armageddon dependence and
preserving headroom below the ranked server's 300ms per-decision circuit. It cannot bake weights, change the
v0.7 default, commit, push, or deploy.

The driver is `src/simulation/optimizer/v0_7_overnight.mjs`; process lifetime remains owned by
`scripts/run_v0_7_96h.sh`. The committed `v0_7_96h_d68490a_outcome.json` is the default anchor and must contain
the exact `b9ce98a735b1` genome. A different or missing anchor fails closed.

## Why this profile set

The late b9ce replay cleared 90% point estimates in all eight templates, but its h24/r4 search had 927.3ms
p95 turn latency and severe fire/ranged Armageddon dependence. Small paired exploratory probes established a
real frontier:

- h4/r1 with caps 4/3/2 reached 101.5ms p95 and only 0.327% of turns above 300ms, but melee-magic utility was
  46.9% and ranged precision 65.9%;
- h24/r1 with the full b9ce caps reached 301ms p95 and 5.05% of turns above 300ms, with 72.6% utility;
- the active-challenger arm improved some stalled ranged outcomes but regressed other templates, so it is an
  arm rather than a presumed champion.

The scout therefore includes passive-allowed b9ce h24/r4, h24/r2, and h24/r1 references; active-only h24
r4/r2/r1 arms; active h4, h8, h12, h16, and h24 capped variants; and active h12/h16/h24 shortlist arms.
`SEARCH_SHORTLIST=K` scores every enumerated action once at the immediate post-action value leaf, retains the
incumbent, then sends only the best `K-1` legal challengers through the configured full horizon. Unset preserves
the original full-candidate search. The shortlist is experimental because the leaf may undervalue delayed
spell, buff, debuff, aura, and resource effects; strength and integrity gates remain binding. The active filter
only removes generated wait and defend challengers.

## Stages and gates

All stages use paired side swaps against v0.6, explicit per-turn audit rows, a 275ms internal circuit threshold,
and
fresh immutable seeds.

| Stage | Templates                           | Games/template | Purpose                                      |
| ----- | ----------------------------------- | -------------: | -------------------------------------------- |
| Scout | utility, fireline, ranged precision |             32 | map quality, attrition, and circuit frontier |
| Deep  | up to three Pareto representatives  |            128 | fresh-seed confirmation                      |
| Final | all eight fixed templates           |            256 | bounded research verdict                     |

Deep selection preserves three distinct representatives when available: best circuit-aware integrity utility,
best melee-magic utility, and lowest circuit-open game rate. The final profile is selected from completed deep
evidence whenever at least one deep profile finishes; otherwise the best completed scout is used.

The circuit emulator is default-off (`SEARCH_CIRCUIT_BREAKER_MS` absent or non-positive). In this job it is set
to 275ms and paired with a 240ms fail-closed work deadline. The deadline is checked between candidates, rollout
actions, and simulated turns. An incomplete comparison restores the snapshot and returns the exact incumbent,
leaving 35ms for restoration and call-site overhead. Without that deadline, the first over-budget search result
still applies and all later search decisions in that match return the incumbent by reference. This remains a
lower-bound timing model: the production wrapper's 300ms interval also includes overhead outside the driver's
internal timer. The margin is mandatory qualification headroom, not a claim of exact timing equivalence.

A research candidate qualifies only when the final panel has all of the following:

- all eight template and all four equal-template cohort point estimates at least 90%;
- all four cohort simultaneous one-sided lower bounds at least 90%, using the trial's conservative
  eight-claim Bonferroni threshold;
- candidate rejections and missing rejection counts equal zero;
- maximum template draw-or-Armageddon rate at most 1%;
- circuit-open game rate at most 1% and audited p95 searched-turn latency at most 275ms;
- p95 and maximum per-match search time at most 240 seconds.

These are research gates, not bake or deployment authorization.

## Seeds, checkpoints, and terminal

Initialization takes the same parent `flock` used by the 96-hour allocator. It expands every committed v0.7
manifest and every sibling `seed-manifest.json`, then allocates scout, deep, and final streams in one locked
transaction before any outcome is opened. Each panel reserves all eight template streams even when scout or
deep evaluates only the three focus templates.

The evaluator checkpoints complete paired 32-game subshards. Each checkpoint binds run, panel, revision,
behavior environment, spec, cell hash, and audit-fragment hash. Turn rows carry seed and side identity;
resume reconstructs the aggregate audit only from atomically completed fragments, rejects duplicate or missing
game keys, and cannot double-count an interrupted shard. Child evaluators explicitly set
`BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`, Bun's documented runtime transpiler-cache disable switch.
Audit summaries expose enumerated and full-horizon candidate totals, their ratio, and the configured shortlist,
so reduced latency cannot be admitted without disclosing how much search work was pruned.

`run.json` freezes the Bun version and a hash-complete inventory of installed `package.json` manifests, and
every restart enforces both before opening evidence. The immutable seed manifest contains enough validated
bootstrap identity to reconstruct the same `run.json` if initialization is interrupted between those two
atomic writes. Persisted state never supplies ranking data directly: each report and turn audit is revalidated
and rehashed first, and its report timestamps must be ordered and completed inside that stage's fixed cutoff.

`TERMINAL.json` is atomic, run-bound, and canonically self-hashed. It records all simultaneous cohort lower
bounds together with the observed and certified 90% verdicts. Its terminal states are:

- `qualified_research_candidate`: every final research gate passed;
- `no_qualified_candidate`: final completed but at least one gate failed;
- `final_incomplete_deadline`: the fixed deadline closed before a complete final panel.

Every terminal explicitly records `bake: false`, `deploy: false`, and `productionDefaultChange: false`.
No qualified or no-qualified final verdict may be emitted after the persisted deadline; a late completion is
terminalized as `final_incomplete_deadline` instead.

## Host contention quarantine

Latency evidence is decision-grade only on an isolated host. The overnight launch therefore explicitly enables
the supervisor's host guard. Guard settings are immutable for one output: the first safe preflight persists the
enabled flag, idle-CPU threshold, sample interval, check interval, and helper protocol. Every resume must provide
the exact same settings. A guarded output cannot be resumed without its guard, and a previously unguarded output
cannot have the guard added later; use a fresh output instead.

Preflight and every cumulative five-second window require at least the configured number of idle CPU equivalents.
The boundary is inclusive: exactly the configured count passes, while any lower value rejects. CPU counters are
carried from one check to the next, so CPU work between process snapshots is still accounted for. CPU-count drift,
counter regression, an unreadable baseline, `os.cpus()` failure, or `ps` failure fails closed. The process snapshot
also rejects any non-zombie Bun/Node HoC simulation and any actual `run_v0_7_96h.sh` wrapper. A sleeping HoC job is
intentionally forbidden because it can wake between checks. Inline shell command text is not treated as a live
wrapper, and the current supervisor PID plus the optimizer's entire `setsid` process group are excluded.

Before preflight or optimizer spawn, the supervisor atomically writes `SUPERVISOR_HOST_GUARD_ARMED`. If contention
or a probe failure occurs, it first renames that sentinel to
`SUPERVISOR_HOST_CONTENTION_QUARANTINE`, then stops and verifies disappearance of the complete optimizer process
group. The heartbeat becomes `host-contention-quarantined` and the assessment is recorded in the marker and log.
The quarantine marker wins over `TERMINAL.json` and deadline markers based on existence, even if its contents are
damaged. It is permanent for that output. A stale armed sentinel after a crash or `SIGKILL` is promoted to the same
permanent quarantine on the next invocation, so partial checkpoints from an unmonitored interval cannot resume or
be accepted. The armed sentinel is removed only after a completed safe assessment and verified controlled stop.

The probe itself is portable across macOS and Linux, using fresh-runtime `os.cpus()` counters and portable `ps`
columns. The supervisor retains its existing fail-closed command requirements (`flock`, `setsid`, and a `realpath`
with `-m` support); stock macOS does not provide all three, so compatible commands must already be on `PATH` before
launch. Missing commands stop before the output is opened.

## Launch on Zinc

Start only after the prior run has a validated terminal and the common outcome/runner commit is pushed on
`main`. Use a clean Zinc checkout whose `HEAD` equals `origin/main`. The output must be a sibling of the prior
run so seed allocation sees its manifest.

```bash
cd "$HOME/hoc-common-v07-overnight"
git fetch origin main
git merge --ff-only origin/main
bun install --no-save
test -z "$(git ls-files -- bun.lock bun.lockb)" && rm -f bun.lock bun.lockb
test -z "$(git status --porcelain --untracked-files=all)"

OUT="$HOME/hoc-common-v07-96h-runs/run-overnight-$(date -u +%Y%m%dT%H%M%SZ)"
nohup env \
  BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
  V07_96H_OUT="$OUT" \
  V07_96H_HOURS=12 \
  V07_96H_OPTIMIZER=src/simulation/optimizer/v0_7_overnight.mjs \
  V07_96H_HOST_GUARD=1 \
  V07_96H_HOST_GUARD_MIN_IDLE_CPUS=8 \
  V07_96H_HOST_GUARD_SAMPLE_MS=1000 \
  V07_96H_HOST_GUARD_CHECK_SECONDS=5 \
  V07_OVERNIGHT_WORKERS=12 \
  V07_OVERNIGHT_CHECKPOINT_GAMES=32 \
  V07_OVERNIGHT_SCOUT_GAMES=32 \
  V07_OVERNIGHT_DEEP_GAMES=128 \
  V07_OVERNIGHT_FINAL_GAMES=256 \
  V07_OVERNIGHT_DEEP_KEEP=3 \
  V07_OVERNIGHT_FINAL_RESERVE_HOURS=4 \
  V07_OVERNIGHT_DECISION_DEADLINE_MS=240 \
  V07_OVERNIGHT_CIRCUIT_MS=275 \
  scripts/run_v0_7_96h.sh >/dev/null 2>&1 &
printf 'launcher pid=%s out=%s\n' "$!" "$OUT"
```

Twelve workers use half of Zinc's 24 physical cores and avoid oversubscribing the latency experiment. The fixed
12-hour deadline is an upper bound and is never extended. This driver executes one scout/deep/final funnel and
exits as soon as it writes a terminal; it does not deliberately consume unused time or start another adaptive
round. Actual wall time therefore depends on host speed and profile cost. Completed shards remain valid evidence
if the final is incomplete.

For the local 16-core M4 Max, retain 12 workers but set `V07_96H_HOST_GUARD_MIN_IDLE_CPUS=2`. This preserves a
small inclusive idle-capacity floor after the optimizer's own load. Do not reuse a Zinc output or change the
threshold after the first safe preflight.

Status and stop semantics are unchanged from the 96-hour supervisor:

```bash
cat "$OUT/supervisor.heartbeat"
cat "$OUT/supervisor.host_guard.config"
cat "$OUT/heartbeat"
tail -n 100 "$OUT/supervisor.log"
tail -n 100 "$OUT/optimizer.log"
tail -n 100 "$OUT/driver.log"
test -f "$OUT/TERMINAL.json" && cat "$OUT/TERMINAL.json"

# Stop the supervisor, which owns and otherwise restarts the optimizer.
kill -TERM "$(cat "$OUT/supervisor.pid")"
```

If `SUPERVISOR_HOST_CONTENTION_QUARANTINE` or a stale `SUPERVISOR_HOST_GUARD_ARMED` exists, that output is
irrecoverable by design. Preserve it for audit and start a new output after the host is isolated.
