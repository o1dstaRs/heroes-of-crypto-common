# Preregistration — refit a19's search leaf on today's fights (P18)

Written 2026-09-24 ~18:00Z, before any value row has been read (the rows are being written by P17's data games,
PREREGISTRATION_FIDELITY_REFIT.md, amendment 17:49Z).

## Why
a19 scores every candidate by rollouts cut at 64 unit-turns and read by a learned leaf, `V07_VALUE_WEIGHTS_V2` —
the Phase-B multi-cohort V2XS fit of 2026-07-11: v0.7-era mirror cohorts, the classic board, no casters-as-damage,
no splits, the default synergy variants. Games today last ~6 laps (P15 BASE: 6.2), so a decision in laps 1-4 is
decided by the leaf, not by a terminal result. The armies, board, mechanics and the playing policy have all moved
since the leaf was fitted; its earlier refit was worth +2.4pp in the ranged cohort (v0.7 Phase-B).

## Data (fixed)
Every real turn of P17's 8000 data fights (both seats, a19 deep budget, v4-w16-r4 drafts at 50% exploration,
live synergy variants + split pass, side board): the acting seat's raw V2 features, labelled by whether it won.

## Fit (fixed; scripts/fit_leaf.py)
Logistic regression over the deployed 60-dim V2 basis (raw 30 + rangedness copy), ridge-shrunk toward the production
weights (the intercept free), lambda chosen from {0.3, 1, 3, 10, 30, 100, 300, 1000} by 5-fold cross-validation
grouped by battle seed (a board's two mirrored fights never straddle folds). The refit goes forward only if its
cross-validated log-loss beats the production leaf's log-loss on the same rows by at least 0.002; otherwise P18 stops.

## Selection (seed 99490001, 4000 games)
Candidate = the live stack (v4-w16-r4, `conditional-v1:sniper+t2a19`, SEE_NONE) with the refit leaf on its own
search only (`--candidate-search-env {"V07_VALUE_WEIGHTS_V2": …}`); opponent = the live stack with the production
leaf; live draft rules, side board, deterministic a19, live synergy variants + split pass. Continue only at
draw-aware >= 51.5%.

## Confirmation and robustness (the eight gates of verdict.py)
8000 games, seed 99600001; robustness vs pool `reference`, 2000 games per opponent, seed 99590001, candidate and the
production leaf alike. PASS -> the refit becomes V08_A19's `V07_VALUE_WEIGHTS_V2` (profile re-pinned, source ledger
and fingerprints updated), rollback = the previous weights.

Seeds are never re-rolled; every result is reported.

Prediction, written down so it can be wrong: the refit improves CV log-loss by 0.005-0.02; selection lands at
51-53%.

Seed spacing (checked when written): a run of N games uses the 3·N/4 seed preimages after its base seed, so each base
seed here sits clear of every other run's range (P17's data occupies 99450001-99462000).

## Amendment 2026-09-24 ~19:08Z, before any robustness game of P15, P17 or P18 — one shared robustness seed
All three proposals' robustness cells use seed 99480001 (2000 games per `reference` opponent, fidelity options on), so
the incumbent's cell (the live stack vs pool `reference`) is played once and read by every verdict; each candidate
still plays its own cell on that seed. The seeds 99580001 (P15) and 99590001 (P18) are released unused.

## RESULT — fit (2026-09-24 20:23Z, all 16 P17 data shards, before any P18 game)
416,017 turn rows from 3,997 boards (7,994 fights), base rate 0.538. The production leaf scores log-loss 0.4636
(accuracy 75.1%) on these rows; the refit's 5-fold grouped cross-validated log-loss is **0.3708** (accuracy 81.9%) at
lambda 0.3 (the smallest on the grid — the data pulls far from the production weights). Improvement 0.093 >> the
0.002 bar → P18 proceeds to selection. Calibration by decile, predicted/actual: production 0.26/0.33, 0.38/0.44,
0.71/0.65, 0.85/0.81; refit within 0.01 in every decile. Weights: results/P18/leaf_refit.json.
Selection launched 20:21Z (tree common 5722eb5 = b58791e + the v6 registration; the candidate's refit leaf enters
through `--candidate-search-env-file`, which since b58791e routes the override seat through the promoted A19
driver — before that fix the seam silently changed nothing, see the P15 notes). 3 shards on the shared node, 5 on
hft after P17's selection shards. The shared node's paused robustness cell (seed 99480001) restarts afterwards.

## RESULT — selection (2026-09-24 22:08Z; seed 99490001, 4000 games, refit leaf on the candidate's search only)
2005W 1931L 64D, draw-aware **50.92%**, board-clustered 95% [50.11, 51.74], 0 rejections; maps NORMAL 50.9 / LAVA
51.0 / BLOCK 50.9. The refit plays a little better than the production leaf — the interval clears 50 because both
seats draft identically, so a board's four games cancel the armies and leave the fight — but +0.9pp is below the
preregistered 51.5% bar → P18 STOPS; no confirmation. Reading: a leaf that predicts today's outcomes far better
(log-loss 0.371 vs 0.464, calibration within a point in every decile) buys about one point of play; the search's
choices hinge on the leaf's differences between sibling positions, which a better absolute fit barely moves. The
prediction (log-loss gain 0.005-0.02, selection 51-53%) underestimated the fit and overestimated the play.
Gentler refits (lambda 30, 300) are screened in P20 (PREREGISTRATION_FIGHT_SCREEN.md).
