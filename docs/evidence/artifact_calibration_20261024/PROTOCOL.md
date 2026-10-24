# A20-R: legal Tier-2 artifact calibration — 2026-10-24

Registered before any combat outcome in this study. This is a research identity, not AI version 0.20.
The earlier shield, Hydra and Mage experiments did not qualify. No result or seed from them is reused.

Hypothesis: a Tier-2 table calibrated on current ranked A19 drafts can improve the current v6 artifact-fit
policy, whose new-item mechanic scores and older measured priors have different scales. Change only
the Tier-2 decision on armies with at least two native ranged identities among the five public own picks.
Other armies retain their exact current decision. Tier-1 fit, the draft strength head, later coherence,
funded setup, live synergy variants, tactical splits, combat AI and information boundaries stay current.
Any changed Tier-2 choice naturally influences the subsequent legal level-four pick and setup.

## Frozen source and runtime

Freeze committed common main plus the explicit research decision seam, its tests and this protocol.
Do not copy another agent's uncommitted engine edits. Capture server search/draft/setup defaults and
hash the complete source, runner, protocol, runtime and dependency lock. Both seats use the same current
server A19 search, SEE_NONE doctrine and v4-w16-r4 draft; all unqualified combat experiments remain off.
Use Bun 1.4.4 and fixed work H64/R4, independently of host timing. Reuse playRankedDraftGame and
PersistentWorkerPool. No new cohort runner or report generator is introduced into the shipped package.

Use complete four-game offer-board clusters: both candidate draft assignments, each on both physical
sides at the same combat seed. Normal, Lava and Block receive equal board counts. Win = 1, draw = 0.5,
loss = 0. Confidence and sign flips operate on independent whole boards, not individual games.

## Calibration and fixed fitting rule

- Smoke: 3 boards, seed 2026102459, all three legal offered choices (36 fights). Verify candidate-only
  choice, legal public five-pick inputs, unchanged opponent policy and cross-host trajectory parity.
- A/A: 24 boards / 96 fights, seed 2026102449, identity callback. Require exactly 50%, zero rejections,
  and the same mirrored trajectories. Omitted/identity callback parity also has exact draft tests.
- Training: 150 boards, seed 2026102450. For each board, evaluate all three offered indices on each
  candidate draft assignment and physical mirror: 1,800 fights. The callback acts at the actual Tier-2
  phase; never force a post-draft artifact or expose the final level-four pick to the choice.
- For each draft assignment average its two physical-side outcomes for each of the three choices.
  Keep only the predeclared >=2-ranged cohort, using its five identities at the decision. Fit all three
  pairwise score differences against artifact one-hot differences with ridge least squares:
  sum((x_a beta - x_b beta - (score_a - score_b))^2) + 8 sum(beta^2).
  All live Tier-2 artifact coefficients share this one fixed penalty; there are no feature searches,
  map-specific weights, tuning grids, clipping or manually preferred items. Centered coefficients give
  table scores 50 + 100 beta. Ties choose the smaller artifact ID. Require at least 12 observed scenarios
  for every live artifact in every training fold, otherwise stop for insufficient calibration coverage.
- Five-fold cross-fitting splits whole boards by board ID modulo 5. Fit four folds and select the offered
  item on the held-out fold; compare its recorded counterfactual outcome with the current policy's offered
  choice. Outside the ranged cohort use the current choice. Average the four differences within each board.
  Advance only if the out-of-fold gain is >=1.0 percentage point, its 97.5% whole-board bootstrap lower
  bound is >0, and all training fights have zero rejections. Otherwise stop, without tuning another rule
  on these outcomes. Cross-fit gain is a selection diagnostic, not the shipped policy's win rate.
- If eligible, refit this exact model on all 150 boards, freeze the resulting table and its hash, then
  discard training outcomes for promotion inference. The registered unchanged rule resolves the table
  only through an explicit research callback. Do not mutate the current production table.

## Fresh strength gates

- Screen: 300 new boards / 1,200 games, seed 2026102451, learned policy vs current v6. Require the
  two-sided 98.75% whole-cluster bootstrap lower bound >50%, exact two-sided sign-flip p <=0.0125,
  and zero rejected actions on either seat. Report all maps and outcomes, no interim score inspection.
- Confirmation only after a passing screen: 2,016 new boards / 8,064 games, seed 2026102452. Require
  the same interval/p/rejection gates, >=51% point score, and no map below 49%. Never pool training,
  screen and confirmation to pass. No retuning or selected subgroup can rescue a failed gate.
- Bootstrap: 20,000 whole-board resamples, random seed 19625140. Training quantiles 0.0125/0.9875;
  deciding stages 0.00625/0.99375. Exact sign flips retain every nonzero cluster difference from parity.
- After confirmation, validate the actual public server selector, common/client/server quality gates,
  current engine applicability, and 120 production-budget latency games, seed 2026102453. No increase
  in deadline-fallback rate >1 percentage point. A default change or deploy requires those gates too.

No optional stopping. Preserve all attempted, failed and incomplete runs outside Git. Hosts may execute
fixed disjoint board ranges; their complete union must cover every registered board ID once, with matching
source, profile, protocol and runner hashes. Local concurrency 12; 9800X3D concurrency 8, nice 10. Do not
touch live services. Generated sources, records and analyses stay outside Git under the client tmp tree.
