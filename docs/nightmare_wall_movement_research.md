# Nightmare wall movement comparison coverage

`nightmare-wall-movement-coverage-v1` is a distinct offline candidate following the
[failed route-preservation study](nightmare_route_selection_corrected_research.md). It preserves the
immutable original ground-wall proposal and adds one omitted native movement comparison. It does not
change the default, accepted A19 models, draft, setup or Premium routing.

The complete study observed **+0.520833 score points versus default** and **+0.231481 versus original
v1**, but both simultaneous confidence intervals cross zero and the five-point doctrine regressed.
Quality and coverage passed; development qualification failed. Preserve the positive estimates and
the failed gates together. No confirmation or serving change followed.

## Mechanism and fixed policy

A coverage-only audit of all previous completed observer records found **481 roots** with the original
ground-wall proposal. All 481 had an existing native pure move, but **261 retained no pure move** for
H64/R2. Several Empower targets and the ordinary wall can occupy the shortlist; immediate movement
leaves can rank below them. Examples were selected in case order, without consulting game outcomes.
This establishes missing comparisons, not a strength improvement.

The new helper `src/simulation/nightmare_wall_movement_research.ts` applies only to candidate-team
Nightmare roots where the unchanged original wall proposal exists. It preserves all native alternatives
and then that wall, in the same order and with the same object identities. If this complete original-v1
set contains no pure move, it appends the highest finite native leaf-scored pure move from the existing
catalog. Equal leaf scores use catalog order. Missing/misaligned leaf evidence, an already retained move
or no finite own pure move leaves v1 unchanged. The helper generates no path, consumes no RNG, modifies
no forecast and forces no action. Native full search, material arbitration and final neural correction
remain responsible for the decision. The maximum extra cost over original v1 is one H64/R2 comparison
at eligible roots; ordinary game-wide cost remains to be measured.

This is not a relaxed threshold or favorable slice of the failed route guard. That closed policy and
all its gates remain unchanged. Current-route pressure, allied-route vetoes and productive-action score
margins are not part of this separate coverage hypothesis. Movement that already survived is not
rescored or preferred on ties. The two previously observed movement-versus-wall regressions therefore
remain diagnostics, not cases this rule is designed to force into wins.

## Source and validation

Registration SHA-256: `819fa13d6e88006994abcca5c31ca400a0d5bac9c339e00eddc57c167e64b09a`.
The capsule is `game/core/tmp/nightmare-wall-movement-20261117` relative to the client root.
Its exact source archives are common `5052817d` and server `ae63b150`, plus the separately hashed inactive
helper and tests. Peer working-tree edits are excluded. The original ground-wall helper retains SHA
`83d590e8ad804382bf649891c8114a29e3ea5db2da937b8492f476ea5dffd85c`.

All **535 tests / 4,365 assertions**, targeted TypeScript and ESLint checks pass. The five new tests cover
real candidate enumeration, comparison/identity preservation, stable finite-evidence selection, actor
and root eligibility, no changes to an already retained move, RNG purity and serving isolation. Four
separate old-case preflight executions reproduce exact default/original-v1 traces, exact off/observer
behavior and unchanged original full-score prefixes while adding a move. They are not fresh strength.
Both hosts must verify all 5,437 frozen runtime files, 141 registered inputs, Bun 1.4.4 and identical
common RNG functions and FightStateManager constructors through both server and simulation imports.

The subsequent full common suite passed **8,151 tests / 3,902,037 assertions** across 693 files. The full
TypeScript build initially encountered a peer's in-progress barrel-research type error; it passed after
that peer fixed its own file, as did the package's JSON/generated-file copy steps. The receipts preserve
both attempts. Whole-source formatting was not run over peers' work.

## Prospective evidence

The four arms are default off, observation only, original v1 and v1 plus movement coverage (`move`).
Admission uses the first previously opened omitted-movement case for every map/own-doctrine/seat
combination (18 cases), plus the first six no-omission cases. All 24 cases run all four arms; six fixed
cases repeat in cold processes. Admission requires complete quality, at least three new movement
comparisons across two maps and at least one selected appended move. Failure stops before fresh games.

The fresh population contains **216 legal Nightmare-preference draft families**: four per map, own
doctrine, opponent doctrine and pick-order stratum. The three maps are normal/lava/mountain; both sides
cover 5/6/7 points. The first four eligible rosters per pick order are selected from 96 fixed attempts per
map/doctrine pair, before any battles. Each arm independently rebuilds legal draft and ranked setup,
including funded upgrades, artifacts, support splits and placement. Two seats and two combat futures
give **864 paired comparisons / 3,456 fresh executions**. This population is conditional on the stated
Nightmare preference, not an unconditional live win rate.

Another 36 fixed fresh cases run all four arms as cold repetitions, evenly split between hosts and
covering each map/own-doctrine combination and both seats. Total registered executions are
**96 admission + 24 admission cold + 3,456 fresh + 144 fresh cold = 3,720**. The four preflight executions
are separate. All off/observer traces, cold traces, old default/v1 controls, actual chosen actions,
state/RNG restoration, original score prefixes, input hashes and health/event ledgers must verify.

Scores are win 1, draw 0.5, loss 0, averaging the four paired differences within each family. The two
primary comparisons are **move versus default** and **move versus original v1**. A fixed 20,000-draw
whole-family bootstrap (Python Random 73117720) uses simultaneous 95% Bonferroni percentile intervals.
An independent implementation reconstructs raw scores, integer family totals and exact empirical
bootstrap endpoints. Original v1 versus default is a diagnostic replication, not an alternate finalist.

The fixed development gates require all quality checks, at least ten changed trajectories against v1
across two maps, at least three selected appended moves across two maps, positive means and positive
simultaneous lower bounds for both primary comparisons, and nonnegative means in every own doctrine
for both comparisons. No additional half-point minimum is imposed. A development pass permits a
separately registered independent confirmation and serial serving-cost verification within +10%; it
does not automatically activate a default. A failure closes this candidate and bank.

Namespace `nightmare-wall-movement-20261117-fresh-v1` scans counters 1–20,480 using SHA-256's first four
bytes as little-endian seeds. Every scanned preimage reserves all 32 raw channels and their canonical
`permuteRankedDraftSeed` equivalents, including rejected and unused scans: **1,310,515 distinct channels**.
The 169-ledger exclusion check and independent canonical reconstruction passed. Preserve the complete
preimage ledger in the [evidence fixture](evidence/nightmare_wall_movement_20261117.json); generic
recursive integer collection alone does not expand it.

## Resource limit and status

The sealed allocation uses **six local M4 Max and twelve Puffalo CPU workers**, all nice 19, no GPU.
Puffalo was idle at preparation. Each host owns two of the four families in every stratum; all arms and
repeats of a family stay on the same host. The minimum free-space floor is 2 GiB per host. The hard cutoff
is **2026-11-17 18:30:31 UTC**, with no automatic retry or extension. Other jobs remain untouched.

All stages completed at **2026-11-17 16:38:52 UTC**, before the original cutoff. Both source seals remained
exact. All 888 off/observer pairs, 168 cold replays, 48 old default/v1 control comparisons and 2,098
original full-score comparisons passed. No game was dropped, replaced or retried. Independent raw-score,
integer-family and exact empirical bootstrap reconstruction agreed with the failed development decision.
The independent exact bootstrap endpoints differ slightly from the registered finite Monte Carlo
endpoints within their frozen tolerance bands; neither implementation has a positive lower bound.

The concurrently registered barrel choice-diversity study recorded this exact registration in its
exclusions. Its 1,728 expanded actual-case channels have zero intersection with this study's complete
1,310,515-channel reservation. This later read-only audit did not change either allocation or any outcome.

## Completed score comparison

The **216 independent families / 864 paired outcomes** produce the following complete-bank results.
Observers and repeated executions do not increase that independent sample size.

| Comparison                             | Difference, points | Registered interval, points              | Better / worse / same pairs |
| -------------------------------------- | -----------------: | ---------------------------------------- | --------------------------- |
| Movement versus default                |          +0.520833 | −1.157407 to +2.256944, simultaneous 95% | 18 / 13 / 833               |
| Movement versus original v1            |          +0.231481 | −0.694444 to +1.388889, simultaneous 95% | 7 / 5 / 852                 |
| Original v1 versus default, diagnostic |          +0.289352 | −0.752315 to +1.273148, ordinary 95%     | 11 / 8 / 845                |

Average match score was 22.685185% for default, 22.974537% for original v1 and 23.206019% for movement
coverage. These absolute scores describe the deliberately Nightmare-preferring draft population, not
the unconditional default AI or an isolated creature-balance test. Against default, 17 losses became
wins, one loss became a draw and 13 wins became losses. Against original v1, seven losses became wins
and five wins became losses.

| Fixed group               | Families | Movement − default, points | Movement − v1, points |
| ------------------------- | -------: | -------------------------: | --------------------: |
| Normal map                |       72 |                  +1.041667 |              0.000000 |
| Lava map                  |       72 |                  +0.868056 |             +1.041667 |
| Mountain map              |       72 |                  −0.347222 |             −0.347222 |
| Own 6-point doctrine      |       72 |                  +3.472222 |             +0.694444 |
| Own 5-point doctrine      |       72 |                  −1.909722 |             −0.347222 |
| Own 7-point doctrine      |       72 |                   0.000000 |             +0.347222 |
| Opponent 6-point doctrine |       72 |                  +1.041667 |             +1.041667 |
| Opponent 5-point doctrine |       72 |                  +1.736111 |             +0.694444 |
| Opponent 7-point doctrine |       72 |                  −1.215278 |             −1.041667 |

The complete quality, trajectory coverage, selected-move coverage and positive point-estimate gates
passed. Positive simultaneous lower bounds and nonnegative own-doctrine means failed. These descriptive
groups cannot replace the overall decision or justify a doctrine-specific deployment on this bank.

## Complete decision audit

Movement coverage added **293 comparisons** and the added move was actually selected **69 times**.
It changed 69 trajectories against original v1 and 152 against default. At the first divergence from v1,
66 cases chose a pure move, one chose a wall and two chose existing melee alternatives. The latter three
kept the same game result: expanding a comparison set can also change which existing action the final
selector takes. The descriptive review initially asserted that every first change was a pure move;
the corrected review preserves these three cases and its original failed assertion separately. This
does not change primary verification, any game record or the policy.

The displaced v1 choices were 59 walls, six Empower casts and four melee attacks. All twelve changed
outcomes first selected a pure move. Five improvements and three regressions followed a strictly higher
full-search mean; two improvements and two regressions followed ties. A blanket tie rejection would
therefore not address every regression, and these descriptive counts do not qualify such a rule.

| Case                   | v1 → movement result | First discarded action | Mean: discarded → move | Descriptive observation                                                                |
| ---------------------- | -------------------- | ---------------------- | ---------------------- | -------------------------------------------------------------------------------------- |
| `fresh-s01-f005-s1-f1` | Loss → win           | Attack Fairy           | 0.5 → 1                | Moved elsewhere; subsequent enemy Blacksmith burns totaled 174 HP.                     |
| `fresh-s02-f003-s1-f0` | Win → loss           | Attack Hyena           | 0 → 0.5                | Moved to the same destination but omitted the attack; neither game had a burn.         |
| `fresh-s04-f003-s1-f0` | Loss → win           | Wall                   | 1 → 1                  | Neither game had a burn.                                                               |
| `fresh-s07-f010-s0-f0` | Win → loss           | Wall                   | 0.5 → 0.5              | V1 dealt 5 enemy burn HP; movement dealt none.                                         |
| `fresh-s09-f004-s0-f0` | Loss → win           | Wall                   | 0 → 1                  | Neither game had a burn.                                                               |
| `fresh-s09-f004-s0-f1` | Loss → win           | Wall                   | 0 → 0.5                | V1 later burned its Nightmare for 48 HP; movement had no burns.                        |
| `fresh-s09-f004-s1-f0` | Loss → win           | Wall                   | 0 → 0.989114           | Neither game had a burn.                                                               |
| `fresh-s12-f009-s0-f0` | Win → loss           | Wall                   | 0.5 → 1                | V1 burned enemy Wolf Rider for 224 HP and allied Wyvern for 33; movement had no burns. |
| `fresh-s15-f000-s1-f0` | Loss → win           | Wall                   | 0.108872 → 0.499957    | V1 dealt 88 allied burn HP; movement later dealt 32 enemy burn HP.                     |
| `fresh-s20-f007-s1-f0` | Win → loss           | Wall                   | 0 → 0                  | V1 dealt 345 enemy burn HP; movement had no burns.                                     |
| `fresh-s23-f007-s1-f0` | Win → loss           | Wall                   | 0 → 1                  | Neither game had a burn.                                                               |
| `fresh-s25-f004-s0-f1` | Loss → win           | Wall                   | 0.5 → 0.5              | Neither game had a burn.                                                               |

These are complete-game associations after the first different action, including subsequent decisions
and chance, not isolated causal values of one burn or square. All twelve comparisons and all 31 changed
outcomes against default are preserved in the evidence fixture and standalone HTML review.

The seven gains over v1 came from only five families, while its five regressions came from five other
families. One family, `fresh-s09-f004`, supplied three of the gains. Omitting that family would change
the mean to −0.116279 points over the remaining 215 families. This is a sensitivity diagnostic only;
the primary result retains every family, and its whole-family bootstrap already reflects clustering.

Actual own walls fell from 614 under v1 to 565 with movement coverage. Enemy burn HP fell from 61,155 to
57,211 and allied burn HP from 13,004 to 12,184. Default had 584 walls, 53,064 enemy burn HP and 12,802
allied burn HP. No opponent wall was cast in this population. These totals cannot substitute for score.

A post-registration, outcome-independent audit of the previous observer bank found finite movement
evidence at all 261 previously omitted-movement roots: 209 had just one pure move and 52 had multiple
moves with a unique highest leaf score. The existing value features include advancement, enemy distance,
formation spread and center distance. This was a comparison-coverage hypothesis, not random movement.

## Continuation boundary

Preserve this candidate, registration, all scanned channels and complete evidence as an inactive
positive-estimate research reference. It failed the original development gate; no confirmation, serial
serving-cost qualification, model fit or default activation followed. Do not rescue it by dropping the
five-point doctrine, removing the losing family or adjusting a threshold on this opened bank.

The next distinct investigation should examine how future wall and movement choices are valued,
including the attack or useful wall sacrificed. The existing neural wall-state/orientation omission
remains a separate proven representation gap, while full engine forecasts already simulate fire. Any
new wall-aware model needs an explicit input contract, new fits, fresh outcomes and serving-cost
qualification. The current traces do not by themselves distinguish chance, native-continuation
mismatch and learned evaluation as the cause of a failed forecast. Preserve the accepted A19 pair and
the adopted barrel correction while testing that question.
