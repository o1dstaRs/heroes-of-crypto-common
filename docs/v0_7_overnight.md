# v0.7 overnight active/circuit follow-up

This is a bounded, research-only follow-up to the `d68490a` 96-hour run. Protocol v6 starts from that run's late
`b9ce98a735b1` genome and tests whether a smaller search budget, an active-challenger filter, an opt-in
immediate-leaf shortlist, and a late ranged-finish overlay can retain the melee-magic gain while reducing
all-cohort deficits and fire/ranged Armageddon dependence while preserving headroom below the ranked server's
300ms per-decision circuit.
It cannot bake weights, change the v0.7 default, commit, push, or deploy.

The driver is `src/simulation/optimizer/v0_7_overnight.mjs`; process lifetime remains owned by
`scripts/run_v0_7_96h.sh`. The committed `v0_7_96h_d68490a_outcome.json` is the default anchor and must contain
the exact `b9ce98a735b1` genome. A different or missing anchor fails closed.

## Why this profile set

The late b9ce replay remains the explicit high-strength reference: it cleared 90% point estimates in all eight
templates, but h24/r4 had 927.3ms p95 turn latency, every game opened the production circuit diagnostic, and
ranged-precision draw/Armageddon was 85.156%. It is documented evidence only and consumes no v6 run budget.

Protocol v5 completed cleanly on revision `4d6ae016d111` and selected active h4/r1 caps-4/3/2. Its final
2,048-game panel was decisive in only 48.62%/52.55% of the two melee-mage templates, 71.09%/72.94% of the two
aura templates, 68.06% fireline, and 73.58% ranged precision. Overall circuit-open games were 3.42% despite a
168.5ms searched-turn p95; per-template rates reached 7.03%. The two h16 finish arms retained for deep evidence
opened circuits in 13.28% and 13.80% of games. V5 therefore produced no qualified candidate and showed that
three-template scout/deep selection can hide the final panel's melee-brawler and aura deficits.

V6 is a nine-profile, three-envelope block search with complete finish-weight trios in this exact sequential
order:

1. active h12/r1, shortlist 3, caps 6/4/2, weights 0/2/4;
2. active h8/r1, shortlist 2, caps 4/3/2, weights 0/2/4;
3. active h4/r1, shortlist 2, caps 4/3/2, weights 0/2/4.

H12 leads because the v5 h12/shortlist-4 scout had 0% circuit-open games and the strongest promising utility
point estimate; shortlist 3 and the tighter deadline buy additional headroom. H8 is the middle strength/latency
bridge, while h4 is the fallback envelope. H16 and every h24 arm are removed from executable v6 work because
their larger-sample circuit evidence falsified the strict 1% gate. Completing each weight trio before advancing
retains a paired comparison if the bounded scout is interrupted.
This is not a clean horizon factorial: the h12 block uses shortlist 3 and caps 6/4/2, while h8 and h4 use
shortlist 2 and caps 4/3/2. Comparisons are causal for finish weight only within one envelope.

`SEARCH_SHORTLIST=K` scores every enumerated action once at the immediate post-action value leaf, retains the
incumbent, then sends only the best `K-1` legal challengers through the configured full horizon. Unset preserves
the original full-candidate search. The shortlist is experimental because the leaf may undervalue delayed
spell, buff, debuff, aura, and resource effects; strength and integrity gates remain binding. The active filter
only removes generated wait and defend challengers.

Three otherwise identical profiles per envelope isolate late ranged-finish weights `finish-w0`, `finish-w2`,
and `finish-w4`. The zero arm retains the pre-overlay behavior. Every
profile, including unrelated references, fingerprints an explicit finite nonnegative `finishWeight` (default
zero), and every child receives its exact value through `SEARCH_LATE_RANGED_FINISH_WEIGHT`. This prevents an
inherited shell value or a missing field from changing behavior without changing profile identity.

The overlay adds `finishWeight * initialBoardRangedness * armageddonProximity * enemyOriginalHpDepletion` to the
candidate logit. `initialBoardRangedness` is fixed at battle initialization from original, non-summoned stacks;
it is the fraction of their starting cumulative HP across both teams carried by stacks whose attack type is
`RANGE`.
`enemyOriginalHpDepletion = 1 - clamp(current cumulative HP of the perspective's original enemy stacks / their
starting cumulative HP, 0, 1)`, so summons cannot manufacture finish pressure.
`armageddonProximity = clamp((lap - 3) / (12 - 3), 0, 1)`: it is exactly zero through lap 3, then increases
linearly to one on the first Armageddon lap, lap 12. A board with no original `RANGE` stack therefore gets an
exact zero overlay at every weight, preserving the mage-frontline, melee-mage, and aura cohorts while the
isolated arms test ranged finishing. Ineligible boards and laps through 3 take a fast path before the
per-original-unit HP scan; their finish-pressure leaf counters and logit sum remain exactly zero. This is an
experimental search feature, not a production default.

## Stages and gates

All stages use paired side swaps against v0.6, explicit per-turn audit rows, a 275ms internal circuit threshold,
and
fresh immutable seeds.

| Stage | Templates                       | Games/template | Purpose                                    |
| ----- | ------------------------------- | -------------: | ------------------------------------------ |
| Scout | all eight fixed templates       |             64 | all-cohort quality, integrity, and latency |
| Deep  | all eight; up to three profiles |            512 | fresh-seed confirmation                    |
| Final | all eight fixed templates       |          2,048 | powered bounded research verdict           |

Deep selection prioritizes the best all-eight circuit-aware integrity utility, best melee-magic utility, and
lowest circuit-open game rate. A weighted arm is admitted only when its same-envelope weight-zero control fits
inside the three-profile deep set, and that control runs first; specialty representatives that would leave an
unmatched weighted arm are skipped. Integrity utility is the minimum of the weakest template decisive rate and
one minus the worst template draw/Armageddon rate, so every mage, melee-mage, aura, and ranged template affects
ranking. The final profile is selected from completed deep evidence whenever at least one deep profile finishes;
otherwise the best completed scout is used.

The circuit emulator is default-off (`SEARCH_CIRCUIT_BREAKER_MS` absent or non-positive). In this job it is set
to 275ms and paired with a 200ms fail-closed work deadline. The deadline is checked between candidates, rollout
actions, and simulated turns. An incomplete comparison restores the snapshot and returns the exact incumbent,
leaving 75ms for restoration and call-site overhead. V5's 240ms deadline still allowed a 3.42% final circuit-open
rate, so v6 binds the lower default and profile contract explicitly. Without that deadline, the first over-budget search result
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
transaction before any outcome is opened. Every scout, deep, and final profile evaluates all eight reserved
template streams.

The evaluator checkpoints complete paired 32-game subshards. Each checkpoint binds run, panel, revision,
behavior environment, spec, cell hash, and audit-fragment hash. Turn rows carry seed and side identity;
resume reconstructs the aggregate audit only from atomically completed fragments, rejects duplicate or missing
game keys, and cannot double-count an interrupted shard. Child evaluators explicitly set
`BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`, Bun's documented runtime transpiler-cache disable switch, and always set
the profile's exact `SEARCH_LATE_RANGED_FINISH_WEIGHT` (including `0`).
Audit summaries expose enumerated and full-horizon candidate totals, their ratio, and the configured shortlist,
so reduced latency cannot be admitted without disclosing how much search work was pruned.

`run.json` freezes the Bun version and a hash-complete inventory of installed `package.json` manifests, and
every restart enforces both before opening evidence. The immutable seed manifest contains enough validated
bootstrap identity to reconstruct the same `run.json` if initialization is interrupted between those two
atomic writes. Persisted state never supplies ranking data directly: each report and turn audit is revalidated
and rehashed first, and its report timestamps must be ordered and completed inside that stage's fixed cutoff.
`bun src/simulation/optimizer/v0_7_overnight.mjs --describe-profiles` is a read-only contract view of all profile
IDs, labels, finish weights, and exact search environments; it does not open an output or start simulations.

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
  V07_OVERNIGHT_SCOUT_GAMES=64 \
  V07_OVERNIGHT_DEEP_GAMES=512 \
  V07_OVERNIGHT_FINAL_GAMES=2048 \
  V07_OVERNIGHT_DEEP_KEEP=3 \
  V07_OVERNIGHT_FINAL_RESERVE_HOURS=4 \
  V07_OVERNIGHT_DECISION_DEADLINE_MS=200 \
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
