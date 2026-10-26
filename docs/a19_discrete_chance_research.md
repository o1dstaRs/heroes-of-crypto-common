# Integer antithetics at the existing R2 budget

The independent R8 reference motivates reducing search noise without quadrupling the sample budget.
This study tests one fixed range-aware chance coupling, with **H64, two rollouts, the ordinary
six-action shortlist, native continuation, learned leaf and material-tie arbitration unchanged**.
It is research only; importing [a19_discrete_chance.ts](../src/simulation/a19_discrete_chance.ts)
does not install instrumentation, register a profile or change a random source.

## Mechanical opportunity

Current actor/lap complementary R2 complements raw uint32 draws. `getRandomInt` combines them into
a 53-bit integer, rejects the incomplete modulo tail and takes the remainder for the requested range.
A raw complement is therefore not generally an integer complement: without rejection, raw values
zero and `2^53 - 1` become **0 and 91** in `[0, 100)`, rather than 0 and 99.

The candidate retains the existing actor/lap hash and seed. For a range of size `s`, let
`b = floor(2^53 / s)` and `L = b * s`. Redraw raw values outside `[0, L)` in both pair members.
Use integer bucket `floor(raw / b)` for rollout zero and `floor((L - 1 - raw) / b)` for rollout one.
Each outcome has exactly `b` accepted raw values. Under the ideal uniform-grid model, each marginal
remains uniform; equal-range aligned pairs sum to `min + max - 1`. The seeded generator retains its
finite-state limitations. Independent stream state remains local to each rollout.

This establishes the integer coupling, **not** lower battle-value or action-difference variance.
Antithetics and common random numbers need not improve every comparison; see
[Kleijnen, 1975](https://doi.org/10.1287/mnsc.21.10.1176).
No actual combat RNG, creature rule, damage range, proc probability or production utility is changed.
A frozen research export supplies a private range-aware dispatch seam absent from the shared `utils/lib.ts`.

## Registered development gate

The external `a19-discrete-chance-20261026` package freezes published common `9dde84d1` plus the
independently validated synergy-reference checkpoint repair, the inert sampler/test, and that export-only
seam. The repair's snapshot SHA-256 is
`853c22db253a8093637b38cc608363e046f9ff58e2d2e2be765795fed531fbb8`; it was unpublished when frozen.
The complete source/tool registration SHA-256 is
`43117c1f8aa41305f3de345dee3ac302dc9e6d6dbdff1496f2496e10e52742c3`.
No unrelated strategy or learner edits enter the capsule.

Twelve preflight games per arm compare stock with a discarded-computation control, and integer
checkpoint execution with full snapshots. Complete roots, native-array ownership, actions, events,
results and ranked records must match in each control pair. Every real root checks values, shared
references, unit instances/order, target memory, damage statistics, active unit and RNG/UUID restoration.

Twenty-four fresh offer boards supply 96 canonical seat/mirror games, balanced across Normal, Lava
and Block. At the controlled team's first eligible ordinary searched position, retain the exact shortlist.
Two disjoint independent R128 banks form a finite R256 value reference. Eight paired fresh seed
replicates compare stock R2 with integer R2. Actual play always returns stock's original decision;
96 additional diagnostic-disabled replays must exactly reproduce every complete trajectory.

The primary loss is squared error in each candidate-minus-incumbent value difference, averaged within
replicate, game and independent board. The fixed gate requires a loss ratio at most **0.90**, its upper
95% whole-board bootstrap bound below one, all 96 positions, and at least twenty nonzero-loss boards.
Use 20,000 map-stratified board resamples, seed `2730289001`. A separate Python implementation
reconstructs source receipts, all seed families, canonical seats, complete records and per-replicate losses.
Replicates and mirrored games are not independent strength samples.

Only a pass opens a separately reserved 1,008-game strength screen. General release additionally
requires fresh 6,000-game qualification, matched cost/live-latency work, unchanged 6,000-game
confirmation and authoritative serving checks. A failed diagnostic closes this fixed sampler without
another variant, threshold sweep, subgroup rescue or default change. Local execution uses at most four
workers; the contended host's timings cannot qualify speed. Puffalo's occupied workloads are untouched.

## Validation before diagnostic outcomes

The frozen research build passes **7,213 tests**, TypeScript and lint. Thirteen focused tests cover the
new integer grid and existing chance streams. The four preflight arms completed **48 full replays**:
all **24 exact control pairs** matched, with **2,398 real-root restoration checks** and **1,326,561
private integer-provider calls** in the integer checkpoint arm. A separate Python verifier reconstructed
the complete source/tool registration, every reserved seed family, canonical seat/map records and pairs.
These are mechanical and control checks, not independent strength evidence.

## Closed: insufficient scope and no descriptive error benefit

All **24 boards / 96 actual games** and their **96 diagnostic-disabled controls** completed legally,
with identical complete root/action/native-ownership/event/result/ranked-record traces. The combined
diagnostic execution supplied **9,724 real-root restoration checks**, with no rejected or censored game.
However, twelve games never produced a position under the fixed eligibility rule: **84 of 96 positions**
were queried. The registered coverage requirement failed. The frozen verifier and primary analyzer
stopped at that assertion; neither was weakened or rewritten.

A separate scope-disposition audit verified every source/tool receipt, reserved seed family, complete
trajectory pair and all available per-replicate losses. Across all 84 queried positions, mean squared
action-difference error was **0.06798335 for stock R2** and **0.07253144 for integer R2**, a descriptive
ratio of **1.06690012**: **6.69% worse**. This available-position comparison is not the admitted primary
board estimate. No primary confidence interval, strength gain or speed gain is claimed. The systematic
absence of twelve eligible positions is retained rather than dropped or filled with extra games.

Ordinary control execution took **99.19 seconds**; diagnostic-enabled execution, including the R256
references and paired R2 queries, took **591.07 seconds** on four local workers. These are study elapsed
times on a contended host, not a comparative job-speed result. The system Python lacks NumPy, so the
unchanged frozen analyzer and separate disposition audit use a dedicated local NumPy environment;
the original assertion failures and execution state are preserved.

**Close this fixed sampler.** The separately reserved 1,008-game strength, 6,000-game qualification,
6,000-game confirmation and latency banks remain completely unopened. No additional games, retuned
eligibility, variant or subgroup can rescue this attempt. The general H64/complementary-R2 default
and actual combat RNG remain unchanged. A separate publication export without the uncommitted repair
or research RNG seam passes **7,205 tests**, TypeScript and lint.
