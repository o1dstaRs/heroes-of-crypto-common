# Nightmare wall movement comparison coverage

`nightmare-wall-movement-coverage-v1` is a distinct offline candidate following the
[failed route-preservation study](nightmare_route_selection_corrected_research.md). It preserves the
immutable original ground-wall proposal and adds one omitted native movement comparison. It does not
change the default, accepted A19 models, draft, setup or Premium routing.

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

The candidate is registered; full admission, fresh collection, repetitions and independent verification
are pending. Inspect the capsule's status and terminal receipts before reporting progress or starting
other work. No strength gain or serving change is claimed.
