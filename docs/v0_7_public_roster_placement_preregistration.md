# v0.7 public-roster placement promotion preregistration

Recorded at `2026-07-17 21:21:10 PDT`, before opening any targeted-cohort
result. This guard asks whether v0.7 should replace its partial draft-reveal
placement context with the complete roster that is public to both ranked seats
once placement begins. It does not authorize opponent private state, a setup
counter-pick, or an automatic deployment.

## Frozen behavior

- Control: frozen `v07-nonfight-4eda84635fe7` with placement
  `legitimate-reveal`.
- Candidate: the same artifact with only placement changed to `public-roster`.
  Its canonical behavior is `v07-nonfight-0847c0fa7739`, SHA-256
  `0847c0fa77398a806f1e67da0760b619dde4ae5210304cdcfaad1d8daa2ead84`.
- Both arms use the same shipped draft, artifacts, augments, synergies, v0.7
  combat policy, map, roster, pick seed, battle seed, and 60-lap cap.
- Candidate information is limited to deduplicated opponent creature ids. It
  excludes opponent positions, amounts, stats, perk, artifacts, augments,
  synergies, turn flags, and all live engine objects.
- Each board is crossed over both pick seats and both battle colors. The board
  is the independent statistical cluster.

## Frozen panels

- Natural guard: 5,000 unfiltered boards (20,000 games per arm), base
  `97171710`, panel `guard`. It ran from behavior source
  `33c9d6f5a47afbb8e29290426684f079215bf4b2`; the later commit below adds
  target allocation and tests without changing either arm's placement logic.
- Target guards: 1,000 outcome-blind accepted boards (4,000 games per arm) for
  each of `ranged`, `mage`, `melee-magic`, `aura-heavy`, and `melee-other`,
  base `97171710`, panel `guard`, source
  `af5cf74b35d76fcbac3397e12b2f8cb4ae84cee8`.
- Target allocation inspects draft composition only. No fight outcome is
  observed while accepting boards.
- The three live maps are `NORMAL`, `LAVA_CENTER`, and `BLOCK_CENTER`.

The raw reports and their byte hashes must be retained. A derived promotion
report may summarize them, but may not replace or rewrite them.

## Promotion bars

All bars must pass:

- Natural paired score gain is at least `+0.50pp` and its clustered 95% lower
  bound is strictly above zero.
- The natural actionable slice has at least 5,000 games, paired score gain at
  least `+2.00pp`, and clustered 95% lower bound strictly above zero.
- Every live map has a nonnegative paired point estimate and a clustered 95%
  lower bound above `-0.25pp` on the natural guard.
- Each of the five targeted groups has a nonnegative paired point estimate and
  a clustered 95% lower bound above `-1.50pp`.
- Candidate and control each have zero rejected actions. No failed game may be
  omitted.
- In the natural panel and each target, candidate draw incidence and
  Armageddon incidence may not exceed matched control by more than `1.00pp`.
  Candidate average duration may not exceed control by more than one lap.
- A replay sample must reproduce the same setup and complete behavior-trace
  hashes. Public-context hidden-state invariance tests must pass.

Failure remains research evidence and leaves the incumbent unchanged. Passing
permits review, a separately committed immutable artifact, full common/server/
client gates, and a staged deployment in which code is deployed before the
production policy environment is changed.

## Mainline rebalance amendment

Before the targeted result was used for promotion, common commit
`99360a273ed30c6aab4415f8f7ba77b18795e183` changed the combat effects of three
Tier-2 artifacts. The panels above are therefore retained as historical
diagnostic evidence only. They cannot promote a policy on or after that commit.

A replacement guard keeps every bar above and changes only the source and seed
stream:

- Behavior source starts at `99360a273ed30c6aab4415f8f7ba77b18795e183`.
  Later source commits are allowed only when their diff is limited to this
  preregistration, setup-context types/constructors, the explicit frozen
  placement candidate, and research/test plumbing. No combat, draft, scoring,
  placement, artifact-effect, or roster-generation change is allowed.
- Replacement base seed is `232221694`, panel `guard`. Under the panel's
  modulo-`2^30` permutation this is the old base advanced by exactly
  300,000,000 board indices. Replacement natural and target lanes therefore
  occupy the old stream's bounded ranges starting at 300m, 350m, 400m, 450m,
  500m, and 550m, disjoint from every opened range above.
- Sample sizes remain 5,000 natural boards and 1,000 accepted boards for each
  target. Sharding may change execution order but not the board ledger.
- Target qualification is calculated only from the candidate-seat records
  whose reconstructed drafted roster carries the requested inclusive
  diagnostic tag. `melee-other` remains the exact exclusive setup cohort.
  Draft reconstruction is outcome-blind and must match every persisted board,
  pick seed, pick seat, and control record before scoring.

No replacement outcome may be opened until this amendment is committed and
pushed. The replacement becomes ineligible if its final source diff exceeds the
allowlist above.

## Second mainline rebalance amendment

Common commit `12b62c8666c0cf5e95124d95d68e435f389f58c2` subsequently
changed Crown of Command, Pendant of Vitality, and Lava Striders. The first
replacement was stopped before completion as soon as that combat-changing
commit appeared. Its partial logs and any partial result are non-qualifying and
must not be pooled with another attempt.

The final replacement retains every behavior and promotion bar above with these
source and stream changes:

- Behavior source starts at `12b62c8666c0cf5e95124d95d68e435f389f58c2`.
  The same non-combat allowlist applies to later source commits.
- Base seed is `367271678`, panel `guard`. This is the original base advanced
  by exactly 600,000,000 board indices. Its natural and target lanes occupy the
  original stream's bounded ranges starting at 600m, 650m, 700m, 750m, 800m,
  and 850m. They do not overlap the original guard or the interrupted first
  replacement.
- Natural and target sample sizes, candidate-seat reconstruction, safety bars,
  and raw-report retention remain unchanged.

No final-replacement outcome may be opened until this second amendment is
committed and pushed. Any later combat-affecting mainline change invalidates the
run and requires a new untouched stream; no result may be grandfathered across
an engine or artifact-effect change.

## Seed arithmetic correction and cohort-safe selection

An audit before deployment found that the two replacement amendments advanced
the seed-channel stream, not the board stream. `publicRosterPlacementBoard`
consumes three consecutive `setupPanelSeed` indices per board, so changing a
base by `PANEL_STEP * K` advances only `K / 3` boards. Consequently:

- base `232221694` is the original base advanced by 300,000,000 seed channels,
  or 100,000,000 boards, not 300,000,000 boards;
- base `367271678` is the original base advanced by 600,000,000 seed channels,
  or 200,000,000 boards, not 600,000,000 boards.

Those replacement lanes overlap previously opened lanes at multiples of
50,000,000 board indices. Their reports remain deterministic selection and
diagnostic evidence, but are ineligible for promotion. The completed global
public-roster selection run also failed its frozen `melee-other` point-estimate
bar (`-0.40pp`, clustered 95% CI `-1.78pp` to `+0.98pp`), independently
rejecting global activation.

The selection evidence fixes the next candidate before a new result is opened:

- `ranged`, `mage`, `melee-magic`, and `aura-heavy` own-roster cohorts receive
  complete public opponent creature ids during placement;
- the exact exclusive `melee-other` cohort remains on the incumbent
  `legitimate-reveal` placement path;
- a roster carrying multiple inclusive diagnostic tags receives complete
  public opponent ids; only the exact `melee-other` fallback is excluded;
- draft, artifact, augment, synergy, combat, and all other placement behavior
  remain byte-for-byte identical to the incumbent.

The next untouched guard uses base `130934206`, which equals original base
`97171710` advanced by `3 * 25,000,000` seed channels. Its six lanes therefore
start at original board indices 25m, 75m, 125m, 175m, 225m, and 275m: the
midpoints between all previously opened 50m lanes. Target scans are bounded to
at most 2,000,000 boards, so these ranges are disjoint from every prior run.
Sample sizes, crossover design, target reconstruction, safety checks, raw
retention, and promotion bars stay unchanged. For `melee-other`, candidate and
control must additionally have identical placement decisions and complete
behavior traces.

No outcome from this cohort-safe guard may be opened until its runtime variant,
immutable behavior hash, source commit, and exact report commands are recorded
in a subsequent result-free amendment that is committed and pushed. Any
combat-affecting change after that source freeze invalidates the guard.

## Cohort-safe source freeze and execution amendment

Recorded before starting or opening any outcome from the cohort-safe guard.
This amendment supersedes the prior provisional source freeze after the final
Tier-2 Pendant adjustment and fixes the complete executable protocol:

- Source commit: `ddeaffbf9daf8743d93bb9cd57975f9d74bb6c17`.
- Candidate runtime setup spec: `v07-nonfight-5ae5533cea45`, full canonical
  behavior SHA-256
  `5ae5533cea4598be8e205a63681572180b6f06679b234ae4d242ff61dbeacd88`.
- Control remains `v07-nonfight-4eda84635fe7`. The production default remains
  the control while this guard runs.
- Base seed is `130934206`, start board is `0`, panel is `guard`, and the lap
  cap is `60` for every report.
- The natural report contains exactly 5,000 boards. Each of the five target
  reports contains exactly 1,000 outcome-blind accepted boards. The committed
  reducers must reconstruct every ledger and enforce the frozen artifact,
  protocol, sample size, failure, safety, and `melee-other` equivalence bars.

The exact Zinc report commands are:

```bash
ROOT="$HOME/hoc-cohort-safe-placement-20260718"
OUT="$ROOT/sim-out/cohort-safe-placement-ddeaffbf9daf"
BUN="$HOME/.bun/bin/bun"
PATH_CLEAN="$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"
cd "$ROOT"
test "$(git rev-parse HEAD)" = "ddeaffbf9daf8743d93bb9cd57975f9d74bb6c17"
test -z "$(git status --porcelain)"
mkdir -p "$OUT"

env -i HOME="$HOME" PATH="$PATH_CLEAN" LANG=C.UTF-8 LIVETWIN=1 V07_SEARCH=0 "$BUN" \
  src/simulation/measure_public_roster_placement.ts \
  --arm cohort-safe --boards 5000 --base-seed 130934206 --start-board 0 \
  --panel guard --target natural --workers 40 --max-laps 60 \
  --output "$OUT/report-natural.json"

env -i HOME="$HOME" PATH="$PATH_CLEAN" LANG=C.UTF-8 LIVETWIN=1 V07_SEARCH=0 "$BUN" \
  src/simulation/measure_public_roster_placement.ts \
  --arm cohort-safe --boards 1000 --base-seed 130934206 --start-board 0 \
  --panel guard --target ranged --workers 8 --max-laps 60 \
  --output "$OUT/report-ranged.json" &
env -i HOME="$HOME" PATH="$PATH_CLEAN" LANG=C.UTF-8 LIVETWIN=1 V07_SEARCH=0 "$BUN" \
  src/simulation/measure_public_roster_placement.ts \
  --arm cohort-safe --boards 1000 --base-seed 130934206 --start-board 0 \
  --panel guard --target mage --workers 8 --max-laps 60 \
  --output "$OUT/report-mage.json" &
env -i HOME="$HOME" PATH="$PATH_CLEAN" LANG=C.UTF-8 LIVETWIN=1 V07_SEARCH=0 "$BUN" \
  src/simulation/measure_public_roster_placement.ts \
  --arm cohort-safe --boards 1000 --base-seed 130934206 --start-board 0 \
  --panel guard --target melee-magic --workers 8 --max-laps 60 \
  --output "$OUT/report-melee-magic.json" &
env -i HOME="$HOME" PATH="$PATH_CLEAN" LANG=C.UTF-8 LIVETWIN=1 V07_SEARCH=0 "$BUN" \
  src/simulation/measure_public_roster_placement.ts \
  --arm cohort-safe --boards 1000 --base-seed 130934206 --start-board 0 \
  --panel guard --target aura-heavy --workers 8 --max-laps 60 \
  --output "$OUT/report-aura-heavy.json" &
env -i HOME="$HOME" PATH="$PATH_CLEAN" LANG=C.UTF-8 LIVETWIN=1 V07_SEARCH=0 "$BUN" \
  src/simulation/measure_public_roster_placement.ts \
  --arm cohort-safe --boards 1000 --base-seed 130934206 --start-board 0 \
  --panel guard --target melee-other --workers 8 --max-laps 60 \
  --output "$OUT/report-melee-other.json" &
wait

env -i HOME="$HOME" PATH="$PATH_CLEAN" LANG=C.UTF-8 "$BUN" \
  src/simulation/pool_public_roster_natural_guard.ts \
  --source-commit ddeaffbf9daf8743d93bb9cd57975f9d74bb6c17 \
  --expected-original-base-seed 130934206 --expected-start-board 0 \
  --expected-total-boards 5000 "$OUT/report-natural.json" \
  > "$OUT/natural-pooled.json"
env -i HOME="$HOME" PATH="$PATH_CLEAN" LANG=C.UTF-8 "$BUN" \
  src/simulation/summarize_public_roster_target_evidence.ts \
  --source-commit ddeaffbf9daf8743d93bb9cd57975f9d74bb6c17 \
  --expected-base-seed 130934206 --expected-start-board 0 \
  "$OUT/report-ranged.json" "$OUT/report-mage.json" \
  "$OUT/report-melee-magic.json" "$OUT/report-aura-heavy.json" \
  "$OUT/report-melee-other.json" > "$OUT/target-summary.json"
sha256sum "$OUT"/report-*.json > "$OUT/raw-report-sha256.txt"
jq -e '.gate.passed == true' "$OUT/natural-pooled.json"
jq -e '.promotionGate.passed == true' "$OUT/target-summary.json"
```

The five target processes may finish in any order; their seed ledgers and
reducer order are fixed above. A nonzero process or reducer exit, either failed
gate, any later combat-affecting source commit, or a dirty runtime checkout
invalidates the attempt. The raw reports stay immutable even on failure.
